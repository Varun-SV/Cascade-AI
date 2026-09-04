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

/** One gap a review pass found. Mirrors core/tiers/review.ts across the wire. */
export interface ReviewGapSummary {
  title: string;
  detail?: string;
  sections?: string[];
}

/** A review verdict as it arrives from a tier status event. */
export interface ReviewSummary {
  summary?: string;
  gaps: ReviewGapSummary[];
}

/**
 * Read a review verdict off a tier event.
 *
 * Everything here crosses a socket from a server that may be running a
 * different build, so each field is checked rather than cast — a malformed
 * verdict renders nothing instead of throwing inside the transcript.
 */
function parseReview(raw: unknown): ReviewSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const gapsRaw = Array.isArray(obj['gaps']) ? obj['gaps'] : [];
  const gaps = gapsRaw.flatMap((g): ReviewGapSummary[] => {
    if (!g || typeof g !== 'object') return [];
    const gap = g as Record<string, unknown>;
    const title = typeof gap['title'] === 'string' ? gap['title'].trim() : '';
    if (!title) return [];
    const detail = typeof gap['detail'] === 'string' ? gap['detail'].trim() : '';
    const sections = Array.isArray(gap['sections'])
      ? gap['sections'].filter((x): x is string => typeof x === 'string' && !!x.trim())
      : [];
    return [{ title, ...(detail ? { detail } : {}), ...(sections.length ? { sections } : {}) }];
  });
  // No gaps means the pass approved — an explicit clear, not a missing field.
  if (gaps.length === 0) return undefined;
  const summary = typeof obj['summary'] === 'string' ? obj['summary'].trim() : '';
  return { gaps, ...(summary ? { summary } : {}) };
}

/** One node of the live run activity — a tier and what it's doing right now. */
export interface ActivityNode {
  tierId: string;
  role: string;            // 'T1' | 'T2' | 'T3'
  label?: string;          // subtask / section title
  model?: string;          // provider:model serving this tier
  status: string;          // ACTIVE | COMPLETED | BLOCKED | …
  currentAction?: string;
  /** Set only on a review update — the gaps that stopped the run passing. */
  review?: ReviewSummary;
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
    // Present-but-approved clears the card; absent carries the last one
    // forward, since a review arrives on one event and the run keeps ticking.
    review: 'review' in e ? parseReview(e['review']) : cur?.review,
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

/**
 * A dangerous tool asking permission, from the run to the person watching.
 *
 * The server has waited on this since the approval gate went in; nothing on
 * the client listened, so every request sat until the SDK's timeout and was
 * denied. A capability that is gated on an answer nobody can give is not gated,
 * it is broken — and it silently changed the behaviour of every other dangerous
 * cloud tool from "denied at once" to "denied in ten minutes".
 */
export interface ToolApproval {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  isDangerous?: boolean;
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
  /**
   * The server's id for a run this pane started before it had one.
   *
   * A first turn sends `chat:run` with no conversationId; the server creates
   * one and stamps every event for that run with it, but this side does not
   * learn it until the closing ack. In between, this pane cannot name its own
   * conversation — which is why the gates below used to accept anything while
   * `conversationId` was undefined, and why per-conversation state had nothing
   * to key on.
   *
   * A ref, not state, deliberately: the pane is still showing "new chat" and
   * adopting the id into `conversationId` would move the sidebar selection and
   * re-run everything keyed on it mid-stream. This is routing only.
   */
  const pendingConversationIdRef = useRef<string | undefined>(undefined);
  /**
   * This pane started a run before it had a conversation id, and is still
   * waiting to be told which one the server made.
   *
   * Adoption is gated on it. Without the gate any late event could name this
   * pane's conversation: press New Chat while a run is going and the run you
   * walked away from re-adopts itself into the blank pane, bringing its browser
   * panel and its dangerous-tool prompts with it.
   */
  const awaitingFirstTurnRef = useRef(false);
  /** The conversation this pane's events belong to — known, or adopted below. */
  const activeConversationId = (): string | undefined =>
    conversationIdRef.current ?? pendingConversationIdRef.current;
  /** Learn the id the server minted for the run this pane just started. */
  const adoptConversationId = (convo: unknown): void => {
    if (!awaitingFirstTurnRef.current) return;
    if (conversationIdRef.current || pendingConversationIdRef.current) return;
    if (typeof convo === 'string' && convo) pendingConversationIdRef.current = convo;
  };
  /**
   * Where the agent's browser can be watched, while it has one — per
   * conversation.
   *
   * Keyed rather than held in one slot. One socket carries several
   * conversations, so a single slot meant the run you switched AWAY from wrote
   * its live-view URL into the pane you switched TO, and its Stop button
   * stopped a run you were no longer watching. Keying also keeps the kill
   * switch reachable: come back to the first chat and its panel is still there,
   * still naming its own task.
   *
   * State only, never persisted. The URL is a bearer capability: the provider
   * issues it without a token precisely so it can be embedded, which means
   * anyone who obtains it can watch the session and drive it. Storing it with
   * the conversation would turn a live credential into a durable one — and an
   * entry is DELETED, not blanked, the moment its run gives the browser up, so
   * a spent capability is not kept around.
   */
  const [browserViews, setBrowserViews] = useState<
    Record<string, { taskId?: string; liveViewUrl?: string }>
  >({});
  const browserView = browserViews[activeConversationId() ?? ''];
  /** Where the agent's browser can be watched, for the conversation on screen. */
  const browserLiveView = browserView?.liveViewUrl;
  /** A browser is attached to this run, whether or not it can be streamed. */
  const browserActive = browserView !== undefined;
  /**
   * The run that owns the browser.
   *
   * Stop names this rather than the conversation: one chat can hold several
   * runs, and a conversation-scoped Stop halted all of them.
   */
  const browserTaskId = browserView?.taskId;
  // Read by stopBrowser, which is declared before this value and must not close
  // over a stale one when the run changes under it.
  const browserTaskIdRef = useRef<string | undefined>(undefined);
  browserTaskIdRef.current = browserTaskId;

  /**
   * Stop the agent using the browser, without stopping the run.
   *
   * Deliberately not `stop()`: the user may want the work to continue and only
   * this capability withdrawn. The panel is hidden immediately rather than
   * waiting for the server to confirm — a kill switch that looks like it did
   * nothing is one people press repeatedly and then distrust.
   */
  /**
   * Answer one pending request.
   *
   * Removed from the queue immediately rather than on a server acknowledgement:
   * the run is blocked waiting, and a prompt that stays on screen after you
   * answer it invites a second, contradictory answer.
   */
  const resolveToolApproval = useCallback((requestId: string, approved: boolean, always = false) => {
    setToolApprovals((q) => {
      const answered = q.find((a) => a.requestId === requestId);
      // Nothing queued under that id — a double click, or a prompt already
      // pruned by its run ending. Emitting anyway would name a conversation
      // this pane merely happens to be showing.
      if (!answered) return q;
      socket?.emit('permission:decide', {
        // The conversation the REQUEST came from, not the one on screen. The
        // pane's own id is undefined in a blank New Chat, and the server's
        // decision handler only rejects a conversation id that is present and
        // wrong — so an absent one resolved by request id alone, letting a
        // decision made in one chat settle a dangerous call in another.
        conversationId: answered.conversationId,
        requestId,
        approved,
        always,
      });
      return q.filter((a) => a.requestId !== requestId);
    });
  }, [socket]);

  const stopBrowser = useCallback(() => {
    // The task id, which the server requires to match exactly. Without it the
    // Stop is ignored — which is the correct failure: better a button that does
    // nothing than one that stops somebody else's run.
    if (!browserTaskIdRef.current) return;
    socket?.emit('browser:stop', { taskId: browserTaskIdRef.current });
    // This conversation's panel only. Another chat's browser is not something
    // this button withdraws.
    const key = activeConversationId() ?? '';
    setBrowserViews(({ [key]: _gone, ...rest }) => rest);
  }, [socket]);
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
  /**
   * Pending tool approvals, oldest first.
   *
   * A queue rather than one slot: a run can have several workers asking at
   * once, and holding only the newest would strand the others until timeout.
   */
  const [allToolApprovals, setToolApprovals] = useState<Array<ToolApproval & { conversationId?: string }>>([]);
  /**
   * The ones belonging to the conversation on screen.
   *
   * Filtered on read rather than dropped on arrival, so switching chats does
   * not strand a run: the question is still queued and re-appears when you come
   * back to it. Dropping instead would leave the server's approval callback
   * parked until its own timeout denied it — ten minutes of a run doing
   * nothing, with no way for the user to unblock it.
   */
  const currentConversation = activeConversationId();
  /**
   * An EXACT origin match. An unknown id is not a wildcard.
   *
   * The first version read "show it when either side is unknown", which made a
   * blank pane match everything: `App.newChat()` sets the conversation to
   * undefined, so conversation A's pending `browser_control` prompt appeared in
   * the new empty chat and could be approved by someone who was no longer
   * looking at the run asking. That is precisely the consent scoping this is
   * for, so undefined now matches only undefined — and adoption above is what
   * gives a genuine first turn a real id to match on.
   */
  const toolApprovals = allToolApprovals.filter((a) => a.conversationId === currentConversation);

  /**
   * Open a different conversation in this pane.
   *
   * Wraps the raw setter so the adopted id is dropped: it names the run this
   * pane started while it had no id of its own, and once the user has moved to
   * another chat it would otherwise keep routing that run's browser panel and
   * approvals into whatever is on screen.
   *
   * The keyed state itself is deliberately NOT cleared — a run left behind is
   * still running, and its Stop button has to be there when the user comes
   * back to it.
   */
  const selectConversation = useCallback((id: string | undefined) => {
    pendingConversationIdRef.current = undefined;
    // Whatever this pane was waiting to be told, it is not waiting for it here
    // any more. Leaving the window open let a run the user navigated away from
    // adopt the pane they navigated to.
    awaitingFirstTurnRef.current = false;
    conversationIdRef.current = id;
    setConversationId(id);
  }, []);

  /**
   * A run is over, so nothing is still waiting on its questions.
   *
   * The server resolves every remaining approval callback `false` and clears
   * its map in the run's `finally`, and sends nothing to say so. Without a
   * matching removal here a prompt survives its own run — it reappears when
   * the user comes back to that conversation, and clicking it answers a waiter
   * that no longer exists, which reads as a control that silently does nothing.
   *
   * Approvals only. The browser panel has its own authoritative ending in
   * `browser:live-view` with `active: false`, which is scoped to the task
   * rather than the conversation and so is the more precise of the two.
   */
  const settleConversation = useCallback((cid?: string) => {
    if (!cid) return;
    setToolApprovals((q) => (q.some((a) => a.conversationId === cid)
      ? q.filter((a) => a.conversationId !== cid)
      : q));
  }, []);
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
  /**
   * A provider's account went out of service mid-run and the work moved
   * elsewhere. Hosted users need this MORE than CLI users, not less: nobody is
   * watching a terminal, and the run quietly keeps spending on another account.
   */
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
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
    pendingConversationIdRef.current = undefined;
    awaitingFirstTurnRef.current = false;
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
      // One socket can carry several conversations, so a background run's
      // tiers would otherwise post their status — and now a whole review
      // rejection — into whichever chat happens to be open.
      //
      // Only filter once this chat KNOWS its id. On the first turn of a new
      // conversation the server tags events with an id it just created, while
      // this side does not learn that id until the run's closing ack — so
      // comparing against `undefined` discards the entire first run, which is
      // the most common case there is.
      //
      // The exhaustion handler below deliberately does NOT do this, and its
      // test says why: a stray billing warning in the wrong chat is worse than
      // a missed one. Losing every tier event is not a comparable trade, so
      // the two differ on purpose. Adopting the server's id from the first
      // event would fix both properly and is a larger change than this.
      const convo = e['conversationId'];
      const current = conversationIdRef.current;
      if (current && typeof convo === 'string' && convo !== current) return;
      setStatus(statusLabel(e));
      setActivity((prev) => mergeActivity(prev, e));
    };
    const onWhy = (r: WhyReport) => { pendingWhyRef.current = r; };
    const onPlan = (e: PlanApproval) => setApproval(e);
    const onPermissionRequired = (e: ToolApproval & { conversationId?: string; id?: string }) => {
      // Queued for whichever conversation it belongs to, not filtered here.
      //
      // A filter that compared against `conversationIdRef.current` dropped the
      // whole first turn of a new chat: the server creates the conversation
      // before the run and tags the gate with that real id, while this side
      // does not learn it until the closing ack — so the comparison was
      // `new-server-id !== undefined` and the approval was discarded. The
      // prompt never rendered, nobody answered, and the tool sat until its own
      // timeout denied it. Adopting the id fixes that; keeping every request
      // and filtering on read fixes the other half, where switching chats
      // stranded a question the run was still blocked on.
      adoptConversationId(e?.conversationId);
      // The SDK calls it `id`; keep one name on this side.
      const requestId = e.requestId ?? e.id;
      if (!requestId) return;
      setToolApprovals((q) => (q.some((a) => a.requestId === requestId) ? q : [...q, { ...e, requestId }]));
    };
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
    const onProviderExhausted = (e: {
      conversationId?: string; provider?: string; kind?: string; message?: string; failedOverTo?: string;
    }) => {
      // One socket can carry several conversations on plans that allow
      // concurrent runs, so an exhaustion in a background conversation would
      // otherwise post an account-switch and billing warning into whichever
      // chat happens to be open.
      if (e.conversationId && e.conversationId !== conversationIdRef.current) return;
      const who = e.provider ?? 'A provider';
      setProviderNotice(e.failedOverTo
        ? `${who} is out for this run — ${e.message ?? ''} Continuing on ${e.failedOverTo}; the rest of this run is billed to that account.`
        : `${who} is out for this run — ${e.message ?? ''}`);
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
    // The agent has a browser and the user can watch it. Held in state only —
    // this URL is a bearer capability (anyone with it can watch and drive the
    // session), so it is never persisted with the conversation and never
    // written to a log. An absent url means the run finished with it, or the
    // provider offers no live view at all.
    const onLiveView = (e: { conversationId?: string; taskId?: string; liveViewUrl?: string; active?: boolean }) => {
      // Recorded AGAINST its conversation rather than into one shared slot. One
      // socket carries several runs, and a single slot meant switching chats
      // left another run's bearer-capability URL rendered in the pane you moved
      // to, while a late `undefined` from the run you left cleared the view of
      // the one you were on.
      adoptConversationId(e?.conversationId);
      const key = typeof e?.conversationId === 'string' ? e.conversationId : (activeConversationId() ?? '');
      setBrowserViews((prev) => {
        // `active` says a browser exists even when it cannot be streamed, so
        // Stop survives a provider with no live view. Its absence is the run
        // giving the browser up — drop the entry outright rather than blanking
        // it, so the panel goes away and the spent capability URL is not kept.
        if (e?.active !== true) {
          if (!(key in prev)) return prev;
          const { [key]: _done, ...rest } = prev;
          return rest;
        }
        return { ...prev, [key]: { taskId: e?.taskId, liveViewUrl: e?.liveViewUrl } };
      });
    };
    socket.on('browser:live-view', onLiveView);
    socket.on('stream:token', onToken);
    socket.on('tier:status', onStatus);
    socket.on('run:why', onWhy);
    socket.on('plan:approval-required', onPlan);
    socket.on('permission:user-required', onPermissionRequired);
    socket.on('escalation:decision-required', onEscalation);
    socket.on('escalation:timeout', onEscalationTimeout);
    socket.on('disconnect', onDisconnect);
    socket.on('context:approval-required', onContextApproval);
    socket.on('context:compacted', onCompacted);
    socket.on('provider:exhausted', onProviderExhausted);
    socket.on('knowledge:retrieved', onKnowledge);
    socket.on('file:created', onFileCreated);
    return () => {
      socket.off('stream:token', onToken);
      socket.off('tier:status', onStatus);
      socket.off('run:why', onWhy);
      socket.off('plan:approval-required', onPlan);
      socket.off('permission:user-required', onPermissionRequired);
      socket.off('escalation:decision-required', onEscalation);
      socket.off('escalation:timeout', onEscalationTimeout);
      socket.off('disconnect', onDisconnect);
      socket.off('context:approval-required', onContextApproval);
      socket.off('context:compacted', onCompacted);
      socket.off('provider:exhausted', onProviderExhausted);
      socket.off('knowledge:retrieved', onKnowledge);
      socket.off('file:created', onFileCreated);
      socket.off('browser:live-view', onLiveView);
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
    const target = cid ?? activeConversationId();
    if (!target) return;
    pendingConversationIdRef.current = undefined;
    awaitingFirstTurnRef.current = false;
    conversationIdRef.current = target;
    setConversationId(target);
    settleConversation(target);
    void reloadActivePath(target);
  }, [reloadActivePath, settleConversation]);

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
    const onResumed = (e: { active?: number; finished?: Array<{ conversationId?: string; error?: string }> }) => {
      // A live run is authoritative even on a page that has never seen one.
      //
      // The resume identity deliberately survives a reload, so the server can
      // and does adopt a run for a FRESH mount — where `busy` is just React
      // state initialised to false. Gating on it meant the recovered run was
      // ignored precisely when recovery mattered most: the composer looked
      // idle while the run really was executing, the flag saying the ack is
      // lost was never set, so the eventual completion was discarded too, and
      // the user could start a second run on a socket already carrying one.
      if (e?.active) {
        ackLostRef.current = true;
        setBusy(true);
        return;
      }
      // Nothing running, and nothing waiting on it.
      if (!busyRef.current) return;
      // Nothing is running. The terminal event was emitted while no socket was
      // bound, so this is the only remaining carrier of BOTH the id — for a run
      // that was a brand-new chat — and the outcome. A run can fail during the
      // gap as easily as it can finish, and reporting only the id made the two
      // indistinguishable: the page cleared its spinner, reloaded a transcript
      // with no reply in it, and said nothing about why.
      const outcome = e?.finished?.find((f) => f?.error) ?? e?.finished?.[0];
      if (outcome?.error) setError(outcome.error);
      finishWithoutAck(outcome?.conversationId);
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
      // This run is about to start without a conversation id, so the server
      // will make one and this pane may adopt it from the first event that
      // carries it. Armed only here: adoption is a thing this pane does for a
      // run it started, never something an arriving event can do to it.
      awaitingFirstTurnRef.current = !conversationIdRef.current;
      setBusy(true);
      setError(null);
      setStatus('Sizing up the task…');
      setApproval(null);
      setContextApproval(null);
      setCompactionNotice(null);
      setKnowledgeNotice(null);
      // The banner says "out for THIS run". Verdicts are cleared at the router's
      // run boundary, so carrying it into the next run would keep telling the
      // user their spend is on a different account after it has moved back.
      setProviderNotice(null);
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
          // The id is real now, so the adopted one has done its job.
          pendingConversationIdRef.current = undefined;
          awaitingFirstTurnRef.current = false;
          setConversationId(ack.conversationId);
          // The run is finished; the server has already denied anything still
          // parked on it.
          settleConversation(ack.conversationId);
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
    busy, error, status, lastTokens, lastSaved, conversationId, loadMessages,
    setConversationId: selectConversation,
    contextTokens, contextWindow,
    routingMode, setRoutingMode, forceTier, setForceTier, webSearch, setWebSearch, approval,
    escalation, escalationQueued: escalations.length, resolveEscalation, clearEscalation,
    contextApproval, resolveContextApproval, compactionNotice, providerNotice, knowledgeNotice, activity,
    browserLiveView, browserActive, browserTaskId, stopBrowser,
    toolApprovals, resolveToolApproval,
  };
}
