import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ProviderConfig, WhyReport } from '../lib/types.js';
import { getMessages, selectBranch as apiSelectBranch, deleteMessage as apiDeleteMessage } from '../lib/api.js';
import { estimateConversationTokens, contextWindowFor } from '../lib/tokens.js';
import {
  localModelEnabled, fastAnswerModel, tierParams, extendedContext, shareLearning,
  maxTokensPerRun, maxCostPerRunUsd, rememberSessions, defaultRoutingBias, defaultWebSearch,
} from '../lib/prefs.js';
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
  status: string;          // ACTIVE | COMPLETED | …
  currentAction?: string;
  progressPct?: number;
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
    socket.on('stream:token', onToken);
    socket.on('tier:status', onStatus);
    socket.on('run:why', onWhy);
    socket.on('plan:approval-required', onPlan);
    socket.on('context:approval-required', onContextApproval);
    socket.on('context:compacted', onCompacted);
    socket.on('knowledge:retrieved', onKnowledge);
    return () => {
      socket.off('stream:token', onToken);
      socket.off('tier:status', onStatus);
      socket.off('run:why', onWhy);
      socket.off('plan:approval-required', onPlan);
      socket.off('context:approval-required', onContextApproval);
      socket.off('context:compacted', onCompacted);
      socket.off('knowledge:retrieved', onKnowledge);
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
      const { messages: rows } = await getMessages(cid);
      setMessages(rows.map(toChatMessage));
    } catch { /* keep the optimistic transcript on a transient fetch error */ }
  }, []);

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
      setBusy(true);
      setError(null);
      setStatus('Sizing up the task…');
      setApproval(null);
      setContextApproval(null);
      setCompactionNotice(null);
      setKnowledgeNotice(null);
      setActivity([]);
      streamingRef.current = '';
      if (appendUser) {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: text, attachments }]);
      }

      const emitRun = (complexityHint?: 'Simple' | 'Moderate' | 'Complex') => {
        socket.emit(
          'chat:run',
          {
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
          },
          onAck,
        );
      };

      const onAck = (ack: ChatRunAck) => {
          setBusy(false);
          setStatus(null);
          setApproval(null);
          setContextApproval(null);
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
    contextApproval, resolveContextApproval, compactionNotice, knowledgeNotice, activity,
  };
}
