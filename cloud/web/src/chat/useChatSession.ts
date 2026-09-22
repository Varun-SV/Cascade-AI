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
import type { BrowserInputEvent } from './BrowserLiveView.js';
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
  /**
   * Whose question this is. The server has always stamped it; this side did
   * not keep it, which left the only blocking gate that could not say which run
   * it belonged to — so a sibling's ending could not remove it and the answer
   * could not be routed.
   */
  conversationId?: string;
  /**
   * And WHICH RUN, which the conversation cannot say when two share one.
   *
   * Both of them register a decision handler on the shared socket, and a
   * conversation-addressed answer satisfied both — one Approve resolved two
   * gates, and the second could not be answered differently even deliberately,
   * because the prompts were collapsed by conversation before anyone saw them.
   */
  runId?: string;
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
  /**
   * What this section was asked to do.
   *
   * The prompt used to open with a section TITLE and nothing else — "Main
   * Task" names the work no better than "Section 3" does — so the person was
   * asked to choose between retrying, re-guiding and skipping without being
   * told what any of those would be doing. Optional because an older server
   * does not send it.
   */
  goal?: string;
  issues: string[];
  /** What the section has produced so far: what "Skip" keeps, and what a
   *  retry throws away. Shown, because it is half of the decision. */
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
export function escalationKey(e: { requestId?: string; sectionId?: string }): string {
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

/** One thing the model needs to know before it can act. Mirrors the SDK's shape. */
export interface ClarificationQuestion {
  id: string;
  prompt: string;
  kind: 'choice' | 'multi' | 'text';
  options?: string[];
}

export interface ClarificationRequest {
  requestId: string;
  questions: ClarificationQuestion[];
  /**
   * How long the gate will wait, from the moment this arrived.
   *
   * Server-adjusted on replay, so a question inherited by a reconnecting page
   * carries what is LEFT rather than the full gate — see `remainingDeadline`
   * in the server's socket layer. That is why the arithmetic here can stay the
   * same shape as the escalation modal's and still be right after a reconnect.
   */
  timeoutMs?: number;
  /** Stamped on arrival, so a re-render cannot restart the countdown. */
  receivedAt?: number;
}

export interface ClarificationAnswer {
  id: string;
  value: string | string[];
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

/**
 * The conversations this pane is answerable for, and HOW MANY runs each.
 *
 * A SET was the obvious shape and the wrong one. Two runs can share a
 * conversation — nothing on the server enforces one run per conversation, and
 * `active_conversations` is built by mapping over the runs, so it lists the
 * same id twice — and with a set the second was indistinguishable from the
 * first. The consequences ran in both directions: the first run to end took
 * the id out and its sibling's approvals, questionnaires and parked sections
 * were settled underneath it; and the live count was measured against the
 * number of distinct conversations, so a pane carrying two runs on one
 * conversation counted one of them as a run it could not name.
 *
 * A count says the one thing a set cannot: that there is still somebody on
 * this conversation. An entry is DELETED at zero rather than left at it, so
 * `size === 0` continues to mean "nothing is running" everywhere it is asked.
 */
type RunOrigins = Map<string, number>;

/** How many runs in total, as opposed to how many conversations. */
function originCount(origins: RunOrigins): number {
  let total = 0;
  for (const n of origins.values()) total += n;
  return total;
}

function addOrigin(origins: RunOrigins, id: string): void {
  origins.set(id, (origins.get(id) ?? 0) + 1);
}

/**
 * Take ONE run off a conversation.
 *
 * Both answers matter and they are different questions. `had` is whether this
 * pane was carrying the run at all — a keyed ending for one it was not is that
 * run naming itself at last, and discharges the unnamed count instead. `last`
 * is whether the conversation is now free of runs, which is what decides
 * whether its gates may be settled.
 */
function dropOrigin(origins: RunOrigins, id: string): { had: boolean; last: boolean } {
  const n = origins.get(id);
  if (n === undefined) return { had: false, last: false };
  if (n <= 1) {
    origins.delete(id);
    return { had: true, last: true };
  }
  origins.set(id, n - 1);
  return { had: true, last: false };
}

/** The origins a list of per-run conversation ids describes, duplicates kept. */
function tallyOrigins(ids: readonly string[]): RunOrigins {
  const origins: RunOrigins = new Map();
  for (const id of ids) addOrigin(origins, id);
  return origins;
}

export function useChatSession(
  socket: Socket | null,
  providers: ProviderConfig[],
  skillId: string,
  webSearchConfig?: WebSearchPayload,
  initialConversationId?: string,
  /**
   * Whether the routing controls are on screen at all.
   *
   * False in Simple view, which hides the whole row. Passed in because this
   * hook holds `browserMode`, and a per-run billed opt-in must not stay set
   * while the only control for it is gone — see the effect below.
   */
  controlsVisible = true,
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
  /**
   * The conversation the run THIS PANE STARTED belongs to.
   *
   * Deliberately not `pendingConversationIdRef`, and deliberately not cleared
   * by `selectConversation`. That ref answers "where should arriving events be
   * routed", which stops being this run's business the moment the user opens
   * another chat. This one answers "whose gates does this run's ending settle",
   * and that does not change because somebody navigated: the run is still that
   * conversation's, and its approvals, questionnaires and parked sections are
   * still queued under its id.
   *
   * Every ending needs it, because none of them reliably carries an id — the
   * error ack is `{ error }` and nothing else, and a run that finishes in the
   * gap before its socket's `disconnect` lands is already out of `activeRuns`,
   * so the replacement socket reports `active: 0` with an empty `finished`.
   * Both then fell through to whatever was on screen.
   *
   * A SET, because a resume can hand this pane more than one. `busy` allows the
   * pane to START only one run, but `run:resumed` can report several already
   * live — and then a single slot has to pick, which is a guess either way:
   * choose one and the others' approvals, questionnaires and parked sections
   * are never reconciled when the ack-less ending settles; choose none and
   * nothing is. Keeping all of them means the ending settles exactly the runs
   * this pane is answerable for.
   *
   * Emptied at every ending rather than left to be overwritten, so a finished
   * run cannot be mistaken for an inherited one on the next resume.
   */
  /**
   * A send this pane has STARTED but not yet put on the wire, if any.
   *
   * There is a window where `busy` is true and nothing has been emitted: the
   * on-device classifier runs first when it is enabled, and `emitRun` is its
   * continuation. Nothing named that state, so anything that declared the pane
   * idle during it — a reconnect reporting `active: 0`, which is CORRECT,
   * because the server really does have no run — cleared `busy` and then
   * watched the continuation emit the run anyway. A live run with no Stop
   * state, and a composer free to start a second one on top of it.
   *
   * Identity rather than a flag, so a cancelled send cannot be confused with
   * the next one: `emitRun` refuses unless the marker is still the one its own
   * `runChat` created.
   *
   * It carries the transcript as it stood BEFORE the send, because cancelling
   * has to undo the optimistic mutation as well as the intent. `runChat` shows
   * the user's turn — and, for an edit or a regenerate, TRUNCATES the branch —
   * before the classifier is consulted, so a cancelled send otherwise left an
   * unsent message on screen forever, or a conversation visibly shortened, for
   * a `chat:run` that never went out.
   */
  const pendingSendRef = useRef<{
    token: symbol;
    restore: ChatMessage[];
    /**
     * WHICH CHAT the snapshot is of. Restoring it anywhere else is not a
     * rollback, it is an overwrite: start a send in A, open B while the
     * classifier is still thinking, press Stop, and B's loaded transcript was
     * replaced by A's pre-send array — messages from the wrong conversation,
     * standing until another reload.
     */
    conversationId?: string;
    /**
     * And whether this send is what ARMED first-turn adoption, so cancelling
     * can disarm it. Cancellation put the transcript back and left the routing
     * state alone, so a blank pane stayed willing to adopt — and the next event
     * from a background or inherited run naming a conversation claimed the pane
     * for a run it never started, bringing that run's browser panel and
     * approval prompts with it.
     */
    armedFirstTurn: boolean;
  } | undefined>(undefined);
  /**
   * Runs this pane is carrying that it cannot NAME.
   *
   * `active_conversations` is not the whole of `active`: the server drops runs
   * whose conversation id is not known yet (socket.ts), which on a reloaded
   * first turn is exactly the run being recovered. So the origin set can be
   * empty while a run is genuinely live — and once the shared state is released
   * on "the set is empty", that reads as "nothing is running" and frees the
   * composer over a run that is still going, whose own terminal event the
   * cleared ack-lost flag then discards.
   *
   * A count rather than a sentinel in the set, because the set is what gets
   * SETTLED and there is nothing here to settle by name. It goes down when one
   * of them is adopted — a named run belongs in the set instead — and a report
   * that ends everything clears it outright.
   */
  const unnamedRunsRef = useRef(0);
  const runOriginsRef = useRef<RunOrigins>(new Map());
  /**
   * WHICH RUNS this pane is showing — by name, and there can be more than one.
   *
   * A conversation was the only address this hook had, and two runs can share
   * one — a duplicated tab inherits the incumbent's run while holding its own —
   * so everything addressed that way was ambiguous exactly there. Stop hit both
   * of them, and both runs' tokens were appended to the single streaming
   * bubble, interleaving two answers into one.
   *
   * A LIST rather than one slot, because the first version of this was a slot
   * that emptied whenever it could not pick — and an empty slot meant "no run
   * filter", so the filters fell straight back to the conversation address that
   * matches both. It degraded OPEN precisely in the multi-run case it was
   * written for. Holding the candidates instead lets each consumer answer for
   * itself, and they want different things: Stop means all of them, while the
   * streaming bubble can only mean one.
   *
   * Set when this pane EMITS a run, because the id is its own — minted here and
   * sent with the payload, so it is known from the instant the run starts
   * rather than whenever a message happens to name it. Set from a resume to
   * whichever live runs could be this pane's. EMPTY means no information at
   * all — an older server — and only then does anything fall back to the
   * conversation.
   *
   * WHAT IS LIVE, not what was showing. This used to store the answer, computed
   * at `run:resumed` against whatever conversation happened to be on screen
   * then — and `selectConversation` moves the pane without recomputing it. So
   * after resuming A and B on A's pane and navigating to B, the stored answer
   * still said A: Stop sent A's run id alongside B's conversation, the server
   * gives run ids precedence, and it aborted the run the user had just walked
   * away from while B carried on. The token filter had the mirror failure —
   * B's own tokens were dropped as belonging to some other run, on the screen
   * showing B.
   *
   * Storing the INPUTS and deriving the answer on read fixes both directions at
   * once, and it also keeps the property that made a stored answer tempting:
   * walking back to A makes A's run addressable again, because the derivation
   * is the same either way. There is no navigation hook to remember to update,
   * which is the failure this shape removes rather than patches.
   */
  const knownRunsRef = useRef<Array<{ runId: string; conversationId?: string; mine?: boolean }>>([]);
  /** The conversation this pane's events belong to — known, or adopted below. */
  const activeConversationId = (): string | undefined =>
    conversationIdRef.current ?? pendingConversationIdRef.current;
  /**
   * The runs this pane may speak for RIGHT NOW — derived, never stored.
   *
   * A pane that knows its conversation speaks only for runs on it: an
   * unattributed run cannot be this pane's, because a pane with a conversation
   * emitted its run WITH that id and the server therefore knows it too.
   *
   * A blank pane speaks for the run it started, if it started one — that is the
   * first turn, where neither side has a conversation yet and `mine` is the only
   * thing that distinguishes its run from a stranger's. Failing that it speaks
   * for a uniquely adoptable run, and for nothing at all when there is a choice
   * to make: the same non-guessing rule the conversation adoption follows.
   */
  const shownRuns = (): string[] => {
    const runs = knownRunsRef.current;
    const mine = conversationIdRef.current;
    if (mine) return runs.filter((r) => r.conversationId === mine).map((r) => r.runId);
    const own = runs.filter((r) => r.mine);
    if (own.length === 1) return [own[0]!.runId];
    return runs.length === 1 ? [runs[0]!.runId] : [];
  };
  /**
   * Learn the id the server minted for the run this pane just started.
   *
   * VERIFIES THE RUN FIRST. A blank pane waiting for its first turn will adopt
   * whatever conversation arrives, and on a socket that also carries a resumed
   * background run, that race is winnable by the wrong event: the pane adopts
   * the stranger's conversation, shows its notices, and then rejects its own
   * run's events until the closing acknowledgement corrects the id.
   *
   * Every event is stamped with its `runId` by the transport, and
   * `knownRunsRef` already records the run this pane minted with `mine: true`.
   * So identity is available at exactly the moment adoption needs it, and an
   * event that names a run this pane does not own is not evidence about this
   * pane's conversation.
   *
   * An event with NO runId still adopts, as before. Older servers and emits
   * outside a run context do not stamp one, and refusing those would break the
   * first turn outright to close a race — worse than the race.
   */
  const adoptConversationId = (convo: unknown, runId?: unknown): void => {
    if (!awaitingFirstTurnRef.current) return;
    if (conversationIdRef.current || pendingConversationIdRef.current) return;
    if (typeof runId === 'string' && runId) {
      const mine = knownRunsRef.current.some((r) => r.mine && r.runId === runId);
      if (!mine) return;
    }
    if (typeof convo === 'string' && convo) {
      pendingConversationIdRef.current = convo;
      // The same id, kept for a different question and a longer life — see
      // `runOriginsRef`. This is the only place a first turn ever learns the id
      // the server minted for it.
      addOrigin(runOriginsRef.current, convo);
      // And it is no longer one of the runs this pane cannot name.
      if (unnamedRunsRef.current > 0) unnamedRunsRef.current -= 1;
    }
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
    Record<string, Array<{
      taskId: string;
      liveViewUrl?: string;
      /**
       * The most recent frame, and only that one.
       *
       * Never a queue: a viewer shows the newest picture of the page, so
       * holding older frames would spend memory to display something already
       * untrue. A slow client simply misses intermediate frames, which is the
       * correct behaviour for a live view and the reason the server acks each
       * frame only once it has been handed on.
       */
      frame?: {
        data: string; width: number; height: number;
        /**
         * Which watch this picture belongs to.
         *
         * Sent straight back as a receipt, because the server cannot know a
         * frame arrived: it goes out on the lossy channel and is DROPPED rather
         * than queued when the transport is not writable. Hiding the page is
         * gated on that receipt, so a picture nobody received cannot be the
         * "you already saw it" that a blind typing surface rests on.
         */
        generation: number;
      };
      /** The server confirmed a stream started, so an empty panel is a bug. */
      streaming?: boolean;
      /** The user holds this page: the agent is being refused until they stop. */
      human?: boolean;
      /** Whether frames are being produced. False while the picture is paused. */
      capturing?: boolean;
      /**
       * Whether THIS watch has confirmed receiving a picture.
       *
       * The server's answer, not ours: while the picture is off there are no
       * frames to work it out from, and what this pane remembers is about the
       * watch it had BEFORE a reload. It gates the blind keyboard surface.
       */
      confirmed?: boolean;
      /**
       * Something the user asked of the browser that did not happen.
       *
       * Kept with the view rather than in one shared banner, because a refusal
       * belongs to the run it was refused for: showing another chat's "you do
       * not have control" over this one's panel would be a lie about this page.
       */
      notice?: string;
    }>>
  >({});
  const browserView = browserViews[activeConversationId() ?? '']?.at(-1);
  /** Where the agent's browser can be watched, for the conversation on screen. */
  const browserLiveView = browserView?.liveViewUrl;
  /** The latest frame of the browser this pane is showing, if it is streaming. */
  const browserFrame = browserView?.frame;
  /** Whether the server said a stream is running, as opposed to merely asked for. */
  const browserStreaming = browserView?.streaming === true;
  /** Whether the user, rather than the agent, is driving the browser on screen. */
  const browserHuman = browserView?.human === true;
  /** Whether frames are still being produced while they drive it. */
  const browserCapturing = browserView?.capturing !== false;
  /** Whether this watch has confirmed a picture. Gates the blind keyboard. */
  const browserConfirmed = browserView?.confirmed === true;
  /** The last thing the browser refused to do for this pane, if any. */
  const browserNotice = browserView?.notice;
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
  /**
   * Answer a questionnaire, or say plainly that you would rather not.
   *
   * An empty `answers` is a DELIBERATE skip and the model is told so — the
   * timeout and the abort have their own outcomes, so nothing else can produce
   * an answered-but-empty reply. It exists so somebody who does not want to
   * fill the form in is not made to wait out the two-minute gate to say that.
   *
   * Removed from the queue immediately rather than on an acknowledgement: the
   * run is blocked waiting, and a form that stays on screen after you submit it
   * invites a second, contradictory answer.
   */
  const answerClarification = useCallback((requestId: string, answers: ClarificationAnswer[]) => {
    setClarifications((q) => {
      const asked = q.find((c) => c.requestId === requestId);
      // Nothing queued under that id — a double submit, or a form already
      // pruned by its run ending. Emitting anyway would name a conversation
      // this pane merely happens to be showing.
      if (!asked) return q;
      socket?.emit('clarification:answer', {
        // The conversation the QUESTION came from, not the one on screen: the
        // pane's own id is undefined in a blank New Chat, and answering by
        // request id alone would let a reply in one chat settle a question in
        // another.
        conversationId: asked.conversationId,
        requestId,
        answers,
      });
      return q.filter((c) => c.requestId !== requestId);
    });
  }, [socket]);

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

  /**
   * Drop a refusal the person has moved on from.
   *
   * The notice was documented as lasting "until the next thing the server says
   * about this browser" — and `announceControl` DEDUPES on `human:capturing:
   * confirmed`, so when a refusal changes none of those (an unsupported key,
   * say) the next thing never comes. "That key cannot be sent" then sat on the
   * panel for the rest of the takeover while every click and keystroke after it
   * worked, because success is silent by design: a reply per event would double
   * the traffic to say nothing.
   *
   * So the person doing something else is what clears it. That is the signal
   * actually available here — the server cannot send one without inventing an
   * acknowledgement for every event, which is the design this deliberately does
   * not have.
   */
  const clearBrowserNotice = useCallback((taskId: string) => {
    setBrowserViews((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [key, views] of Object.entries(prev)) {
        next[key] = views.map((view) => {
          if (view.taskId === taskId && view.notice !== undefined) {
            changed = true;
            return { ...view, notice: undefined };
          }
          return view;
        });
      }
      return changed ? next : prev;
    });
  }, []);

  const stopBrowser = useCallback(() => {
    // The task id, which the server requires to match exactly. Without it the
    // Stop is ignored — which is the correct failure: better a button that does
    // nothing than one that stops somebody else's run.
    const taskId = browserTaskIdRef.current;
    if (!taskId) return;
    socket?.emit('browser:stop', { taskId });
    // Withdraw THIS task optimistically. If an older browser is still active in
    // the same conversation it becomes the displayed one immediately, keeping
    // its own Stop control reachable instead of deleting the whole conversation
    // slot along with the task the user actually stopped.
    const key = activeConversationId() ?? '';
    setBrowserViews((prev) => {
      const views = prev[key];
      if (!views) return prev;
      const kept = views.filter((view) => view.taskId !== taskId);
      if (kept.length === views.length) return prev;
      if (kept.length === 0) {
        const { [key]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: kept };
    });
  }, [socket]);

  /**
   * Ask for the page, give it back, drive it, or pause the picture.
   *
   * All four name the run rather than the conversation, and refuse to send at
   * all without one — the server requires an exact match, so a control event
   * with no task id is ignored, and that is the correct failure: better a
   * button that does nothing than one that drives somebody else's browser.
   *
   * Nothing is applied optimistically. Ownership is stated by the server on
   * `browser:control`, because it changes without being asked — an idle hold
   * lapses on its own — and a client that painted itself in control would show
   * a page it could no longer touch.
   */
  const takeOverBrowser = useCallback(() => {
    if (!browserTaskIdRef.current) return;
    clearBrowserNotice(browserTaskIdRef.current);
    socket?.emit('browser:take-over', { taskId: browserTaskIdRef.current });
  }, [socket, clearBrowserNotice]);

  const handBackBrowser = useCallback(() => {
    if (!browserTaskIdRef.current) return;
    clearBrowserNotice(browserTaskIdRef.current);
    socket?.emit('browser:hand-back', { taskId: browserTaskIdRef.current });
  }, [socket, clearBrowserNotice]);

  /**
   * Refused while the socket is down, rather than sent and buffered.
   *
   * Socket.IO buffers anything emitted while disconnected and delivers it on
   * reconnect. For a mutation aimed at a picture, that is the worst possible
   * delivery: the person acted on the last frame before the gap, the remote
   * page went on changing without them, and the click lands afterwards on
   * whatever is there now. Dropping it at the source is what keeps it out of
   * that buffer — a check on arrival cannot tell a delayed event from a fresh
   * one, because by then it is fresh.
   *
   * Stop is deliberately NOT gated this way. Buffering "stop using the
   * browser" and delivering it late is the direction that helps.
   */
  const sendBrowserInput = useCallback((event: BrowserInputEvent) => {
    if (!browserTaskIdRef.current || !socket?.connected) return;
    clearBrowserNotice(browserTaskIdRef.current);
    socket.emit('browser:input', { taskId: browserTaskIdRef.current, event });
  }, [socket, clearBrowserNotice]);

  const setBrowserCapture = useCallback((on: boolean) => {
    if (!browserTaskIdRef.current || !socket?.connected) return;
    clearBrowserNotice(browserTaskIdRef.current);
    socket.emit('browser:capture', { taskId: browserTaskIdRef.current, on });
  }, [socket, clearBrowserNotice]);

  /**
   * Start a NEW viewing boundary on this run's browser.
   *
   * Unwatch and watch, never watch alone, and that pairing is the whole point.
   * A bare watch takes the server's reconnect branch, which deliberately KEEPS
   * an existing screencast — and because CDP frames are adaptive, an idle page
   * then sends nothing, so the panel sits inert with no way back. Tearing the
   * screencast down and building it again bumps the watch generation AND makes
   * Chrome produce a first frame immediately. A deliberate Hide still survives
   * it, because the re-attach honours the holder's pause.
   *
   * A screencast can survive into a view that never asked for one because
   * nothing on the server side stops watching when a socket drops: a reload or
   * a transient gap sends no unwatch, and the run is later re-pointed at the
   * new connection with its stream still attached. Both ways in need the same
   * treatment, which is why they share this rather than each spelling it out:
   *   • a page that RELOADS learns its task id from the replayed live view,
   *     which arrives well after `connect` — so the connect handler has no id
   *     to act on and only the watch effect below can do it;
   *   • a page that RECONNECTS keeps both its socket object and its task id,
   *     so the watch effect's dependencies never change and only the connect
   *     handler can do it.
   * Neither one covers the other, and each was the sole path in a real blank
   * panel.
   *
   * Emitted whether or not the socket is up: unlike an input event, a watch
   * that arrives late is still the right request, and Socket.IO's buffer
   * delivering it on connect is exactly the wanted behaviour.
   */
  const beginWatching = useCallback((taskId: string) => {
    // The evidence of SIGHT goes first, before the request that replaces it.
    //
    // Same rule `onDisconnect` states, reached by the other door. A view is
    // kept per conversation, deliberately, so switching chats and coming back
    // does not throw the run's panel away — but what comes back with it is a
    // JPEG of a page from before the switch, and `driving` alone is what makes
    // that image interactive. A hold survives a conversation switch, so the
    // person returns to a picture that is minutes old, still clickable, over a
    // page that has moved on. That is round 14's stale-and-interactive failure
    // arriving through the switch rather than through the socket.
    //
    // `human` is deliberately not touched here either: ownership is pushed by
    // the server and a client deciding its own would be the one thing this
    // panel never does. What goes is the frame, the stream and this watch's
    // confirmation — which leaves the panel inert and saying so, and the blind
    // keyboard shut, until the new watch supplies a picture of its own. The
    // unwatch/watch pair below makes Chrome produce that immediately, so the
    // gap is a round trip rather than a wait for the page to move.
    //
    // Scoped to the task being watched. `onDisconnect` clears every view
    // because the socket is down for all of them; this one is about a single
    // boundary being redrawn.
    setBrowserViews((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [key, views] of Object.entries(prev)) {
        next[key] = views.map((view) => {
          if (view.taskId === taskId && (view.frame || view.streaming || view.confirmed)) {
            changed = true;
            return { ...view, frame: undefined, streaming: false, confirmed: false };
          }
          return view;
        });
      }
      return changed ? next : prev;
    });
    socket?.emit('browser:unwatch', { taskId });
    socket?.emit('browser:watch', { taskId });
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
  // Kept for whichever conversation asked, and filtered on READ — the same
  // shape as the approvals above, and for the same reason recorded there: a
  // filter applied on RECEIPT drops the whole first turn of a new chat,
  // because the server tags the request with a conversation id this side does
  // not learn until the closing ack.
  const [allClarifications, setClarifications] = useState<Array<ClarificationRequest & { conversationId?: string }>>([]);
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
  const clarifications = allClarifications.filter((c) => c.conversationId === currentConversation);

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

  // A QUEUE, not one slot. The SDK keys parked escalations by requestId
  // precisely because a Complex wave dispatches sections concurrently, so two
  // can be waiting at once — storing one here threw the first away, and
  // answering the visible prompt left the hidden section parked until timeout.
  const [allEscalations, setEscalations] = useState<EscalationRequest[]>([]);
  /**
   * A run is over, so nothing is still waiting on its questions.
   *
   * The server resolves every remaining approval callback `false` and clears
   * its map in the run's `finally`, and sends nothing to say so. Without a
   * matching removal here a prompt survives its own run — it reappears when
   * the user comes back to that conversation, and clicking it answers a waiter
   * that no longer exists, which reads as a control that silently does nothing.
   *
   * ALL THREE BLOCKING GATES, and that is the point of it being one function.
   *
   * It started as approvals only, and the other two were then cleared
   * wholesale at each ending — `setEscalations([])`, and a by-conversation
   * clarification filter written out again at one of the two call sites. Every
   * one of those queues spans conversations, so emptying one because A
   * finished took down B's live section: its modal vanished with no
   * `escalation:decide` ever sent, and the run stayed parked until the server
   * timed it out. That is the same failure the dismissal path was fixed for one
   * round earlier, through a different door — which is why the rule now lives
   * here, with the three queues it governs, instead of being restated at each
   * ending that has to obey it.
   *
   * An entry is kept only when it names a DIFFERENT conversation. One naming
   * none is not "somebody else's, so leave it" — the server's `answersThisRun`
   * requires an exact conversation id on every inbound answer, so an unkeyed
   * entry cannot be answered by any run at all. Keeping it past the ending
   * leaves a control that does nothing.
   *
   * WHICH IS WHY THERE IS NO `if (!cid) return` HERE, and the guard that used
   * to be one is the reason `finishWithoutAck` cleared the whole queue before
   * reaching this function. A first turn whose ack was lost never learned an
   * id, so there is nothing to scope by — and its gates are precisely the ones
   * no later event can name either. Called with no id this drops exactly the
   * unkeyed entries and leaves every conversation's own work alone, which is
   * the same rule, not an exception to it.
   *
   * The browser panel is deliberately not here. It has its own authoritative
   * ending in `browser:live-view` with `active: false`, which is scoped to the
   * TASK rather than the conversation and so is the more precise of the two.
   */
  const settleConversation = useCallback((cid?: string) => {
    // Identity kept when nothing matches, so an ending in one conversation does
    // not re-render the panes of the others.
    const elsewhere = (x: { conversationId?: string }) => !!x.conversationId && x.conversationId !== cid;
    setToolApprovals((q) => (q.every(elsewhere) ? q : q.filter(elsewhere)));
    setClarifications((q) => (q.every(elsewhere) ? q : q.filter(elsewhere)));
    setEscalations((q) => (q.every(elsewhere) ? q : q.filter(elsewhere)));
  }, []);
  /**
   * The parked sections belonging to the chat on screen.
   *
   * Filtered on read, exactly as `clarifications` is, and for the reason that
   * comment gives — switching chats must not strand a run, so the request stays
   * queued and re-appears when you come back to it.
   *
   * This mattered the moment the modal began rendering the whole queue: one
   * socket carries concurrent runs for several conversations, so an unfiltered
   * list put background conversations' sections into the window for the chat
   * you were looking at, and closing it skipped them.
   */
  const escalations = allEscalations.filter(
    (e) => !e.conversationId || e.conversationId === currentConversation,
  );
  const escalation = escalations[0] ?? null;
  // Extended context: a pending "process this huge input?" confirm, and a
  // transient notice once a compaction actually happened.
  // A QUEUE, not one slot — the last gate still holding a single value. Two
  // resumed conversations can reach the extended-context gate at once, and the
  // second overwrote the first: only the newest could be answered, and the run
  // it displaced sat blocked until its own gate timed out.
  const [allContextApprovals, setContextApprovals] = useState<ContextApprovalInfo[]>([]);
  /**
   * EVERY question this chat is being asked, filtered on read exactly as the
   * other three gates are — so a background conversation's dialog is not put in
   * front of somebody watching a different run, and switching chats does not
   * strand the question the run is still blocked on.
   *
   * ALL of them, not the first. Each run's server-side gate starts its own
   * 120-second timer when it asks, and that gate resolves TRUE on timeout — so
   * a question queued behind a sibling had its deadline running while nobody
   * could see it, and a billed compaction proceeded on a confirmation that was
   * never shown, let alone given. Queueing is only safe when the thing being
   * queued is not also expiring.
   */
  const contextApprovals = allContextApprovals.filter(
    (a) => !a.conversationId || a.conversationId === currentConversation,
  );
  /** The first of them, kept for callers that only ever showed one. */
  const contextApproval = contextApprovals[0] ?? null;
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
  const [webSearch, setWebSearchRaw] = useState(() => defaultWebSearch());
  // Reaching the internet is ONE decision with three outcomes — read text,
  // drive a page, or neither — so the two switches cannot both be on. Enforced
  // here rather than in the chip's onClick, because it is a property of the
  // choice and not of the button: anything that sets one must clear the other,
  // however it reaches these setters. The server enforces it independently.
  const [browserMode, setBrowserModeRaw] = useState(false);
  const setWebSearch = useCallback((on: boolean) => {
    setWebSearchRaw(on);
    if (on) setBrowserModeRaw(false);
  }, []);
  const setBrowserMode = useCallback((on: boolean) => {
    setBrowserModeRaw(on);
    if (on) setWebSearchRaw(false);
  }, []);

  // Browser mode does not survive its own control being taken off screen.
  //
  // It is modelled on the Web toggle beside it and it is NOT the same kind of
  // thing, which is exactly the mistake: Web is a durable preference — it costs
  // nothing, it is fine for it to persist unseen, and it is DELIBERATELY left
  // alone here. Browser is a per-run opt-in to a billed capability, and the
  // whole point of putting it behind a chip was that opening a browser should
  // be something a person chose.
  //
  // Sticky through a switch to Simple view, it stopped being chosen: the row
  // vanishes, the flag stays true, and every later send still carries
  // `browserMode: true` with nothing on screen to say so or turn it off.
  //
  // Cleared rather than shown as an indicator in Simple, because Simple's rule
  // is that these controls are not there — surfacing one of them would be a
  // different product decision, and the safe reading of an invisible billed
  // capability is that it is not granted.
  useEffect(() => {
    if (!controlsVisible) setBrowserModeRaw(false);
  }, [controlsVisible]);
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
    const onToken = (e: { text: string; primary?: boolean; conversationId?: string; runId?: string }) => {
      // Only stream the PRESENTER tier's output (the actual answer). Intermediate
      // nodes — planning, decomposition, background workers — emit primary:false;
      // showing those made each node's output flash by before the final result,
      // which read as a runaway. Keep the status chip up while they work.
      if (e.primary === false) return;
      // AND ONLY THIS CHAT'S TOKENS. One socket carries several runs, and this
      // handler read none of that — so with two runs resumed together, B's
      // output appended to the bubble A was streaming into, and the transcript
      // on screen grew somebody else's answer.
      //
      // The same shape as `onStatus` below, including the reason for the
      // `current &&` guard: on a first turn the server tags events with an id
      // this side does not learn until the closing ack, so comparing against
      // `undefined` would discard the entire first run — the most common case
      // there is.
      // THE RUN FIRST, where both ends can name it. Conversation scoping was
      // right between chats and blind within one: two runs on the same
      // conversation both passed this filter, and their answers were appended
      // to the same bubble a token at a time. Dropped rather than buffered, on
      // the rule this handler already follows for another chat's tokens — the
      // pane renders ONE transcript, so a second run's output has nowhere to
      // go in it, and the bubble is rebuilt from the persisted answer anyway.
      // ONE BUBBLE, so one run. With a single candidate this admits only its
      // tokens; with several it admits NONE of them that name a run, because
      // the pane cannot tell whose answer it would be writing and appending
      // both is the interleaving this exists to stop. Dropped rather than
      // buffered, on the rule this handler already follows for another chat's
      // tokens — the persisted answer replaces the bubble either way.
      //
      // An empty list is no information rather than ambiguity: an older server
      // names no runs at all, and the conversation check below is what it had.
      const shown = shownRuns();
      if (shown.length > 0 && e.runId && !shown.includes(e.runId)) return;
      if (shown.length > 1 && e.runId) return;
      const current = activeConversationId();
      if (current) {
        if (e.conversationId && e.conversationId !== current) return;
      } else if (!awaitingFirstTurnRef.current) {
        // No id AND not expecting one. The first-turn exception exists because
        // the server tags events with an id this side does not learn until the
        // closing ack — but `run:resumed` deliberately creates the other
        // no-id state, where SEVERAL runs came back and the pane refused to
        // claim any of them. Accepting everything there concatenated two runs'
        // answers into one buffer and one blank transcript.
        //
        // `awaitingFirstTurnRef` is what separates them: it is armed when this
        // pane expects to learn an id for a run it owns, and explicitly
        // disarmed by the multi-resume branch that claims nothing.
        return;
      }
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
    const onClarificationRequired = (e: ClarificationRequest & { conversationId?: string }) => {
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      if (!e?.requestId || !Array.isArray(e.questions) || e.questions.length === 0) return;
      // Stamped once, on arrival. The countdown is anchored to this rather
      // than to when a component last rendered, for the reason the escalation
      // modal documents: an unrelated re-render would otherwise restart it and
      // the form would claim more time than the server intends to give.
      const arrived = { ...e, receivedAt: Date.now() };
      setClarifications((q) => (q.some((c) => c.requestId === e.requestId) ? q : [...q, arrived]));
    };
    /**
     * The question is over, so the form must come down.
     *
     * Sent for EVERY ending — answered, timed out, stopped, or released by the
     * run unwinding. The timeout event alone was not enough: an abort and a
     * teardown release settle the gate silently, so pressing Stop left a live
     * questionnaire whose submit button answered a request nobody held. Worse,
     * the queue shows the oldest first, so that dead form sat in front of every
     * later question the run asked.
     */
    const onClarificationClosed = (e: { requestId?: string }) => {
      if (!e?.requestId) return;
      setClarifications((q) => q.filter((c) => c.requestId !== e.requestId));
    };
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
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      // The SDK calls it `id`; keep one name on this side.
      const requestId = e.requestId ?? e.id;
      if (!requestId) return;
      setToolApprovals((q) => (q.some((a) => a.requestId === requestId) ? q : [...q, { ...e, requestId }]));
    };
    /**
     * The server is no longer waiting on this question.
     *
     * Sent when the run's approval window closes: the SDK's escalator times the
     * decision out, denies it, and lets the run continue — while this side, with
     * nothing to tell it, kept the prompt on screen for the rest of the run.
     * Clicking it then resolved a waiter the SDK had already given up on, so
     * the button did nothing and said nothing.
     */
    const onPermissionResolved = (e: { requestId?: string }) => {
      if (!e?.requestId) return;
      setToolApprovals((q) => q.filter((a) => a.requestId !== e.requestId));
    };
    const onEscalation = (e: EscalationRequest) => {
      // Adopted BEFORE the queue sees it, exactly as the clarification and
      // approval handlers do — and the thing that was missing when this gate's
      // list started being filtered on read.
      //
      // The server creates the conversation before the run and tags the gate
      // with that real id, while this side does not learn it until the closing
      // ack. So on a new chat's first turn the filter compared a real id
      // against `undefined` and hid the request. An approval hidden that way
      // merely goes unanswered; this one is WORSE, because the escalation
      // blocks the run — the ack that would have supplied the id cannot arrive
      // until the gate settles, and the gate cannot settle because nobody can
      // see it. It deadlocks until the five-minute timeout fails the section.
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      setEscalations((prev) => {
        const incoming = { ...e, receivedAt: Date.now() };
        // Re-delivery of one already queued (a reconnect replay) updates in
        // place rather than showing the same question twice.
        const i = prev.findIndex((x) => escalationKey(x) === escalationKey(incoming));
        if (i < 0) return [...prev, incoming];
        const copy = [...prev];
        copy[i] = incoming;
        return copy;
      });
    };
    // The window closed without an answer — clear the prompt so a stale modal
    // can't be answered into a run that has already moved on.
    // Drop only the section that timed out. Without the id an older request's
    // timeout would clear a NEWER prompt the user is mid-answer on.
    const onEscalationTimeout = (e: { requestId?: string; sectionId?: string }) =>
      setEscalations((prev) => prev.filter((x) => escalationKey(x) !== escalationKey(e)));
    /**
     * The section is no longer parked, however it stopped being parked.
     *
     * The timeout alone was never enough — it is one of four endings, and the
     * other three (answered, Stop, the run unwinding) settled silently. A modal
     * left standing on a section that has moved on can be answered into
     * nothing, and on a page that reconnects it is the only thing that can take
     * it down, since absence from a replay cannot remove anything.
     *
     * The same event the clarification gate got two rounds earlier; this is the
     * gate that one was copied from.
     */
    const onEscalationClosed = (e: { requestId?: string; sectionId?: string }) =>
      setEscalations((prev) => prev.filter((x) => escalationKey(x) !== escalationKey(e)));
    const onContextApproval = (e: ContextApprovalInfo & { conversationId?: string; runId?: string }) => {
      // Adopted and kept, like every other blocking gate. This one was the last
      // unkeyed member of the family: a single slot with no idea whose question
      // it was, so a sibling run's ending could not take it down and answering
      // it sent a decision nothing could route.
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      // De-duplicated by RUN where there is one, so a replay after a reconnect
      // does not queue a second copy — and so two runs on one conversation get
      // two questions rather than the first silently swallowing the second.
      setContextApprovals((q) => (
        q.some((a) => (e?.runId ? a.runId === e.runId : !a.runId && a.conversationId === e?.conversationId))
          ? q
          : [...q, e]
      ));
    };
    // EVERY ending of that gate, and not only the one that compacted.
    //
    // `onCompacted` below takes the dialog down when the answer was yes and the
    // work then happened. It is the only ending that was ever handled: a denial
    // left the dialog standing, and so did the gate's own two-minute timeout —
    // in both cases with buttons that reach a gate the run has already moved
    // past. The same event is what the server replays, so a page that reloaded
    // while the question was up is not handed back one that has been answered.
    const onContextClosed = (e: { conversationId?: string; runId?: string }) => {
      // By run where the closure names one, so one run's gate ending does not
      // take down the question its sibling on the same conversation is still
      // blocked on.
      setContextApprovals((q) => q.filter((a) => (e?.runId
        ? a.runId !== e.runId
        : (a.conversationId ?? '') !== (e?.conversationId ?? ''))));
    };
    const onCompacted = (e: {
      kind?: string; chunks?: number; foldedTurns?: number; truncated?: boolean;
      conversationId?: string; runId?: string;
    }) => {
      // The compaction happened, so THAT run's question is over — and only
      // that one. It used to empty the single slot whoever had asked.
      //
      // BY RUN, the same rule `context:approval-closed` above was given and
      // this sibling was not. The transport stamps `runId` on every event a run
      // emits, so this one has always carried the identity it needed. Filtering
      // by conversation meant approving run-1 removed run-2's still-live
      // question as well — and run-2 stayed blocked server-side until its own
      // 120s gate timed out and proceeded on its own, which is a billed
      // compaction nobody agreed to.
      setContextApprovals((q) => q.filter((a) => (e?.runId
        ? a.runId !== e.runId
        : (a.conversationId ?? '') !== (e?.conversationId ?? ''))));
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
      //
      // Adopt BEFORE filtering. On the first message of a new chat the server
      // mints the conversation and starts the run before the `chat:run`
      // acknowledgement gives this pane the id — so comparing against a ref
      // that is still undefined reads the pane's OWN first turn as somebody
      // else's and drops it. `activeConversationId()` also counts the adopted
      // id, which `conversationIdRef` alone does not.
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      if (e.conversationId && e.conversationId !== activeConversationId()) return;
      const who = e.provider ?? 'A provider';
      setProviderNotice(e.failedOverTo
        ? `${who} is out for this run — ${e.message ?? ''} Continuing on ${e.failedOverTo}; the rest of this run is billed to that account.`
        : `${who} is out for this run — ${e.message ?? ''}`);
    };
    const onKnowledge = (e: {
      conversationId?: string;
      mode?: string; docCount?: number; passages?: number; reranked?: boolean;
      keptChars?: number; totalChars?: number;
    }) => {
      // One socket carries several conversations on plans that allow
      // concurrent runs, so an over-budget Fast Answer or a degraded retrieval
      // in a BACKGROUND chat would otherwise post its notice into whichever
      // chat happens to be open — telling the user their current document was
      // trimmed when it was not.
      //
      // Adopt before filtering, for the reason the provider handler above now
      // gives: the FIRST turn of a new chat resolves documents before this pane
      // has been told the conversation id, and the attachment flow that most
      // needs this notice is exactly that turn. Filtering on a ref that is
      // still undefined discarded every first-turn notice.
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      if (e.conversationId && e.conversationId !== activeConversationId()) return;
      if (e.mode === 'searched') {
        const docs = e.docCount === 1 ? 'the document' : `${e.docCount} documents`;
        const verb = e.reranked ? 'reranked to the' : 'pulled the';
        setKnowledgeNotice(`Searched ${docs} and ${verb} ${e.passages ?? 0} most relevant passages.`);
      } else if (e.mode === 'nokey' || e.mode === 'fast' || e.mode === 'degraded') {
        // SAYS WHAT WAS ACTUALLY SENT. This used to claim "the full text was
        // still included", which was true only because ingestion had already
        // cut every document at 200,000 characters — so the reassurance was
        // resting on the very truncation it was reassuring the user about.
        //
        // Now the run trims to the real document budget and the notice reports
        // the share that reached the model, because a user deciding whether to
        // trust an answer needs to know how much of the file it saw.
        // NOT "larger than the context window". `injectWithinBudget` measures
        // against `cagCharBudget`, which is a FRACTION of the window (half, by
        // default) held back for the system prompt, the history and the reply.
        // A corpus can sit comfortably inside the model's real window and
        // still be trimmed here, and telling the user their model could not
        // hold it invents a limitation the model does not have — they might go
        // and buy a bigger one.
        const docs = e.docCount === 1 ? 'This document is' : 'These documents are';
        const share = e.keptChars !== undefined && e.totalChars
          ? ` About ${Math.max(1, Math.round((e.keptChars / e.totalChars) * 100))}% of the text was included, from the start of each file.`
          : ' Only the beginning of each was included.';
        // The three modes reach the same trim by different routes, and the
        // route decides the remedy. Telling someone who already has a key to
        // add one — which the single 'nokey' branch did for every fallback —
        // is advice they cannot act on.
        const remedy = e.mode === 'nokey'
          ? 'add an embeddings-capable key (OpenAI, an OpenAI-compatible endpoint, or a local Ollama) to search the whole of it instead'
          : e.mode === 'fast'
            ? 'Fast Answer skips the search step — ask again without it to search the whole of it instead'
            : 'the search step could not run for this turn — asking again will retry it';
        setKnowledgeNotice(`${docs} larger than this run's document budget.${share} Nothing was lost from the upload — ${remedy}.`);
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
    const onDisconnect = () => {
      // The last frame stops being a picture of anything.
      //
      // A takeover survives a transport gap — the server holds the lease across
      // the reconnect grace, and the remote page keeps changing — but no frames
      // can reach this client while it is down. Left as it was, the stale JPEG
      // stays an interactive `<img>` and invites the person to drive a page
      // they can no longer see.
      //
      // `human` is deliberately NOT cleared. The hold really does survive, and
      // a client that decided its own ownership would be the one thing this
      // panel never does — ownership is pushed. What goes is the evidence of
      // SIGHT: the frame, the stream, and this watch's confirmation. That
      // leaves the panel in a state it already knows how to render, inert and
      // saying so, and leaves the blind keyboard shut.
      setBrowserViews((prev) => {
        let changed = false;
        const next: typeof prev = {};
        for (const [key, views] of Object.entries(prev)) {
          next[key] = views.map((view) => {
            if (view.frame || view.streaming || view.confirmed) {
              changed = true;
              return { ...view, frame: undefined, streaming: false, confirmed: false };
            }
            return view;
          });
        }
        return changed ? next : prev;
      });
    };
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
      // to, while a late withdrawal from the run you left cleared the view of
      // the one you were on.
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      const key = typeof e?.conversationId === 'string' ? e.conversationId : (activeConversationId() ?? '');
      const taskId = typeof e?.taskId === 'string' && e.taskId ? e.taskId : undefined;
      // Every server live-view message is task-addressed. An untagged message
      // cannot safely create, replace or withdraw any browser in a conversation.
      if (!taskId) return;
      setBrowserViews((prev) => {
        const views = prev[key] ?? [];
        if (e?.active !== true) {
          // Remove exactly the run that gave its browser up. The newest active
          // task is the panel, so if THAT task ends the previous still-active
          // browser is promoted rather than disappearing with it.
          const kept = views.filter((view) => view.taskId !== taskId);
          if (kept.length === views.length) return prev;
          if (kept.length === 0) {
            const { [key]: _done, ...rest } = prev;
            return rest;
          }
          return { ...prev, [key]: kept };
        }

        const existing = views.findIndex((view) => view.taskId === taskId);
        if (existing >= 0) {
          const current = views[existing]!;
          if (current.liveViewUrl === e?.liveViewUrl) return prev;
          const next = [...views];
          next[existing] = { ...current, liveViewUrl: e?.liveViewUrl };
          // A replay for an already-active task updates its capability URL but
          // does not make an older run jump in front of a newer one.
          return { ...prev, [key]: next };
        }

        // A newly-active browser becomes the visible panel. The task it covers
        // remains active underneath, but its old picture is no longer evidence
        // of sight: if it is promoted later it must establish a fresh watch
        // before any image or blind keyboard can be interactive.
        const hidden = views.map((view, index) => (
          index === views.length - 1
            ? { ...view, frame: undefined, streaming: false, confirmed: false }
            : view
        ));
        return { ...prev, [key]: [...hidden, { taskId, liveViewUrl: e?.liveViewUrl }] };
      });
    };
    /**
     * A rendered frame of a run's browser.
     *
     * Stored against the conversation it belongs to, exactly like the live view
     * — one socket carries several chats, and a frame of somebody else's page
     * appearing in the pane you are looking at would be worse than showing
     * nothing. Only the newest is kept; see `browserViews`.
     */
    const onBrowserFrame = (e: {
      conversationId?: string; taskId?: string; data?: string; width?: number; height?: number;
      generation?: number;
    }) => {
      if (typeof e?.data !== 'string' || !e.taskId) return;
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      const key = typeof e?.conversationId === 'string' ? e.conversationId : (activeConversationId() ?? '');
      setBrowserViews((prev) => {
        const views = prev[key];
        if (!views) return prev;
        const index = views.findIndex((view) => view.taskId === e.taskId);
        if (index < 0) return prev;
        // Only the displayed task is watched. Anything arriving for a hidden
        // task is a late frame from the watch we just replaced; retaining it
        // would make promotion briefly show an old, possibly interactive JPEG
        // before the new viewing boundary has produced its own picture.
        if (index !== views.length - 1) return prev;
        const view = views[index]!;
        const next = [...views];
        next[index] = {
          ...view,
          frame: {
            data: e.data!, width: e.width ?? 0, height: e.height ?? 0,
            generation: typeof e.generation === 'number' ? e.generation : 0,
          },
        };
        return { ...prev, [key]: next };
      });
    };
    /** The server answering whether a stream actually started. */
    const onBrowserWatching = (e: { conversationId?: string; taskId?: string; streaming?: boolean }) => {
      if (!e.taskId) return;
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      const key = typeof e?.conversationId === 'string' ? e.conversationId : (activeConversationId() ?? '');
      setBrowserViews((prev) => {
        const views = prev[key];
        if (!views) return prev;
        const index = views.findIndex((view) => view.taskId === e.taskId);
        if (index < 0 || index !== views.length - 1) return prev;
        const next = [...views];
        next[index] = { ...views[index]!, streaming: e?.streaming === true };
        return { ...prev, [key]: next };
      });
    };
    /**
     * Who holds the page, and anything it refused to do.
     *
     * One event for both, because they are one question with two kinds of
     * answer. A message carrying `human` is the server stating ownership —
     * including the change nobody asked for, when an idle hold lapses. A
     * message carrying only a detail is something that did not happen, and
     * deliberately says nothing about ownership: an unknown key is refused
     * while the user still has control, and treating that as a loss of control
     * would take their panel away over a keystroke.
     */
    const onBrowserControl = (e: {
      conversationId?: string; taskId?: string; human?: boolean; capturing?: boolean;
      confirmed?: boolean; detail?: string;
    }) => {
      if (!e.taskId) return;
      adoptConversationId(e?.conversationId, (e as { runId?: unknown })?.runId);
      const key = typeof e?.conversationId === 'string' ? e.conversationId : (activeConversationId() ?? '');
      setBrowserViews((prev) => {
        const views = prev[key];
        if (!views) return prev;
        const index = views.findIndex((view) => view.taskId === e.taskId);
        if (index < 0) return prev;
        const view = views[index]!;
        const hidden = index !== views.length - 1;
        const nextView = {
          ...view,
          ...(typeof e.human === 'boolean' ? { human: e.human } : {}),
          ...(typeof e.capturing === 'boolean' ? { capturing: e.capturing } : {}),
          ...(!hidden && typeof e.confirmed === 'boolean' ? { confirmed: e.confirmed } : {}),
          ...(e.capturing === false ? { frame: undefined } : {}),
          ...(typeof e.detail === 'string' ? { notice: e.detail } : { notice: undefined }),
          // Ownership can legitimately change while another run is in front,
          // but visibility proof cannot survive being hidden/unwatched.
          ...(hidden ? { frame: undefined, streaming: false, confirmed: false } : {}),
        };
        const next = [...views];
        next[index] = nextView;
        return { ...prev, [key]: next };
      });
    };
    socket.on('browser:control', onBrowserControl);
    socket.on('browser:frame', onBrowserFrame);
    socket.on('browser:watching', onBrowserWatching);
    socket.on('browser:live-view', onLiveView);
    socket.on('stream:token', onToken);
    socket.on('tier:status', onStatus);
    socket.on('run:why', onWhy);
    socket.on('plan:approval-required', onPlan);
    socket.on('clarification:required', onClarificationRequired);
    socket.on('clarification:closed', onClarificationClosed);
    socket.on('permission:user-required', onPermissionRequired);
    socket.on('permission:resolved', onPermissionResolved);
    socket.on('escalation:decision-required', onEscalation);
    socket.on('escalation:timeout', onEscalationTimeout);
    socket.on('escalation:closed', onEscalationClosed);
    socket.on('disconnect', onDisconnect);
    socket.on('context:approval-required', onContextApproval);
    socket.on('context:approval-closed', onContextClosed);
    socket.on('context:compacted', onCompacted);
    socket.on('provider:exhausted', onProviderExhausted);
    socket.on('knowledge:retrieved', onKnowledge);
    socket.on('file:created', onFileCreated);
    return () => {
      socket.off('stream:token', onToken);
      socket.off('tier:status', onStatus);
      socket.off('run:why', onWhy);
      socket.off('plan:approval-required', onPlan);
      socket.off('clarification:required', onClarificationRequired);
      socket.off('clarification:closed', onClarificationClosed);
      socket.off('permission:user-required', onPermissionRequired);
      socket.off('permission:resolved', onPermissionResolved);
      socket.off('escalation:decision-required', onEscalation);
      socket.off('escalation:timeout', onEscalationTimeout);
      socket.off('escalation:closed', onEscalationClosed);
      socket.off('disconnect', onDisconnect);
      socket.off('context:approval-required', onContextApproval);
      socket.off('context:approval-closed', onContextClosed);
      socket.off('context:compacted', onCompacted);
      socket.off('provider:exhausted', onProviderExhausted);
      socket.off('knowledge:retrieved', onKnowledge);
      socket.off('file:created', onFileCreated);
      socket.off('browser:control', onBrowserControl);
      socket.off('browser:frame', onBrowserFrame);
      socket.off('browser:watching', onBrowserWatching);
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
  /**
   * Forget a send that never reached the wire, and put the view back.
   *
   * Both halves matter and they are easy to separate by accident: dropping the
   * marker stops the classifier's continuation from emitting, and restoring the
   * transcript undoes what was shown on the strength of a run that will now
   * never happen. Restored LOCALLY from the pre-send array rather than
   * re-fetched, for the same reason the frame-size refusal does it that way —
   * a value already in memory cannot fail to arrive.
   */
  const cancelPendingSend = useCallback(() => {
    const pending = pendingSendRef.current;
    if (!pending) return;
    pendingSendRef.current = undefined;
    // Adoption is armed by a send and must not outlive one. See `armedFirstTurn`.
    if (pending.armedFirstTurn) awaitingFirstTurnRef.current = false;
    // ONLY IN THE CHAT IT IS A SNAPSHOT OF. A cancelled send in A has nothing
    // to say about what B should be showing, and the pane may well have moved:
    // the whole reason this deferred cancellation exists is that the classifier
    // runs for a while, which is time enough to open another chat.
    //
    // Skipping the restore loses nothing when the pane has moved — switching
    // conversations reloads the transcript from the server, and the optimistic
    // turn was never persisted, so what comes back is already correct.
    if ((pending.conversationId ?? '') === (conversationIdRef.current ?? '')) {
      setMessages(pending.restore);
    }
  }, []);

  /**
   * Whether a run's failure belongs in front of whoever is looking.
   *
   * Every other event in this hook is filtered by conversation and the error
   * banner is the most conspicuous thing it has, so a background run's failure
   * replacing the banner of the run being watched is the worst version of the
   * mismatch. Stated once because it is needed on BOTH terminal paths — the
   * resume's `finished` list and the live `session:error` — and the second of
   * those was missed when the first was fixed.
   *
   * An unnamed error is shown: an older server sends no conversation with it,
   * and suppressing those would lose every failure such a server reports.
   *
   * And the first-turn exception this hook applies everywhere else: a pane with
   * no id of its own, still waiting to learn one for a run it started, owns the
   * event that names it. Without that a reloaded first turn's failure would be
   * silently swallowed — the error is stamped with an id this side does not
   * learn until the ack it already knows is lost. `awaitingFirstTurnRef` is
   * what separates that from the multi-resume state, where the pane refused to
   * claim any conversation and a background failure really is not its business.
   */
  const showsErrorFor = useCallback((cid?: string) => {
    if (!cid) return true;
    const current = activeConversationId();
    return current ? cid === current : awaitingFirstTurnRef.current;
  }, []);

  const finishWithoutAck = useCallback((cid?: string, reportedByResume = false) => {
    // WHICH runs this ending covers, decided before anything is cleared.
    //
    // A KEYED ending names one run; a report with no id ends every run this
    // pane is carrying, which is why it has no id to give. Treating them the
    // same wiped the whole set for a single conversation's `session:complete`,
    // so a sibling resumed run lost its origin — and then its own terminal
    // event was refused by the `ackLostRef` guards that had just been cleared
    // on its behalf. Its gates and its answer were never reconciled, and the
    // composer was free to start another run on top of it.
    const ended = cid ? [cid] : [...runOriginsRef.current.keys()];
    /**
     * And which of them this ending FINISHES, which is not the same list.
     *
     * A conversation can be carrying two runs. Settling on the first ending
     * took the second one's approvals, questionnaires and parked sections down
     * with it — the same "one ending speaks for a sibling" failure the origin
     * set was introduced to fix, one level in: scoped correctly BETWEEN
     * conversations and not at all WITHIN one. So the gates wait for the last
     * run on that conversation, and a conversation with one left is named here
     * without being settled.
     */
    const settled: string[] = [];
    if (cid) {
      // A keyed ending for a run this pane could not name is usually that run
      // naming ITSELF, at last — the terminal event carries the id
      // `active_conversations` could not. Without that the count never comes
      // down and `lastOneOut` never becomes true, which is this mechanism's own
      // failure inverted: the composer disabled forever rather than freed early.
      //
      // `reportedByResume` is the exception, and it is a fact rather than a
      // guess: a resume's `finished` entries are BY CONSTRUCTION not among its
      // active runs, so one of them can never be an unnamed live run naming
      // itself. Letting it discharge the count released the shared state — the
      // streaming bubble included — out from under a run that was still
      // writing its answer.
      const { had, last } = dropOrigin(runOriginsRef.current, cid);
      if (!had && !reportedByResume && unnamedRunsRef.current > 0) {
        unnamedRunsRef.current -= 1;
      }
      // Unrecorded means there is no sibling to wait for: nothing is saying
      // another run holds this conversation, so its gates are settled as they
      // always were. Only a live count can defer them.
      if (last || !had) settled.push(cid);
    } else {
      // A report with no id ends everything this pane carries, named or not,
      // so every conversation it was carrying is finished by definition.
      runOriginsRef.current.clear();
      unnamedRunsRef.current = 0;
      settled.push(...ended);
    }
    // The shared state belongs to ALL of them, so it is only safe to release
    // once the last one has ended. A keyed ending with siblings still running
    // leaves `busy` and the lost-ack flag exactly as they were.
    const lastOneOut = runOriginsRef.current.size === 0 && unnamedRunsRef.current === 0;
    if (lastOneOut) {
      ackLostRef.current = false;
      // Nothing is running, so there are no live runs to speak for. Left
      // behind, a dead run's name would filter out the tokens of the next one.
      knownRunsRef.current = [];
      setBusy(false);
      setStatus(null);
      setApproval(null);
      // Declaring the pane idle has to CANCEL a send that has not gone out
      // yet, not merely stop waiting for it. Otherwise the classifier's
      // continuation emits afterwards into a pane that has already cleared
      // `busy`, and the run it starts has no Stop button.
      //
      // And UNDO it: the optimistic turn was shown before the classifier ran,
      // so a cancelled send leaves it standing for a run that never happened.
      cancelPendingSend();
    }
    // NOT behind `lastOneOut`, unlike the four above. Those are properties of
    // the pane; a context approval is a question one RUN is waiting on, and
    // leaving the ended run's dialog up is not merely untidy — answering it
    // sends a decision that the sibling still waiting at its own context gate
    // would take as its own.
    // `settled` and not `ended`, for the reason `settled` exists: with two runs
    // on one conversation, the first to end must not take away the dialog the
    // second is still blocked on.
    setContextApprovals((q) => q.filter((a) => !settled.includes(a.conversationId ?? '')));
    // The streaming bubble is stitched from tokens that stopped arriving; the
    // persisted answer replaces it. Also only once the last run is out — a
    // sibling still streaming into this pane must not have its bubble taken
    // away by another conversation's ending.
    if (lastOneOut) setMessages((prev) => prev.filter((m) => !m.streaming));
    // Adopt the id as well as the transcript. On a first turn the client has
    // NO conversation id — the server creates it and the client learns it from
    // the ack, which is the one thing a reconnect is guaranteed to lose. Ending
    // the wait without it clears the spinner over an empty chat while the
    // answer sits on a conversation the page cannot name.
    // WHICH RUN ENDED and WHERE THE PANE SHOULD BE are two questions, and
    // `activeConversationId()` was answering the first with the second.
    //
    // A run can finish in the gap between its ack packet being lost and its
    // socket's `disconnect` landing. The server has already dropped it from
    // `activeRuns` by then, so it is never copied into `inFlight` and the
    // replacement socket reports `active: 0` with an EMPTY `finished` — no id
    // anywhere. Fall back to the pane and a user who moved to B has B's live
    // approvals, questionnaires and sections settled, B's transcript reloaded,
    // and A's answer never reconciled.
    // Before the early return, because the empty case needs it most: a first
    // turn whose ack was lost is holding gates naming a conversation this pane
    // never learned, and nothing later can reach them. `settleConversation`
    // takes no-id as a case rather than a reason to do nothing.
    if (ended.length === 0) { settleConversation(undefined); return; }
    for (const id of settled) settleConversation(id);
    // Adoption and the reload are the PANE's business, and a different question
    // from which runs ended. Only this pane's own conversation, and only when
    // it is one of the runs that just finished — `run:resumed`'s handler had
    // this guard at its call site and the other three endings did not, so a
    // terminal event for the run you walked away from could pull its transcript
    // into the chat you walked to. A blank pane adopts only when there is
    // exactly one candidate; with several there is nothing to pick.
    const mine = conversationIdRef.current;
    const show = mine
      ? (ended.includes(mine) ? mine : undefined)
      : (ended.length === 1 ? ended[0] : undefined);
    if (!show) return;
    pendingConversationIdRef.current = undefined;
    awaitingFirstTurnRef.current = false;
    conversationIdRef.current = show;
    setConversationId(show);
    // Every question this run was holding is over, whatever it was told —
    // approvals, questionnaires and parked sections alike, and all three by
    // conversation. The rule is `settleConversation`'s; restating any part of
    // it here is what let the escalation queue be emptied wholesale two lines
    // above while the clarification queue beside it was scoped correctly.
    //
    // Deliberately NOT done by replaying closure tombstones for a finished run,
    // which was the other way to fix this. A terminal run cannot still be
    // asking: teardown releases every pending gate, so "closed" is implied by
    // "done" and needs no per-id record to be trusted. Depending on the
    // tombstone set here would make correctness contingent on it — and it is
    // bounded at 32, so a run that asked more than that could evict the one id
    // that mattered and leave the dead form standing again.
    void reloadActivePath(show);
  }, [reloadActivePath, settleConversation, cancelPendingSend]);

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
      // Start a NEW viewing boundary rather than resuming the old one.
      //
      // The watch effect cannot do this: it keys on the socket object, which
      // survives a reconnect, so it never re-runs — and the server, having
      // received no unwatch, keeps streaming to the rebound transport as though
      // nothing happened. Nothing would then invalidate the receipt this view
      // gave before the gap. See `beginWatching` for why it is a PAIR.
      //
      // A page that reloaded rather than reconnected has no task id yet — it
      // learns it from the replayed live view, which lands after this — so
      // there is deliberately nothing to do here for that case. The watch
      // effect picks it up when the id arrives.
      const taskId = browserTaskIdRef.current;
      if (taskId) beginWatching(taskId);
    };
    const onResumed = (e: {
      active?: number;
      active_conversations?: string[];
      /** One entry per live run, including those whose conversation is unknown. */
      active_runs?: Array<{ runId?: string; conversationId?: string }>;
      finished?: Array<{ conversationId?: string; error?: string }>;
    }) => {
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
        // This pane is attached to a run whose conversation it cannot name —
        // the same position `send()` is in on a first turn, and armed for the
        // same reason. The server replays the run's live view and any pending
        // approval right after this, and those events are filtered by an exact
        // conversation match; without adoption a reload mid-first-turn would
        // discard the very state the replay exists to restore, leaving a page
        // attached to a run driving a real browser it cannot see or stop.
        //
        // Only when there is genuinely nothing to compare against. A pane that
        // already knows its conversation must keep matching on it.
        // Hoisted out of the block below, because the block asks "may this pane
        // ADOPT an id" and the origin asks "which run is on the wire". They are
        // not the same question and the guard belongs to only one of them.
        //
        // Taken from the resume itself rather than inferred from whichever
        // event happens to arrive next. The server replays this run's live view
        // and approval prompt immediately after this message, and those are
        // one-shot: a pane still guessing at its own id when they land filters
        // them out and never sees them again.
        const named = (e?.active_conversations ?? []).filter((id): id is string => typeof id === 'string');
        // A SEND THAT HAS NOT GONE OUT IS OVER, here as much as on the
        // `active: 0` path — and this branch is where it was missed.
        //
        // The successor of a tab collision is told `active: 0`, starts a send,
        // and while its classifier is still thinking the incumbent drops and
        // hands over its live run. So this branch runs with a pending send
        // underneath it. Left alone, the classifier's continuation then emits a
        // SECOND run and overwrites `runOriginsRef` — the inherited run loses
        // its origin and nothing will ever end it — and on a plan that allows
        // one run at a time the second is refused outright, whose ack clears
        // `busy` and the lost-ack flag over a run that is still going.
        //
        // The typed turn is taken back off screen with it, which is the honest
        // outcome: it was never sent, and there is no room to send it.
        cancelPendingSend();
        if (!conversationIdRef.current) {
          if (named.length > 1) {
            // Several runs came back at once, so this pane cannot know which of
            // them it is showing. Claim NOTHING: adopting the first id to
            // arrive would put another conversation's browser, and its Stop
            // button, in front of someone who never opened it.
            awaitingFirstTurnRef.current = false;
          } else {
            awaitingFirstTurnRef.current = true;
            // Exactly one: claim it outright. None named — an older server, or
            // a run whose id nothing knows yet — leaves adoption armed so the
            // first event that names itself can still be claimed.
            if (named.length === 1) pendingConversationIdRef.current = named[0];
          }
        }
        // This pane is carrying a run it did not start, so `runChat` never set
        // an origin for it — and the ending that needs one is exactly the
        // ack-less ending this branch exists for. Without it a resumed run
        // finishing in the gap that reports `active: 0` with an empty
        // `finished` settles nothing and reloads nothing: the answer is on disk
        // and the page never goes and gets it.
        //
        // THE RUN THE RESUME NAMED, ahead of whatever this pane is showing.
        // Reading the pane first was the same mistake in miniature that the
        // origin exists to fix: start A, move to B, reload, and the replacement
        // page has B on screen and A on the wire. `active_conversations` names
        // A and is the only thing here that does.
        //
        // With several named, only when this pane's own conversation is one of
        // them — then it is a fact rather than a guess. Otherwise nothing, on
        // the same rule the adoption block uses: several runs came back at once
        // and picking one would drop somebody else's conversation into this.
        //
        // Nothing named at all is an older server, and the pane's own id is
        // then the only thing available; it is right whenever this pane is the
        // one that started the run.
        // EVERY run the resume named, not a chosen one. Collapsing several to
        // the pane's own id made the ack-less ending settle that conversation
        // and clear the shared busy and ack-lost state, leaving the other runs'
        // gates standing with nothing left that would ever come back for them.
        //
        // Only when this pane is not already answerable for a run of its own —
        // the same reason the assignment was `??=`: a user who moved to another
        // chat would otherwise have a reconnect replace A's origin with B, the
        // exact bug the origin was introduced to fix.
        //
        // Nothing named at all is an older server, and the pane's own id is
        // then the only thing available; it is right whenever this pane is the
        // one that started the run.
        // RECONCILED, not merely seeded. Keeping the existing set whenever it
        // was non-empty meant a run that ended between the transport dying and
        // the server processing `disconnect` — absent from `active_conversations`
        // AND from `finished`, because it left `activeRuns` before either was
        // built — stayed in the set forever. Its sibling's ending then removed
        // only the sibling, the set never emptied, and the composer was busy
        // until reload.
        //
        // Replacing is safe where seeding was not: the danger this guard was
        // added for was the FALLBACK below overwriting a started run's origin
        // with whatever chat the user had opened. `named` is not a guess about
        // this pane — it is the server saying which runs are still going.
        //
        // TALLIED, not collapsed. `active_conversations` is built by mapping
        // over the runs, so a conversation carrying two of them appears twice
        // — and a set read that as one, which then made `active` disagree with
        // the origins by exactly the number of duplicates and turned the
        // difference into runs this pane supposedly could not name.
        // EXHAUSTIVE, when the server can be exhaustive.
        //
        // `active_runs` is one entry per run, including runs whose conversation
        // is not known yet — which `active_conversations` drops — so there is
        // nothing left to infer. The counting and the guessing below exist only
        // because the older field could not say these things, and where this
        // one is present they are simply not needed: the origins are whatever
        // it says, the unnamed count is the entries without a conversation, and
        // an EMPTY list is a statement too rather than a reason to keep what an
        // earlier resume happened to leave.
        //
        // Which is the whole of the stale-origin bug: a resume naming A beside
        // an unnamed B, with A gone by the next reconnect, reports `active: 1`
        // and names nobody — and A stayed in the map, so the unnamed count came
        // out as zero and B's own ending could discharge neither. The composer
        // was disabled for the life of the page.
        //
        // The pane's own in-flight run is in here too, by id, because the
        // client minted that id and sent it — so replacing wholesale no longer
        // throws away what this pane knows from having sent the run itself,
        // which is why the older path below still cannot replace unconditionally.
        const reportedRuns = Array.isArray(e?.active_runs) ? e.active_runs : undefined;
        if (reportedRuns) {
          runOriginsRef.current = tallyOrigins(
            reportedRuns.map((r) => r?.conversationId).filter((id): id is string => typeof id === 'string' && !!id),
          );
          // Exactly the runs it could not name, counted rather than derived
          // from a subtraction against `active`.
          unnamedRunsRef.current = reportedRuns.filter((r) => !r?.conversationId).length;
          // And which runs this pane could be showing: the ones on its own
          // conversation, plus the ones the server cannot place yet — a
          // first-turn run has no conversation anywhere until its first event,
          // and excluding it would leave the pane unable to name the very run
          // it is waiting on.
          //
          // Narrowed by conversation rather than taking "exactly one run in
          // total", which was the first version and was needlessly blind: two
          // runs in DIFFERENT chats left the pane unable to name either, so it
          // fell back to the conversation address for a case it could have
          // answered exactly.
          //
          // ATTRIBUTABLE, not merely compatible. Admitting runs the server
          // could not place — on the grounds that a first-turn run has no
          // conversation yet — pulled strangers in: with `active_runs` naming
          // this pane's run for A beside somebody's unattributed run B, both
          // landed here, and Stop names every candidate. So pressing Stop in A
          // aborted B, exactly, by id. That is worse than the loose address it
          // replaced, because a conversation filter would never have matched B.
          //
          // A pane that knows its conversation emitted its run WITH that id, so
          // the server knows it too — an unattributed run therefore cannot be
          // this pane's, and `!r.conversationId` was never evidence of anything.
          // The first-turn case it was reaching for is a pane with no
          // conversation at all, which is the other branch.
          //
          // A blank pane claims a run only when there is exactly one to claim,
          // the same non-guessing rule the conversation adoption above follows.
          // `!mine` used to short-circuit the whole filter, which made a blank
          // pane the owner of every live run on the connection.
          //
          // Runs left out are still COUNTED — the origins and the unnamed count
          // above are built from the whole list — so the pane stays busy and
          // reconciles correctly for work it cannot claim. Being carried and
          // being shown are different questions, and only the second one
          // decides what Stop may abort.
          // WHAT IS LIVE, recorded whole. Which of these the pane may speak for
          // is `shownRuns()`'s question and is answered on read, so navigating
          // afterwards changes the answer instead of leaving a stale one behind.
          //
          // `mine` is carried across for ids already known to be this pane's:
          // the server has no idea which runs a given page started, and a first
          // turn is reported with no conversation at all, so dropping the flag
          // here would make a blank pane stop recognising its own run.
          const wasMine = new Set(knownRunsRef.current.filter((r) => r.mine).map((r) => r.runId));
          knownRunsRef.current = reportedRuns
            .filter((r): r is { runId: string; conversationId?: string } => typeof r?.runId === 'string' && !!r.runId)
            .map((r) => ({
              runId: r.runId,
              ...(r.conversationId ? { conversationId: r.conversationId } : {}),
              ...(wasMine.has(r.runId) ? { mine: true as const } : {}),
            }));
        } else if (named.length > 0) {
          runOriginsRef.current = tallyOrigins(named);
        }
        // AND NOTHING WHEN NOTHING IS NAMED. There used to be a fallback here
        // that recorded the pane's own conversation as the origin of whatever
        // was running, on the grounds that an older server sends no
        // `active_conversations` and the pane's id is the only thing available.
        // It is available, but it is not an ANSWER: a pane sitting on
        // conversation A while the server carries a background run for B
        // recorded B's run under A's name, and A's gates were then settled by
        // B's ending — which is the exact bug the origin set exists to prevent,
        // reintroduced by the guess meant to cover for its absence.
        //
        // Nothing is lost by dropping it. A run this pane cannot name is
        // precisely what `unnamedRunsRef` counts: `liveButUnnamed` below takes
        // every run the report did not name, the pane stays busy and ack-lost
        // on the strength of that count, and the run's own terminal event —
        // which does carry an id — discharges it through `finishWithoutAck`.
        // A count that says "something is running" is right; a name that says
        // "and it is yours" was not.

        // AND THE ONES THAT FINISHED, which this branch used to return past.
        //
        // A resume reports both: `active` names what is still running and
        // `finished` names what ended during the gap, and a pane carrying two
        // runs can easily get one of each. Returning here left the finished
        // one in the set forever — and with the shared state now released only
        // when the LAST origin goes, "forever" is exactly the word: the
        // survivor's own ending removes only itself, the set never empties,
        // and `busy`, the lost-ack flag and the composer stay stuck for the
        // rest of the page's life.
        //
        // `finishWithoutAck` per entry, because that is what a keyed ending
        // means: settle that conversation's gates, take it out of the set, and
        // leave everything shared alone while a sibling is still running.
        // What `active` counted and the origin set cannot represent. Measured
        // against the SET rather than against `active_conversations`, because
        // the pane's own id may be standing in for an unnamed run above — that
        // is a guess about which run, and counting it twice would leave the
        // composer disabled forever when that run ends by name.
        //
        // Asserted BEFORE the finished entries are processed, because each of
        // them asks `finishWithoutAck` whether this was the last run out and
        // that answer is only right if the live ones are already counted.
        // `originCount`, not `size`: `active` counts RUNS and the map counts them
        // per conversation, so measuring against the number of conversations
        // over-reported the unnamed runs whenever two shared one.
        // The estimate, for a server that sends no `active_runs`. Where one
        // arrived the count above is a FACT and this must not overwrite it —
        // the subtraction is only ever an inference about what the older field
        // left out.
        const liveButUnnamed = () => (reportedRuns
          ? reportedRuns.filter((r) => !r?.conversationId).length
          : Math.max(0, (e?.active ?? 0) - originCount(runOriginsRef.current)));
        unnamedRunsRef.current = liveButUnnamed();
        // And AGAIN afterwards. `finishWithoutAck` treats a keyed ending for a
        // run not in the set as that run naming itself at last, which is right
        // between resumes and wrong here: a `finished` entry was never one of
        // the ACTIVE runs, so letting it discharge the count would free the
        // composer over the live run this exists to protect. The resume is the
        // authoritative statement of what is live, so it gets the last word
        // rather than an argument about which caller meant what.
        for (const done of e?.finished ?? []) {
          // SETTLED always, SHOWN only if it is this chat's. The rest of this
          // hook filters tokens, statuses and every gate by conversation, and
          // an error banner is the most conspicuous thing it has — putting a
          // background run's failure in front of someone watching a different
          // run succeed is worse than the missed notice, and with several
          // finished entries whichever came last simply won.
          if (done?.error && showsErrorFor(done.conversationId)) setError(done.error);
          if (!done?.conversationId) continue;
          // AND NOT AGAINST A LIVE SET THAT ALREADY EXCLUDES IT.
          //
          // `active_runs` is active-only and authoritative: it was just used to
          // build the origins wholesale, so a finished run is already absent
          // from them. Handing its conversation to `finishWithoutAck` anyway
          // removed an entry that belongs to a run still going — the two are
          // indistinguishable there, because the origins are keyed by
          // conversation and the finished list names one too.
          //
          // With A finished and B live on the SAME conversation that emptied
          // the map: the pane declared itself idle, cleared the lost-ack flag
          // that was B's only remaining way to end, and freed the composer to
          // start another run on top of a run that was still writing.
          //
          // So the live set decides. A conversation no live run holds is
          // settled exactly as before; one that is still held is left alone,
          // which also leaves its gates up — right for the same reason the
          // counting map leaves them up, since nothing distinguishes A's
          // questions from B's on a shared conversation.
          const stillLive = reportedRuns?.some((r) => r?.conversationId === done.conversationId);
          if (!stillLive) finishWithoutAck(done.conversationId, true);
        }
        unnamedRunsRef.current = liveButUnnamed();
        // Whatever the entries above did to the pane, at least one run is still
        // going — so it is still busy and its ack is still lost.
        if (unnamedRunsRef.current > 0 || runOriginsRef.current.size > 0) {
          ackLostRef.current = true;
          setBusy(true);
        }
        return;
      }
      // Nothing running. On a page that WAS running something, the block below
      // ends it. On a fresh mount there is no run of our own to end — but the
      // server may still be reporting one that finished while nobody was
      // connected, and that report is the only carrier of both the answer's
      // conversation id and any error. Returning here dropped it: a full reload
      // landing just after the run completed showed an empty chat, reloaded
      // nothing, and said nothing about a failure.
      if (!busyRef.current) {
        const finished = (e?.finished ?? []).filter((f) => f?.conversationId);
        // Exactly one, or nothing — the same non-guessing rule as
        // `active_conversations`. Several finished runs means this pane cannot
        // know which of them it is, and picking one would drop somebody else's
        // conversation into it.
        if (finished.length !== 1) return;
        const only = finished[0]!;
        // A pane already showing a conversation must not be yanked to another.
        const mine = conversationIdRef.current;
        if (mine && mine !== only.conversationId) return;
        if (only.error) setError(only.error);
        finishWithoutAck(only.conversationId);
        return;
      }
      // Nothing is running. The terminal event was emitted while no socket was
      // bound, so this is the only remaining carrier of BOTH the id — for a run
      // that was a brand-new chat — and the outcome. A run can fail during the
      // gap as easily as it can finish, and reporting only the id made the two
      // indistinguishable: the page cleared its spinner, reloaded a transcript
      // with no reply in it, and said nothing about why.
      //
      // EVERY entry, on the rule the active branch above already follows. This
      // picked ONE — the first that carried an error, or failing that the first
      // of them — and a pane carrying two runs gets two entries here as easily
      // as it gets one of each above. The chosen one was removed from the
      // origins and the other was left standing, so `lastOneOut` never became
      // true: the composer stayed disabled for the life of the page, over runs
      // the server had just reported as finished.
      //
      // And picking bypassed `showsErrorFor`, which is the only reason the
      // active branch consults it: a background run's failure was put in front
      // of somebody watching a different run, and preferring the entry WITH an
      // error made that the likely outcome rather than the unlucky one.
      for (const done of e?.finished ?? []) {
        if (done?.error && showsErrorFor(done.conversationId)) setError(done.error);
        if (done?.conversationId) finishWithoutAck(done.conversationId, true);
      }
      // Nothing is running, whatever those entries named — so whatever this
      // pane is still carrying ends here too, and an unkeyed ending is the only
      // thing that can discharge a run no report ever named. With the named
      // ones already gone this is usually the no-op that simply confirms the
      // release; when the report named nothing at all it is the whole of it.
      finishWithoutAck(undefined);
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
      // SETTLED always, SHOWN only when it is this chat's — the same rule the
      // resume's `finished` loop got, applied to the live path that was left
      // out of it. Two runs can be resumed together, and a background one
      // failing replaced the banner of the run the user was actually watching.
      //
      // An error naming no conversation is still shown: an older server sends
      // none, and suppressing those would lose every failure it reports.
      if (showsErrorFor(e?.conversationId)) {
        setError(e?.error ?? 'The run failed after the connection dropped.');
      }
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
  }, [socket, reloadActivePath, finishWithoutAck, beginWatching, cancelPendingSend]);

  // Watch the browser this pane is actually showing, and only that one.
  //
  // Driven from here rather than from the panel's own mount, because watching
  // costs the operator money: the server encodes and ships frames only while
  // somebody has asked for them, so a component that forgot to unwatch — on an
  // error boundary, a fast conversation switch, a StrictMode double-mount —
  // would quietly bill for a stream nobody is looking at. The condition is
  // exactly "this pane is showing this run's browser", which is what the panel
  // renders on, so the two cannot drift.
  useEffect(() => {
    if (!socket || !browserTaskId) return;
    // A PAIR, not a bare watch — see `beginWatching`. This is the path a
    // reloaded page takes: its socket is brand new but the run's screencast on
    // the server is not, having survived the previous page's disconnect
    // unwatched, so a bare watch here would land on a stream that only repaints
    // on activity and leave an idle page blank for the life of the run.
    beginWatching(browserTaskId);
    return () => {
      // The run may already be over, in which case the server ignores this —
      // but an unwatch that arrives late is free and a missing one is not.
      socket.emit('browser:unwatch', { taskId: browserTaskId });
    };
  }, [socket, browserTaskId, beginWatching]);

  /**
   * The generation this pane has already reported seeing.
   *
   * A ref, because it must not re-render and it must not be re-derived: it is a
   * record of something that happened, read on the way to deciding whether it
   * has happened again.
   */
  const shownGenRef = useRef<string | undefined>(undefined);

  /**
   * Tell the server this pane actually HAS the picture.
   *
   * Frames go out lossy — dropped, not queued, when the transport is not
   * writable — so handing one to the socket establishes nothing about what
   * arrived. Hiding the page is gated on this receipt rather than on that
   * dispatch, because the client the gate protects is an honest stale one whose
   * Hide is still wired to `streaming`: it never receives the frame, so it never
   * sends this, and its Hide stays refused.
   *
   * CALLED FROM THE IMAGE'S OWN `load`, not from an effect keyed on the frame
   * arriving. That distinction is round 9's argument one layer further down: an
   * effect fires when the JPEG enters React state, which proves the socket
   * delivered bytes and nothing about whether they became a picture. A slow
   * client, or one handed a frame it cannot decode, would confirm a page it has
   * never shown anybody — and the confirmation is what opens Hide and, with it,
   * the blind keyboard surface. `load` is the browser saying the image is ready
   * to paint, which is the closest thing to "seen" that a client can honestly
   * report. A frame that fails to decode fires nothing, no receipt is sent, and
   * the surface stays shut: the right way to fail.
   *
   * Still once per watch, not per frame — the generation is the watch's, and
   * the ref above is what keeps a stream of repaints from becoming a stream of
   * round trips. It gates Hide only and never Chrome's own frame ack, so the
   * stream stays exactly as lossy and as fast as it was.
   */
  const markBrowserFrameShown = useCallback((taskId: string, generation: number) => {
    // The image that loaded names the task it came from. If the pane switched
    // while that JPEG was decoding, its receipt is stale and must not be
    // retargeted at the browser that happens to be current now.
    if (!socket || browserTaskIdRef.current !== taskId) return;
    // Keyed by TASK as well as generation. A watch generation counts from zero
    // inside its own run, so the first watch of every run is generation 1 —
    // and deduplicating on the number alone meant that after confirming task A
    // the identical number from task B was read as "already reported". B's
    // receipt was never sent, and because a generation holds still for the life
    // of a watch, nothing later would send it either: B could stream frames
    // indefinitely while the server held `confirmed` false and went on refusing
    // Hide. The bug arrived with the ref — the effect this replaced had the
    // task in its dependencies and could not make it.
    const seen = `${taskId}:${generation}`;
    if (shownGenRef.current === seen) return;
    shownGenRef.current = seen;
    socket.emit('browser:frame-seen', { taskId, generation });
  }, [socket]);

  // Connect only now, and deliberately LAST.
  //
  // The socket is created with `autoConnect: false` precisely so this line
  // decides when it opens. The server sends `run:resumed` the instant it
  // accepts a connection, and the held run's live view and pending approval
  // immediately behind it — all one-shot. Every handler that consumes them is
  // attached by the effects above, and effects run in declaration order, so by
  // the time this one fires there is nothing left to miss.
  //
  // Reconnections need no equivalent: socket.io reconnects on its own, long
  // after these listeners exist.
  useEffect(() => {
    if (socket && !socket.connected) socket.connect();
  }, [socket]);

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
      // Claimed before anything is shown, so every path out of this function
      // is covered by it — including the classifier continuation below, which
      // runs a turn later and is the reason this exists.
      const thisSend = Symbol('send');
      // AND ITS NAME, minted here rather than asked for.
      //
      // The client chooses it so the run has an address from the instant it
      // starts: a server-assigned id would arrive in a message, and Stop
      // pressed before that message lands would have nothing to say. It is
      // only ever looked up within this connection's own runs, so choosing it
      // here addresses nothing that is not already this pane's.
      const thisRunId = crypto.randomUUID();
      // `transcriptBeforeSend` is captured above, before any optimistic change,
      // and is exactly what the frame-size refusal already restores.
      pendingSendRef.current = {
        token: thisSend,
        restore: transcriptBeforeSend,
        conversationId: conversationIdRef.current,
        armedFirstTurn: awaitingFirstTurnRef.current,
      };
      setBusy(true);
      setError(null);
      setStatus('Sizing up the task…');
      // A fast answer cannot drive a browser, so the chip must stop saying it
      // will. Withholding `browserMode` from the payload — which is what the
      // last round did — fixed the RUN and left the CLAIM: the state stayed
      // true, so `Composer` kept rendering Browser as pressed for the whole
      // tool-less run, which is the visible-capability mismatch the payload
      // guard was meant to end.
      //
      // Cleared rather than suppressed for display, on the same reading as the
      // `controlsVisible` effect above: a billed capability the run will not
      // grant is not granted, and a control that shows otherwise is the bug.
      // The payload keeps its own ternary regardless — this setter does not
      // reach the `browserMode` already captured in this closure.
      if (fast) setBrowserModeRaw(false);
      setApproval(null);
      // This chat's own question only. A background conversation's context gate
      // is not resolved by somebody typing in a different chat.
      setContextApprovals((q) => q.filter((a) => (a.conversationId ?? '') !== (conversationIdRef.current ?? '')));
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
        // The send may have been settled while the classifier was thinking —
        // by a reconnect that found no run, or by Stop. Emitting now would put
        // a run on the wire that this pane has already told itself is over.
        if (pendingSendRef.current?.token !== thisSend) return;
        const payload = {
            conversationId,
            runId: thisRunId,
            prompt: text,
            providers,
            attachmentIds: attachments?.map((a) => a.id),
            skillId,
            routingMode,
            forceTier,
            webSearch,
            // Never alongside a fast answer. `runFastAnswer` is one model call
            // with no tools by contract, so `browser_control` is never
            // registered — sending both would bill nothing and silently answer
            // from the model's own knowledge a question that needed a page.
            //
            // The chip is dealt with at the top of this function, because the
            // two halves are separate: `setBrowserModeRaw` cannot change the
            // `browserMode` this closure already captured, and clearing the
            // state cannot un-send a payload. Both are needed for the run and
            // the composer to be making the same claim.
            browserMode: fast ? false : browserMode,
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
          // THROUGH `cancelPendingSend`, not a restore of its own.
          //
          // This is the same cancellation as Stop and the reconnect, reached
          // through a third door, and it had its own copy of half the rule: it
          // put the transcript back unconditionally — into whatever chat the
          // pane had moved to while the classifier was thinking — and left
          // first-turn adoption armed for a run that was never sent. Both are
          // `cancelPendingSend`'s job, and stating them here again is exactly
          // how the two drifted apart.
          //
          // Which is also why the send is claimed BELOW this rather than above
          // it: a refusal has to leave the marker in place for this call to
          // find. There is no await between the token check and the emit, so
          // nothing can slip in and send twice in the meantime.
          cancelPendingSend();
          return;
        }
        // Claimed: from here the send goes out, and it is no longer waiting to
        // be emitted.
        pendingSendRef.current = undefined;
        // WHICH CONVERSATION THIS RUN IS FOR, recorded HERE — immediately
        // before the emit, and after every local refusal above it.
        //
        // It used to be set at the top of `runChat`, which meant a send the
        // frame-size check rejected still left an origin behind: nothing was
        // emitted, nothing would ever end, and the next run inherited through a
        // reconnect found the ref occupied — so an ack-less ending settled the
        // conversation of a send that never happened.
        //
        // Empty on a first turn; adoption fills it in when the server's id
        // arrives. Replaces whatever a resume left, because this pane starting
        // a run makes that run the one it is answerable for.
        //
        // FROM THE PAYLOAD, not from the ref. `emitRun` can run a turn later
        // than `runChat` — the on-device classifier is awaited first when it is
        // enabled — and the payload was built with the conversation captured at
        // send time. Reading the live ref here meant a user who opened another
        // chat while classification was pending sent a run for A and recorded
        // an origin of B, so the ending settled B's gates and left A's
        // standing. The id that goes on the wire is the id this run is for.
        // The run this pane is now showing, by name. Replaces whatever a resume
        // left for the same reason the origin does: this pane starting a run
        // makes that run the one it is answerable for.
        knownRunsRef.current = [{
          runId: thisRunId,
          ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
          // THIS PANE'S OWN, which nothing else can tell. On a first turn the
          // run has no conversation on either side, so without this a blank
          // pane could not distinguish the run it just started from a
          // stranger's and would refuse to stop its own work.
          mine: true,
        }];
        runOriginsRef.current = tallyOrigins(payload.conversationId ? [payload.conversationId] : []);
        // This pane starting a run replaces whatever a resume left, including
        // its count of runs it could not name.
        unnamedRunsRef.current = payload.conversationId ? 0 : 1;
        socket.emit('chat:run', payload, onAck);
      };

      const onAck = (ack: ChatRunAck) => {
          // The ack did arrive, so the reconnect fallback must not fire later.
          ackLostRef.current = false;
          // Read once and retired, for both branches below: the run is over
          // whichever way this ack goes, and a leftover origin would let the
          // `??=` in `run:resumed` mistake it for an inherited run's.
          const origins = [...runOriginsRef.current.keys()];
          runOriginsRef.current = new Map();
          knownRunsRef.current = [];
          unnamedRunsRef.current = 0;
          setBusy(false);
          setStatus(null);
          setApproval(null);
          // Scoped like the rest of this gate family: the ack belongs to the
          // run this pane emitted, and only its question is over.
          setContextApprovals((q) => q.filter((a) => !origins.includes(a.conversationId ?? '')
            && (a.conversationId ?? '') !== (ack.conversationId ?? '\u0000none')));
          // A parked question is stale the moment its run ends — its buttons
          // would emit into a run that has already finished. Chat.stop() is the
          // case that made this visible (the server aborts the controller
          // WITHOUT disconnecting, the SDK settles the gate as 'skip', and the
          // run acknowledges normally), but the same is true of every ending.
          //
          // Both endings below reach `settleConversation`, which is where that
          // now happens and which takes all three gates down TOGETHER and BY
          // CONVERSATION. It used to be an unconditional `setEscalations([])`
          // here: one socket carries concurrent runs, so this conversation
          // finishing erased another one's live section without ever sending a
          // decision for it.
          if (ack.error) {
            setError(ack.error);
            setMessages((prev) => prev.filter((m) => !m.streaming));
            // The same ending as below, and it has to be done BEFORE the early
            // return rather than after it. A failed run is still a finished
            // one: leaving adoption armed lets a later event from somewhere
            // else name this pane, and leaving the approvals queued keeps a
            // dangerous-tool prompt on screen for a run that has already
            // stopped asking. `session:error` does not cover this — it
            // deliberately ignores errors while the ack is still reachable,
            // which is exactly the case here.
            // The run's own origin, never `activeConversationId()` — that is
            // the navigated-away case, and settling the wrong conversation is
            // worse than settling none. Undefined stays handled:
            // `settleConversation` then drops only the unanswerable unkeyed
            // entries, and the server announces every gate it releases at
            // teardown, so nothing is left holding a dead control either way.
            const failed = ack.conversationId ? [ack.conversationId] : origins;
            pendingConversationIdRef.current = undefined;
            awaitingFirstTurnRef.current = false;
            if (failed.length === 0) settleConversation(undefined);
            for (const id of failed) settleConversation(id);
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
          //
          // No `?? activeConversationId()` fallback here, unlike the error path
          // above, and the asymmetry is the ack shapes rather than an
          // oversight: a success ack is a `ChatRunResult`, whose
          // `conversationId` is a non-optional string, while an error ack is
          // `{ error }` and carries no id at all. A fallback here would be dead
          // code — and if the id really were missing, `setConversationId` on the
          // line above would already have emptied the pane.
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
    [socket, busy, conversationId, providers, skillId, routingMode, forceTier, webSearch, browserMode, webSearchConfig, messages, reloadActivePath, cancelPendingSend],
  );

  const send = useCallback((input: SendInput) => runChat(input.prompt, input.attachments, true, input.fast), [runChat]);

  // Ask the server to abort the in-flight run. The run still resolves (with
  // whatever completed), so the normal ack path finalises the message; we just
  // reflect "stopping" until it lands.
  const stop = useCallback(() => {
    if (!socket || !busy) return;
    // Nothing has been sent yet — the classifier is still thinking — so there
    // is no run for the server to abort and no ack coming back to finalise
    // this. Cancel it here, or Stop would emit into the void and leave the
    // composer disabled until the continuation started the very run the user
    // just asked not to happen. Not reported; the same window as the
    // reconnect case above, through the other door.
    if (pendingSendRef.current) {
      cancelPendingSend();
      setBusy(false);
      setStatus(null);
      return;
    }
    // WHICH run to stop, because one socket carries several of them.
    //
    // Unkeyed, this aborted every run on the connection: a user watching one
    // chat finish pressed Stop and killed a background run in another, which
    // then acked with its partial output as though that were the answer. The
    // Stop button belongs to the chat it is rendered in, so it says so.
    //
    // The pane's own conversation is the right key even mid-first-turn:
    // `adoptConversationId` learns the id from the first event that carries
    // one, well before the ack. Only the window before that event has no id to
    // send — and there the server falls back to stopping everything, which is
    // what this did unconditionally until now.
    // THE RUNS THIS PANE IS SHOWING, by name — all of them, which is what one
    // Stop button in one chat can honestly mean.
    //
    // Naming a single run and falling back to the conversation when the pane
    // could not pick was the wrong shape: the fallback is the address that
    // matches both runs, so Stop went back to killing the sibling in exactly
    // the case the run id was added for. Sending the candidates instead keeps
    // it precise whether there is one or several — the user asked to stop what
    // is running HERE, and these are those runs, named.
    //
    // The conversation still goes for a server that predates this: it reads
    // that field and ignores this one, which is the behaviour it had.
    socket.emit('chat:stop', {
      ...((): { runIds?: string[] } => { const ids = shownRuns(); return ids.length > 0 ? { runIds: ids } : {}; })(),
      conversationId: activeConversationId(),
    });
    setStatus('Stopping…');
  }, [socket, busy, cancelPendingSend]);

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
  const clearEscalation = useCallback((key?: string) => setEscalations((prev) => (
    // BY KEY now that several are on screen at once. Dropping the first was
    // right when only the first was visible; with all of them rendered, an
    // older section's expiry would have taken down whichever happened to be
    // first — quite possibly the one being answered.
    key === undefined ? prev.slice(1) : prev.filter((x) => escalationKey(x) !== key)
  )), []);

  const resolveEscalation = useCallback(
    (action: 'retry' | 'skip' | 'guidance', note?: string, key?: string) => {
      if (!socket) return;
      // Answers the section NAMED, not the one that happens to be first.
      // Several can be parked at once and all of them are now on screen, so
      // routing by position would apply one section's decision to another —
      // and a guidance note meant for different work is worse than no answer.
      const target = key === undefined ? escalations[0] : escalations.find((x) => escalationKey(x) === key);
      if (!target) return;
      socket.emit('escalation:decide', {
        conversationId: target.conversationId,
        ...(target.requestId ? { requestId: target.requestId } : {}),
        action,
        ...(note ? { note } : {}),
      });
      setEscalations((prev) => prev.filter((x) => escalationKey(x) !== escalationKey(target)));
      setStatus(action === 'skip' ? 'Skipping section…' : 'Retrying section…');
    },
    [socket, escalations],
  );

  /**
   * Close the window on every parked section at once.
   *
   * Dismissing meant 'skip' when one prompt was visible, for the reason that
   * comment gives: the run is parked, so closing without an answer just waits
   * out the timeout and fails the section anyway. That reasoning applies to
   * each of them, so it is applied to each of them rather than to whichever
   * was on top.
   */
  const skipAllEscalations = useCallback(() => {
    if (!socket) return;
    // `escalations`, not `allEscalations` — only what the window actually
    // showed. Closing a window is a statement about the sections in it, and
    // skipping a background conversation's work on the strength of it would
    // silently accept partial output in a run nobody was looking at.
    for (const e of escalations) {
      socket.emit('escalation:decide', {
        conversationId: e.conversationId,
        ...(e.requestId ? { requestId: e.requestId } : {}),
        action: 'skip',
      });
    }
    // Removed BY KEY, for the same reason the loop above is filtered — and the
    // half of it that was missed. Emitting only for the window's own sections
    // while clearing the whole queue is worse than not filtering at all: the
    // background conversation's request is gone from this client with no
    // decision ever sent for it, so nothing can bring it back and nothing
    // answers it. It stays parked on the server until its deadline and then
    // fails the section — the exact outcome the filter was added to prevent.
    const dismissed = new Set(escalations.map(escalationKey));
    setEscalations((prev) => prev.filter((x) => !dismissed.has(escalationKey(x))));
    if (escalations.length > 0) setStatus('Skipping section…');
  }, [socket, escalations]);

  // Answer the extended-context confirm: proceed with (or skip) compacting the
  // oversized input. Either way the run continues — skip just means the model
  // handles the raw input (truncating naturally).
  const resolveContextApproval = useCallback((approved: boolean, target?: ContextApprovalInfo) => {
    // NAMED, so the server can tell whose decision this is. It used to go out
    // bare, which was survivable only while one run could be waiting at a time:
    // with two resumed together, answering a dialog left over from the run that
    // ended was consumed by the one still waiting, and the user's "no" to a
    // finished run compacted a live one.
    // WHICH ONE, because there can be several and they are each a different
    // run's question. Defaulting to the first keeps the single-dialog callers
    // working; passing one answers exactly that run.
    const answering = target ?? contextApprovals[0];
    if (!answering) return;
    const cid = answering.conversationId ?? activeConversationId();
    // THE RUN when the question named one. Two runs in one conversation both
    // registered a decision handler and a conversation-addressed answer
    // satisfied both, so one Approve resolved both gates — and compacted a run
    // nobody had said yes to.
    socket?.emit('context:decision', {
      approved,
      ...(answering.runId ? { runId: answering.runId } : {}),
      ...(cid ? { conversationId: cid } : {}),
    });
    // Only the one that was answered. Clearing the queue would displace a
    // sibling's question exactly as the single slot did.
    setContextApprovals((q) => q.filter((a) => a !== answering));
  }, [socket, contextApprovals]);

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
    routingMode, setRoutingMode, forceTier, setForceTier, webSearch, setWebSearch, browserMode, setBrowserMode, approval,
    escalation, escalations, escalationQueued: escalations.length, resolveEscalation, clearEscalation,
    skipAllEscalations,
    contextApproval, contextApprovals, resolveContextApproval, compactionNotice, providerNotice, knowledgeNotice, activity,
    browserLiveView, browserActive, browserTaskId, browserFrame, browserStreaming,
    browserHuman, browserCapturing, browserConfirmed, browserNotice, stopBrowser,
    takeOverBrowser, handBackBrowser, sendBrowserInput, setBrowserCapture,
    markBrowserFrameShown,
    toolApprovals, resolveToolApproval, clarifications, answerClarification,
  };
}
