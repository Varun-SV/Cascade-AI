import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ProviderConfig, WhyReport } from '../lib/types.js';
import { getMessages, selectBranch as apiSelectBranch, deleteMessage as apiDeleteMessage, fetchFeedback } from '../lib/api.js';
import { estimateConversationTokens, contextWindowFor } from '../lib/tokens.js';
import {
  localModelEnabled, fastAnswerModel, tierParams, extendedContext, shareLearning,
  maxTokensPerRun, maxCostPerRunUsd, rememberSessions, defaultRoutingBias, defaultWebSearch,
} from '../lib/prefs.js';
import { refreshPendingMedia } from '../lib/pendingMedia.js';
import { promptTooLargeError, payloadTooLargeError } from '../lib/limits.js';
import { detectLocalModelCapability } from '../lib/localModel/capability.js';
import { warmLocalModel } from '../lib/localModel/engine.js';
import { classifyLocalComplexity } from '../lib/localModel/classifier.js';

export interface ChatAttachment {
  id: string;
  mime: string;
  /** 'image' (default) or 'document'. Drives how the chip renders. */
  kind?: 'image' | 'document';
  /** Original filename — shown on document chips. */
  filename?: string | null;
  /** Extracted-text length for documents (for a "· 12k chars" hint). */
  charCount?: number | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  attachments?: ChatAttachment[];
  costUsd?: number | null;
  tier?: string | null;
  model?: string | null;
  why?: WhyReport | null;
  cancelled?: boolean;
  /** Branching: the message this replies to (null = a root turn). */
  parentId?: string | null;
  /** Branching: ids of this message + its siblings, oldest first (for < n/m >). */
  siblingIds?: string[];
  /** Thumbs verdict already cast on this reply, when the user has rated it. */
  verdict?: 'good' | 'bad';
}

/** Map a server message (active-path row) into the client's ChatMessage shape. */
export function toChatMessage(m: {
  id: string; role: string; content: string; parentId?: string | null; siblingIds?: string[];
  costUsd?: number | null; tier?: string | null; model?: string | null; why?: string | null;
  attachments?: Array<{ id: string; mime: string }>;
}): ChatMessage {
  let why: WhyReport | null = null;
  if (m.why) { try { why = JSON.parse(m.why) as WhyReport; } catch { why = null; } }
  return {
    id: m.id,
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
    parentId: m.parentId ?? null,
    siblingIds: m.siblingIds,
    costUsd: m.costUsd,
    tier: m.tier,
    model: m.model,
    why,
    attachments: m.attachments?.map((a) => ({ id: a.id, mime: a.mime })),
  };
}

export interface SendInput {
  prompt: string;
  attachments?: ChatAttachment[];
  /** "Fast answer": one mid-tier model, no orchestration. */
  fast?: boolean;
}

export type RoutingMode = 'auto' | 'quality' | 'fast';
export type ForceTier = 'auto' | 'T1' | 'T2' | 'T3';

interface ChatRunAck {
  conversationId?: string;
  output?: string;
  costUsd?: number;
  totalTokens?: number;
  tier?: string | null;
  model?: string | null;
  savedUsd?: number;
  savedPct?: number;
  cancelled?: boolean;
  error?: string;
}

// Turns a tier event into a specific, human "what's happening now" line. Cascade
// streams tier:status as it moves T1 → T2 → T3, carrying the tier's role, the
// serving model, a label (subtask/section title) and sometimes a currentAction.
// We prefer the most specific signal available so the chip reflects the REAL
// work ("Working: Parse the CSV…") rather than a fixed "Executing…".
function statusLabel(e: Record<string, unknown>): string {
  const role = String(e['role'] ?? e['tierId'] ?? e['tier'] ?? e['id'] ?? '').toUpperCase();
  const label = typeof e['label'] === 'string' ? (e['label'] as string).trim() : '';
  const action = typeof e['currentAction'] === 'string' ? (e['currentAction'] as string).trim() : '';

  // Blocked work is finished, not in progress, so it must not get a trailing
  // "…" or a "Working" verb. It also carries the only thing worth saying about
  // it: which upstream failure stopped it.
  if (String(e['status'] ?? '').toUpperCase() === 'BLOCKED') {
    const causes = Array.isArray(e['blockedBy'])
      ? (e['blockedBy'] as unknown[]).filter((c): c is string => typeof c === 'string' && !!c.trim())
      : [];
    const what = label ? `Skipped ${label}` : 'Skipped';
    return causes.length ? `${what} — blocked by ${causes.join(', ')}` : `${what} — blocked upstream`;
  }

  if (action) return `${action}…`;
  if (role.startsWith('T1')) return 'Mapping the approach…';
  if (role.startsWith('T2')) return label ? `Cascading: ${label}…` : 'Cascading — delegating to specialists…';
  if (role.startsWith('T3')) return label ? `Working: ${label}…` : 'Working…';
  return 'Working…';
}

/** One node of the live run activity — a tier and what it's doing right now. */
export interface ActivityNode {
  tierId: string;
  role: string;            // 'T1' | 'T2' | 'T3'
  label?: string;          // subtask / section title
  model?: string;          // provider:model serving this tier
  status: string;          // ACTIVE | COMPLETED | BLOCKED | …
  currentAction?: string;
  progressPct?: number;
  /** Titles of the upstream work that stopped this one. BLOCKED nodes only. */
  blockedBy?: string[];
  /**
   * Graph identity — the planner's section/subtask id, a DIFFERENT id space
   * from `tierId`. `dependsOn` names nodeIds, so a graph view must key on this
   * one; a live-tier view keys on tierId.
   */
  nodeId?: string;
  dependsOn?: string[];
  /** Execution wave. Nodes sharing one ran at the same time. */
  waveId?: number;
  order: number;           // arrival order, for stable display
}

/** Merge a tier:status event into the running activity list (latest state per tier). */
function mergeActivity(prev: ActivityNode[], e: Record<string, unknown>): ActivityNode[] {
  const tierId = String(e['tierId'] ?? e['id'] ?? e['role'] ?? '');
  if (!tierId) return prev;
  const i = prev.findIndex((n) => n.tierId === tierId);
  const cur = i >= 0 ? prev[i]! : undefined;
  const str = (k: string) => (typeof e[k] === 'string' && (e[k] as string).trim() ? (e[k] as string).trim() : undefined);
  const node: ActivityNode = {
    tierId,
    role: String(e['role'] ?? cur?.role ?? '').toUpperCase(),
    label: str('label') ?? cur?.label,
    model: str('model') ?? cur?.model,
    status: str('status') ?? cur?.status ?? 'ACTIVE',
    currentAction: str('currentAction') ?? cur?.currentAction,
    progressPct: typeof e['progressPct'] === 'number' ? (e['progressPct'] as number) : cur?.progressPct,
    blockedBy: Array.isArray(e['blockedBy'])
      ? (e['blockedBy'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : cur?.blockedBy,
    nodeId: str('nodeId') ?? cur?.nodeId,
    dependsOn: Array.isArray(e['dependsOn'])
      ? (e['dependsOn'] as unknown[]).filter((d): d is string => typeof d === 'string')
      : cur?.dependsOn,
    waveId: typeof e['waveId'] === 'number' ? (e['waveId'] as number) : cur?.waveId,
    order: cur?.order ?? prev.length,
  };
  if (i >= 0) { const copy = [...prev]; copy[i] = node; return copy; }
  return [...prev, node];
}

export interface WebSearchPayload {
  searxngUrl?: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
}

/** Extended context: the SDK detected an oversized input and is asking whether
 *  to spend the extra calls to chunk + compact it. Drives a one-tap confirm. */
export interface ContextApprovalInfo {
  inputTokens?: number;
  windowTokens?: number;
  multiplier?: number;
  estChunks?: number;
}

/** A boardroom plan Cascade produced for this run — surfaced read-only (the
 *  hosted run auto-proceeds; this just shows what it decided to do). */
/**
 * A section that could not decide something on its own, and is asking.
 *
 * Unlike the plan-approval notice (which the server auto-approves and shows for
 * information), this one is BLOCKING: the run is parked until an answer arrives
 * or `timeoutMs` elapses, at which point the section fails. So the UI has to
 * actually let the user answer, not merely inform them.
 */
export interface EscalationRequest {
  conversationId: string;
  taskId: string;
  /** Identifies WHICH parked section this answer belongs to — a Complex run
   *  dispatches sections concurrently, so more than one can be waiting. */
  requestId?: string;
  sectionId: string;
  sectionTitle: string;
  issues: string[];
  summary: string;
  timeoutMs: number;
  /** Client clock at arrival. The deadline is anchored here rather than to the
   *  modal's mount so an unrelated re-render cannot restart the countdown. */
  receivedAt: number;
}

/**
 * Identity of a parked escalation. `requestId` when the server supplies it;
 * `sectionId` is the fallback for an older server that predates the id.
 */
function escalationKey(e: { requestId?: string; sectionId?: string }): string {
  return e.requestId ?? `section:${e.sectionId ?? ''}`;
}

export interface PlanApproval {
  taskId?: string;
  summary?: string;
  t2Count?: number;
  t3Count?: number;
  estCostUsd?: number;
  plan?: {
    complexity?: string;
    reasoning?: string;
    sections?: Array<{ title?: string; description?: string; t3Subtasks?: unknown[] }>;
  };
}

export function useChatSession(
  socket: Socket | null,
  providers: ProviderConfig[],
  skillId: string,
  webSearchConfig?: WebSearchPayload,
  initialConversationId?: string,
) {
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  // Read inside socket handlers, which are registered once per connection and
  // would otherwise close over whatever `busy` was at subscribe time.
  const busyRef = useRef(false);
  busyRef.current = busy;
  // Set when the server reports a run still running for a connection that is
  // no longer the one which emitted it — the ack is gone, so `session:complete`
  // becomes the ending. Cleared by whichever ending arrives first.
  const ackLostRef = useRef(false);
  // The socket handlers are registered once per connection, so reading
  // `conversationId` from their closure pins whatever it was at subscribe time
  // — which on a first turn is `undefined` for the whole run.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastTokens, setLastTokens] = useState<number>(0);
  const [lastSaved, setLastSaved] = useState<{ usd: number; pct: number } | null>(null);
  // Per-run routing controls (sticky across sends in a session). routingMode
  // biases Cascade Auto; forceTier pins the root tier; webSearch toggles the
  // hosted web_search/web_fetch tools. Defaults mirror prior behaviour.
  // Seed the per-session routing bias + web toggle from the user's saved
  // defaults (Settings → Chat); they stay sticky across sends within the session.
  const [routingMode, setRoutingMode] = useState<RoutingMode>(() => defaultRoutingBias());
  const [forceTier, setForceTier] = useState<ForceTier>('auto');
  // The boardroom plan for the in-flight run, if Cascade produced one. Shown
  // read-only; cleared when the next run starts or the current one settles.
  const [approval, setApproval] = useState<PlanApproval | null>(null);
  // A QUEUE, not one slot. The SDK keys parked escalations by requestId
  // precisely because a Complex wave dispatches sections concurrently, so two
  // can be waiting at once — storing one here threw the first away, and
  // answering the visible prompt left the hidden section parked until timeout.
  const [escalations, setEscalations] = useState<EscalationRequest[]>([]);
  const escalation = escalations[0] ?? null;
  // Extended context: a pending "process this huge input?" confirm, and a
  // transient notice once a compaction actually happened.
  const [contextApproval, setContextApproval] = useState<ContextApprovalInfo | null>(null);
  const [compactionNotice, setCompactionNotice] = useState<string | null>(null);
  // Document RAG: a transient note when a large attached doc was searched for
  // the most relevant passages (vs. read in full), so grounding is visible.
  const [knowledgeNotice, setKnowledgeNotice] = useState<string | null>(null);
  // Live run activity — the T1→T2→T3 tree with each tier's model + current
  // subtask, built from tier:status events. Powers the click-to-expand drawer.
  const [activity, setActivity] = useState<ActivityNode[]>([]);
  // Default OFF: a hosted chat is pure conversation unless the user opts into
  // web tools. With the toggle off the run registers no tools at all, so the
  // model is never handed a capability it can't reliably use.
  const [webSearch, setWebSearch] = useState(() => defaultWebSearch());
  const streamingRef = useRef('');
  // run:why arrives just before the chat:run ack; stash it so the ack can
  // attach the full report to the assistant message it creates.
  const pendingWhyRef = useRef<WhyReport | null>(null);

  useEffect(() => {
    setConversationId(initialConversationId);
  }, [initialConversationId]);

  // If the user opted into the on-device model, warm it in the background so it
  // can classify complexity (and title chats) without a first-use stall. The
  // engine is shared with the titler — this is a no-op if it's already loading.
  useEffect(() => {
    if (!localModelEnabled() || !detectLocalModelCapability().supported) return;
    const idle = (cb: () => void) =>
      typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 1500);
    idle(() => warmLocalModel());
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onToken = (e: { text: string; primary?: boolean }) => {
      // Only stream the PRESENTER tier's output (the actual answer). Intermediate
      // nodes — planning, decomposition, background workers — emit primary:false;
      // showing those made each node's output flash by before the final result,
      // which read as a runaway. Keep the status chip up while they work.
      if (e.primary === false) return;
      streamingRef.current += e.text;
      setStatus(null); // presenter tokens are flowing — drop the "planning" chip
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.streaming) {
          return [...prev.slice(0, -1), { ...last, content: streamingRef.current }];
        }
        return [...prev, { id: 'streaming', role: 'assistant', content: streamingRef.current, streaming: true }];
      });
    };
    const onStatus = (e: Record<string, unknown>) => {
      setStatus(statusLabel(e));
      setActivity((prev) => mergeActivity(prev, e));
    };
    const onWhy = (r: WhyReport) => { pendingWhyRef.current = r; };
    const onPlan = (e: PlanApproval) => setApproval(e);
    const onEscalation = (e: EscalationRequest) => setEscalations((prev) => {
      const incoming = { ...e, receivedAt: Date.now() };
      // Re-delivery of one already queued (a reconnect replay) updates in place
      // rather than showing the same question twice.
      const i = prev.findIndex((x) => escalationKey(x) === escalationKey(incoming));
      if (i < 0) return [...prev, incoming];
      const copy = [...prev];
      copy[i] = incoming;
      return copy;
    });
    // The window closed without an answer — clear the prompt so a stale modal
    // can't be answered into a run that has already moved on.
    // Drop only the section that timed out. Without the id an older request's
    // timeout would clear a NEWER prompt the user is mid-answer on.
    const onEscalationTimeout = (e: { requestId?: string; sectionId?: string }) =>
      setEscalations((prev) => prev.filter((x) => escalationKey(x) !== escalationKey(e)));
    const onContextApproval = (e: ContextApprovalInfo) => setContextApproval(e);
    const onCompacted = (e: { kind?: string; chunks?: number; foldedTurns?: number; truncated?: boolean }) => {
      setContextApproval(null);
      if (e.kind === 'input') {
        setCompactionNotice(`Compacted a large input into ${e.chunks ?? 0} chunks${e.truncated ? ' (truncated at the cap)' : ''}.`);
      } else if (e.kind === 'history') {
        setCompactionNotice(`Folded ${e.foldedTurns ?? 'earlier'} turns into a summary to fit the context window.`);
      }
    };
    const onKnowledge = (e: { mode?: string; docCount?: number; passages?: number; reranked?: boolean }) => {
      if (e.mode === 'searched') {
        const docs = e.docCount === 1 ? 'the document' : `${e.docCount} documents`;
        const verb = e.reranked ? 'reranked to the' : 'pulled the';
        setKnowledgeNotice(`Searched ${docs} and ${verb} ${e.passages ?? 0} most relevant passages.`);
      } else if (e.mode === 'nokey') {
        setKnowledgeNotice('These documents are very large. The full text was still included — to retrieve just the most relevant parts of files this big, add an embeddings-capable key (OpenAI, an OpenAI-compatible endpoint, or a local Ollama).');
      }
    };
    // Deliberately does NOT clear the escalation prompt any more.
    //
    // It used to, and that was right when a dropped socket aborted the run
    // outright: the gate settled as 'skip' server-side and the modal was
    // answering into something already dead. The server now holds the run
    // across the gap and re-points its `escalation:decide` listener at the
    // replacement socket, so the question is still live and still answerable —
    // discarding it here would throw away a gate the run is genuinely waiting
    // on, and the run would then sit until its own timeout. The case that
    // clearing protected against is covered by `run:resumed` reporting no
    // active run: that is the signal the run really is over.
    const onDisconnect = () => {};
    // A run produced a file. `pending: true` means generated media the user
    // has not kept — refresh the unsaved list so its expiry badge and Save
    // button appear on the message as soon as the image lands. A saved file
    // needs nothing here (the Files panel has its own refresh).
    const onFileCreated = (e: { pending?: boolean }) => { if (e?.pending) void refreshPendingMedia(); };
    socket.on('stream:token', onToken);
    socket.on('tier:status', onStatus);
    socket.on('run:why', onWhy);
    socket.on('plan:approval-required', onPlan);
    socket.on('escalation:decision-required', onEscalation);
    socket.on('escalation:timeout', onEscalationTimeout);
    socket.on('disconnect', onDisconnect);
    socket.on('context:approval-required', onContextApproval);
    socket.on('context:compacted', onCompacted);
    socket.on('knowledge:retrieved', onKnowledge);
    socket.on('file:created', onFileCreated);
    return () => {
      socket.off('stream:token', onToken);
      socket.off('tier:status', onStatus);
      socket.off('run:why', onWhy);
      socket.off('plan:approval-required', onPlan);
      socket.off('escalation:decision-required', onEscalation);
      socket.off('escalation:timeout', onEscalationTimeout);
      socket.off('disconnect', onDisconnect);
      socket.off('context:approval-required', onContextApproval);
      socket.off('context:compacted', onCompacted);
      socket.off('knowledge:retrieved', onKnowledge);
      socket.off('file:created', onFileCreated);
    };
  }, [socket]);

  const loadMessages = useCallback((loaded: ChatMessage[]) => {
    setMessages(loaded);
    setError(null);
    setStatus(null);
  }, []);

  // Re-fetch the conversation's active path from the server (the authoritative
  // tree). Used after any run or branch operation so the transcript, message
  // ids, and per-message sibling counts (< n/m >) always match the server.
  const reloadActivePath = useCallback(async (cid: string) => {
    try {
      // Verdicts ride along with the transcript so a rated reply still shows
      // its thumb after a reload. Fetched together, but failing independently:
      // a feedback hiccup must not cost the user their messages.
      const [{ messages: rows }, fb] = await Promise.all([
        getMessages(cid),
        fetchFeedback(cid).catch(() => ({ feedback: {} as Record<string, 'good' | 'bad'> })),
      ]);
      setMessages(rows.map((r) => {
        const m = toChatMessage(r);
        const v = fb.feedback[m.id];
        return v ? { ...m, verdict: v } : m;
      }));
    } catch { /* keep the optimistic transcript on a transient fetch error */ }
  }, []);

  /**
   * Terminal cleanup for a run whose ack can never arrive.
   *
   * `onAck` is the normal ending and does this plus the token/cost bookkeeping
   * it alone receives. But the ack is bound to the connection that emitted
   * `chat:run`: once that socket is gone the callback is unreachable, so a run
   * interrupted by a reconnect needs a second way to end or the composer stays
   * disabled forever with no error and no reply.
   */
  const finishWithoutAck = useCallback((cid?: string) => {
    ackLostRef.current = false;
    setBusy(false);
    setStatus(null);
    setApproval(null);
    setContextApproval(null);
    setEscalations([]);
    // The streaming bubble is stitched from tokens that stopped arriving; the
    // persisted answer replaces it.
    setMessages((prev) => prev.filter((m) => !m.streaming));
    // Adopt the id as well as the transcript. On a first turn the client has
    // NO conversation id — the server creates it and the client learns it from
    // the ack, which is the one thing a reconnect is guaranteed to lose. Ending
    // the wait without it clears the spinner over an empty chat while the
    // answer sits on a conversation the page cannot name.
    const target = cid ?? conversationIdRef.current;
    if (!target) return;
    conversationIdRef.current = target;
    setConversationId(target);
    void reloadActivePath(target);
  }, [reloadActivePath]);

  // A reconnect re-reads the transcript, and settles what the lost ack cannot.
  //
  // The server holds a run whose socket dropped rather than aborting it (see
  // cloud/server/src/socket.ts RECONNECT_GRACE_MS), which splits the reconnect
  // into two cases the client cannot tell apart on its own:
  //
  //   • the run FINISHED during the gap — its events and its ack went to the
  //     dead socket, but the assistant message was persisted before any of
  //     them were emitted, so the answer is on the conversation. Reloading
  //     surfaces it; `busy` has to be cleared here because nothing else will.
  //   • the run is STILL GOING — it has been re-pointed at this socket, so the
  //     remaining tokens and the terminal `session:complete` do arrive. The
  //     ack still will not, so completion has to come off that event instead.
  //
  // `run:resumed` is the server answering which one it is. Reloading on
  // connect alone left the second case busy forever, which is the same
  // symptom, one connection later.
  useEffect(() => {
    if (!socket) return;
    const onConnect = () => {
      const cid = conversationIdRef.current;
      if (cid) void reloadActivePath(cid);
    };
    const onResumed = (e: { active?: number; finished?: Array<string | undefined> }) => {
      if (!busyRef.current) return;
      if (e?.active) { ackLostRef.current = true; return; }
      // Nothing is running. The terminal event was emitted while no socket was
      // bound, so `finished` is the only remaining carrier of the id for a run
      // that was a brand-new chat.
      finishWithoutAck(e?.finished?.find((id): id is string => !!id) ?? conversationIdRef.current);
    };
    // Both endings take their id from the PAYLOAD, not from React state: on a
    // first turn that state is still undefined, and these events carry the id
    // the lost ack was going to deliver.
    //
    // Only meaningful once the ack is known lost. In the ordinary path
    // `session:complete` precedes the ack on the same socket, and finalising
    // here would end the run a beat early — before the reply bubble the ack
    // carries.
    const onComplete = (e: { conversationId?: string }) => {
      if (ackLostRef.current) finishWithoutAck(e?.conversationId);
    };
    // An inherited run can fail rather than finish. `runChatTurn` emits this
    // and then throws, and the throw only reaches the original `chat:run` ack —
    // the very callback this path knows is gone. Without handling it here a
    // failed run left the composer disabled forever and said nothing about why.
    const onError = (e: { conversationId?: string; error?: string }) => {
      if (!ackLostRef.current) return;
      setError(e?.error ?? 'The run failed after the connection dropped.');
      finishWithoutAck(e?.conversationId);
    };
    socket.on('connect', onConnect);
    socket.on('run:resumed', onResumed);
    socket.on('session:complete', onComplete);
    socket.on('session:error', onError);
    return () => {
      socket.off('connect', onConnect);
      socket.off('run:resumed', onResumed);
      socket.off('session:complete', onComplete);
      socket.off('session:error', onError);
    };
  }, [socket, reloadActivePath, finishWithoutAck]);

  // Shared run path for a fresh send, an edit (new branch), and a regenerate.
  // `appendUser` is false when regenerating (no new user turn is created). The
  // `branch` params tell the server where to attach the new turn in the tree.
  const runChat = useCallback(
    (
      prompt: string,
      attachments: ChatAttachment[] | undefined,
      appendUser: boolean,
      fast = false,
      branch?: { editOfMessageId?: string; regenerateFromUserMessageId?: string },
    ) => {
      const text = prompt.trim();
      if (!socket || busy || !text) return;
      // The transcript as it stood BEFORE any optimistic mutation. `messages`
      // is captured from the render this callback was built in, and the
      // callers that mutate (editMessage, regenerate) call setMessages and
      // then this function in the same handler — so React has not re-rendered
      // and this is still the pre-mutation array. Kept explicitly rather than
      // relied on implicitly, because it is what restores the view if the send
      // is refused below.
      const transcriptBeforeSend = messages;
      // Checked BEFORE anything is emitted or optimistically rendered. Past
      // the socket.io frame ceiling the server never acks — the transport
      // drops the frame before a handler sees it — so without this the send
      // spins forever with no error. Saying so here is the only place it can
      // be said. See lib/limits.ts.
      const tooLarge = promptTooLargeError(text);
      if (tooLarge) { setError(tooLarge); return; }
      setBusy(true);
      setError(null);
      setStatus('Sizing up the task…');
      setApproval(null);
      setContextApproval(null);
      setCompactionNotice(null);
      setKnowledgeNotice(null);
      setActivity([]);
      streamingRef.current = '';
      // Id kept so the rejection path below can take this turn back out. It is
      // optimistic — nothing has been sent yet — and a send that never happens
      // must not leave a bubble behind that vanishes on the next refresh.
      const optimisticUserId = crypto.randomUUID();
      if (appendUser) {
        setMessages((prev) => [...prev, { id: optimisticUserId, role: 'user', content: text, attachments }]);
      }

      const emitRun = (complexityHint?: 'Simple' | 'Moderate' | 'Complex') => {
        const payload = {
            conversationId,
            prompt: text,
            providers,
            attachmentIds: attachments?.map((a) => a.id),
            skillId,
            routingMode,
            forceTier,
            webSearch,
            webSearchConfig,
            complexityHint,
            fastAnswer: fast || undefined,
            fastAnswerModel: fast ? (fastAnswerModel() || undefined) : undefined,
            // Advanced per-tier generation params (omitted when none are set,
            // and moot for a fast answer, which is a single direct call).
            tierParams: fast ? undefined : (() => { const tp = tierParams(); return Object.keys(tp).length ? tp : undefined; })(),
            // Extended context: only sent when enabled and not a fast answer.
            extendedContext: fast ? undefined : (() => { const e = extendedContext(); return e.enabled ? e : undefined; })(),
            // Contribute to shared learning (Pro can opt out; server gates by plan).
            shareLearning: shareLearning(),
            // Hard per-run token ceiling (0 = server/SDK default).
            maxTokensPerRun: maxTokensPerRun() || undefined,
            // Hard per-run cost cap in USD (0 = server default safety rail).
            maxCostPerRunUsd: maxCostPerRunUsd() || undefined,
            // Opt-in: distill this chat into persistent memories after the run.
            rememberSession: rememberSessions() || undefined,
            // Branching: fork from an edited turn, or regenerate a reply as a
            // sibling. Omitted for a normal send (append at the active leaf).
            editOfMessageId: branch?.editOfMessageId,
            regenerateFromUserMessageId: branch?.regenerateFromUserMessageId,
        };
        // The authoritative size check, on what actually goes on the wire.
        // socket.io JSON-encodes the payload and encoding is not
        // length-preserving — a prompt of backslashes or quotes nearly doubles
        // — so the byte check on the raw text above cannot bound the frame by
        // itself. Past the ceiling the frame is dropped with no ack at all, so
        // this has to be caught here or not at all.
        const tooBig = payloadTooLargeError(payload);
        if (tooBig) {
          setBusy(false);
          setStatus(null);
          setError(tooBig);
          // Put the transcript back exactly as it was. Nothing was emitted or
          // persisted, so the pre-send array is authoritative and restoring it
          // covers every caller in one step: a fresh send loses the optimistic
          // user turn, and an edit or regenerate — which truncate before
          // calling this — get their hidden reply and later turns back.
          //
          // Restored LOCALLY rather than re-fetched. Recovery went through
          // reloadActivePath, whose getMessages call swallows its own failure
          // by design, so a network blip left the conversation looking
          // permanently shortened for an operation that never happened. A
          // value already in memory cannot fail to arrive.
          setMessages(transcriptBeforeSend);
          return;
        }
        socket.emit('chat:run', payload, onAck);
      };

      const onAck = (ack: ChatRunAck) => {
          // The ack did arrive, so the reconnect fallback must not fire later.
          ackLostRef.current = false;
          setBusy(false);
          setStatus(null);
          setApproval(null);
          setContextApproval(null);
          // The run is over, so any parked question is stale — its buttons
          // would emit into a run that has already finished. Chat.stop() is the
          // case that made this visible (the server aborts the controller
          // WITHOUT disconnecting, the SDK settles the gate as 'skip', and the
          // run acknowledges normally), but the same is true of every ending:
          // clearing here covers stop, completion and error in one place,
          // exactly as the approval prompts above already do.
          setEscalations([]);
          if (ack.error) {
            setError(ack.error);
            setMessages((prev) => prev.filter((m) => !m.streaming));
            return;
          }
          if (typeof ack.totalTokens === 'number') setLastTokens(ack.totalTokens);
          if (typeof ack.savedUsd === 'number' && ack.savedUsd > 0) {
            setLastSaved({ usd: ack.savedUsd, pct: ack.savedPct ?? 0 });
          }
          setConversationId(ack.conversationId);
          const why = pendingWhyRef.current;
          pendingWhyRef.current = null;
          setMessages((prev) => {
            const withoutStreaming = prev.filter((m) => !m.streaming);
            return [
              ...withoutStreaming,
              {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: ack.output ?? '',
                costUsd: ack.costUsd ?? null,
                tier: ack.tier ?? null,
                model: ack.model ?? null,
                why,
                cancelled: ack.cancelled ?? false,
              },
            ];
          });
          // Reconcile with the server tree so message ids, parents, and sibling
          // counts are authoritative (a < n/m > navigator appears after an edit
          // or regenerate). The optimistic bubble above avoids any flash.
          if (ack.conversationId) void reloadActivePath(ack.conversationId);
      };

      // Classify complexity on-device first when the opt-in model is enabled,
      // supported, and warm — the server then skips its own classifier LLM call
      // and starts from this verdict (still applying its heuristic floors and
      // escalation as guardrails). Anything short of a confident local verdict
      // falls straight through to a normal send, so this never blocks or
      // degrades the run. A pinned tier (forceTier) makes the hint moot, so skip.
      // A fast answer is a single direct call — no need to classify complexity.
      if (!fast && forceTier === 'auto' && localModelEnabled() && detectLocalModelCapability().supported) {
        // Give the tiny on-device model the last assistant turn as context —
        // a terse follow-up like "3" is meaningless in a vacuum, and a
        // context-free verdict routed one-character replies into full builds.
        const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
        void classifyLocalComplexity(text, lastAssistant?.content)
          .then((hint) => emitRun(hint ?? undefined))
          .catch(() => emitRun());
      } else {
        emitRun();
      }
    },
    [socket, busy, conversationId, providers, skillId, routingMode, forceTier, webSearch, webSearchConfig, messages, reloadActivePath],
  );

  const send = useCallback((input: SendInput) => runChat(input.prompt, input.attachments, true, input.fast), [runChat]);

  // Ask the server to abort the in-flight run. The run still resolves (with
  // whatever completed), so the normal ack path finalises the message; we just
  // reflect "stopping" until it lands.
  const stop = useCallback(() => {
    if (!socket || !busy) return;
    socket.emit('chat:stop');
    setStatus('Stopping…');
  }, [socket, busy]);

  /**
   * Answer a section that escalated.
   *
   *   retry    — run the section again unchanged (the worker may have hit a
   *              transient problem).
   *   guidance — run it again with an instruction it must follow.
   *   skip     — accept whatever the section did produce and move on.
   *
   * Cleared optimistically: the run is parked waiting on this, so leaving the
   * modal up after answering would invite a second answer that has nowhere to go.
   */
  /**
   * Drop the prompt WITHOUT answering. For the local deadline: the server has
   * already failed the section, so sending 'skip' would report an action that
   * never happened and queue a decision with nowhere to land. Distinct from
   * dismissing deliberately, which IS an answer (see resolveEscalation).
   */
  const clearEscalation = useCallback(() => setEscalations((prev) => prev.slice(1)), []);

  const resolveEscalation = useCallback(
    (action: 'retry' | 'skip' | 'guidance', note?: string) => {
      if (!socket || !escalation) return;
      socket.emit('escalation:decide', {
        conversationId: escalation.conversationId,
        ...(escalation.requestId ? { requestId: escalation.requestId } : {}),
        action,
        ...(note ? { note } : {}),
      });
      setEscalations((prev) => prev.slice(1));
      setStatus(action === 'skip' ? 'Skipping section…' : 'Retrying section…');
    },
    [socket, escalation],
  );

  // Answer the extended-context confirm: proceed with (or skip) compacting the
  // oversized input. Either way the run continues — skip just means the model
  // handles the raw input (truncating naturally).
  const resolveContextApproval = useCallback((approved: boolean) => {
    socket?.emit('context:decision', { approved });
    setContextApproval(null);
  }, [socket]);

  // Regenerate a reply as a NEW sibling of the given assistant turn (or the last
  // one). The original answer stays on disk under < n/m >.
  const regenerate = useCallback((assistantId?: string) => {
    if (busy) return;
    const assistant = assistantId
      ? messages.find((m) => m.id === assistantId && m.role === 'assistant')
      : [...messages].reverse().find((m) => m.role === 'assistant');
    if (!assistant) return;
    const userMsg = assistant.parentId
      ? messages.find((m) => m.id === assistant.parentId)
      : [...messages].reverse().find((m) => m.role === 'user');
    if (!userMsg) return;
    // Size-checked BEFORE the optimistic truncation, exactly as editMessage is.
    // The turn being re-run was accepted by whichever door it came in — a
    // conversation created through /v1/chat/completions can hold a prompt above
    // this client's limit and under that route's own 4 MB one — so runChat can
    // legitimately refuse it here. Refusing after the slice would hide the
    // existing reply and every later turn until a manual refresh.
    const tooLarge = promptTooLargeError(userMsg.content);
    if (tooLarge) { setError(tooLarge); return; }
    // Optimistic: show the path up to & including the user turn, then stream.
    const idx = messages.findIndex((m) => m.id === userMsg.id);
    setMessages(messages.slice(0, idx + 1));
    runChat(userMsg.content, userMsg.attachments, false, false, { regenerateFromUserMessageId: userMsg.id });
  }, [busy, messages, runChat]);

  // Edit a user turn: fork a new branch (a sibling of the edited turn) and
  // re-run, so the original prompt + its answer survive under < n/m >.
  const editMessage = useCallback((messageId: string, newText: string) => {
    if (busy || !newText.trim()) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    const target = messages[idx];
    if (!target || target.role !== 'user') return;
    // Size-checked BEFORE the optimistic truncation below, not after. runChat
    // rejects an oversized message by returning early — which, once this has
    // already dropped the edited turn and everything after it, would leave the
    // transcript permanently shortened for a send that never happened and was
    // never persisted, with no reload to restore it.
    const tooLarge = promptTooLargeError(newText.trim());
    if (tooLarge) { setError(tooLarge); return; }
    // Optimistic: keep everything BEFORE the edited turn, then add the new one.
    setMessages(messages.slice(0, idx));
    runChat(newText, target.attachments, true, false, { editOfMessageId: target.id });
  }, [busy, messages, runChat]);

  // Delete a message and its entire subtree. The server relocates the active
  // path and returns it; an unsaved optimistic message just drops locally.
  const deleteMessageById = useCallback(async (messageId: string) => {
    if (!conversationId) {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      return;
    }
    try {
      const { messages: rows } = await apiDeleteMessage(conversationId, messageId);
      setMessages(rows.map(toChatMessage));
    } catch { /* leave the transcript as-is on failure */ }
  }, [conversationId]);

  // Switch the active path to a sibling branch (the < n/m > arrows).
  const selectSibling = useCallback(async (messageId: string) => {
    if (!conversationId || busy) return;
    try {
      const { messages: rows } = await apiSelectBranch(conversationId, messageId);
      setMessages(rows.map(toChatMessage));
    } catch { /* keep the current path on failure */ }
  }, [conversationId, busy]);

  // Context meter inputs, derived from the LOADED conversation (not the last
  // run's throughput) so they're accurate and survive a page refresh. The
  // window comes from the most recent assistant model that actually served this
  // chat, defaulting conservatively when unknown.
  const contextTokens = useMemo(() => estimateConversationTokens(messages), [messages]);
  const contextWindow = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'assistant' && messages[i]!.model) return contextWindowFor(messages[i]!.model);
    }
    return contextWindowFor(undefined);
  }, [messages]);

  return {
    messages, send, stop, regenerate, editMessage, deleteMessage: deleteMessageById, selectSibling,
    busy, error, status, lastTokens, lastSaved, conversationId, loadMessages, setConversationId,
    contextTokens, contextWindow,
    routingMode, setRoutingMode, forceTier, setForceTier, webSearch, setWebSearch, approval,
    escalation, escalationQueued: escalations.length, resolveEscalation, clearEscalation,
    contextApproval, resolveContextApproval, compactionNotice, knowledgeNotice, activity,
  };
}
