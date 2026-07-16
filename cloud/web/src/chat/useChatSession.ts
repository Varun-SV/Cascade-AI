import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ProviderConfig, WhyReport } from '../lib/types.js';
import { localModelEnabled, fastAnswerModel, tierParams } from '../lib/prefs.js';
import { detectLocalModelCapability } from '../lib/localModel/capability.js';
import { warmLocalModel } from '../lib/localModel/engine.js';
import { classifyLocalComplexity } from '../lib/localModel/classifier.js';

export interface ChatAttachment {
  id: string;
  mime: string;
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

// Maps a tier event to a human-legible activity label. Cascade streams
// tier:status as it moves T1 → T2 → T3; the exact payload shape varies, so we
// read whatever tier marker is present and fall back to a generic label.
function statusLabel(e: Record<string, unknown>): string {
  const tier = String(e['tierId'] ?? e['tier'] ?? e['id'] ?? '').toUpperCase();
  if (tier.startsWith('T1')) return 'Planning…';
  if (tier.startsWith('T2')) return 'Coordinating…';
  if (tier.startsWith('T3')) return 'Executing…';
  return 'Working…';
}

export interface WebSearchPayload {
  searxngUrl?: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
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
  const [routingMode, setRoutingMode] = useState<RoutingMode>('auto');
  const [forceTier, setForceTier] = useState<ForceTier>('auto');
  // The boardroom plan for the in-flight run, if Cascade produced one. Shown
  // read-only; cleared when the next run starts or the current one settles.
  const [approval, setApproval] = useState<PlanApproval | null>(null);
  // Default OFF: a hosted chat is pure conversation unless the user opts into
  // web tools. With the toggle off the run registers no tools at all, so the
  // model is never handed a capability it can't reliably use.
  const [webSearch, setWebSearch] = useState(false);
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
    const onStatus = (e: Record<string, unknown>) => setStatus(statusLabel(e));
    const onWhy = (r: WhyReport) => { pendingWhyRef.current = r; };
    const onPlan = (e: PlanApproval) => setApproval(e);
    socket.on('stream:token', onToken);
    socket.on('tier:status', onStatus);
    socket.on('run:why', onWhy);
    socket.on('plan:approval-required', onPlan);
    return () => {
      socket.off('stream:token', onToken);
      socket.off('tier:status', onStatus);
      socket.off('run:why', onWhy);
      socket.off('plan:approval-required', onPlan);
    };
  }, [socket]);

  const loadMessages = useCallback((loaded: ChatMessage[]) => {
    setMessages(loaded);
    setError(null);
    setStatus(null);
  }, []);

  // Shared run path for a fresh send and for regenerate. `appendUser` is false
  // when regenerating (the user message already exists in the transcript).
  const runChat = useCallback(
    (prompt: string, attachments: ChatAttachment[] | undefined, appendUser: boolean, fast = false) => {
      const text = prompt.trim();
      if (!socket || busy || !text) return;
      setBusy(true);
      setError(null);
      setStatus('Thinking…');
      setApproval(null);
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
          },
          onAck,
        );
      };

      const onAck = (ack: ChatRunAck) => {
          setBusy(false);
          setStatus(null);
          setApproval(null);
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
      };

      // Classify complexity on-device first when the opt-in model is enabled,
      // supported, and warm — the server then skips its own classifier LLM call
      // and starts from this verdict (still applying its heuristic floors and
      // escalation as guardrails). Anything short of a confident local verdict
      // falls straight through to a normal send, so this never blocks or
      // degrades the run. A pinned tier (forceTier) makes the hint moot, so skip.
      // A fast answer is a single direct call — no need to classify complexity.
      if (!fast && forceTier === 'auto' && localModelEnabled() && detectLocalModelCapability().supported) {
        void classifyLocalComplexity(text).then((hint) => emitRun(hint ?? undefined)).catch(() => emitRun());
      } else {
        emitRun();
      }
    },
    [socket, busy, conversationId, providers, skillId, routingMode, forceTier, webSearch, webSearchConfig],
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

  const regenerate = useCallback(() => {
    if (busy) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    // Drop the trailing assistant reply(ies) so the regenerated one replaces it.
    setMessages((prev) => {
      const copy = [...prev];
      while (copy.length && copy[copy.length - 1]?.role === 'assistant') copy.pop();
      return copy;
    });
    runChat(lastUser.content, lastUser.attachments, false);
  }, [busy, messages, runChat]);

  return {
    messages, send, stop, regenerate, busy, error, status, lastTokens, lastSaved, conversationId, loadMessages, setConversationId,
    routingMode, setRoutingMode, forceTier, setForceTier, webSearch, setWebSearch, approval,
  };
}
