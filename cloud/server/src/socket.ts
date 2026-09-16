// ─────────────────────────────────────────────
//  Cascade Cloud Server — Socket.IO wiring
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { ZodError } from 'zod';
import { parseCookies, verifySessionToken, SESSION_COOKIE_NAME } from './auth/session.js';
import type { CloudEnv } from './env.js';
import type { CloudStore } from './db.js';
import { formatZodError, parseChatRunPayload, runChatTurn, type ChatRunResult, type RunSocket } from './runs.js';

interface CloudSocketData {
  userId: string;
  /**
   * Stable per-TAB id supplied by the client handshake.
   *
   * The session cookie identifies the account, which is not enough to decide
   * who may inherit a held run — see resumeKey(). Absent for any client that
   * does not send one, which simply makes that connection non-resumable.
   */
  clientId?: string;
}

type ChatRunAck = (
  res:
    | {
        conversationId: string;
        output: string;
        costUsd: number;
        totalTokens: number;
        tier: string | null;
        model: string | null;
        savedUsd: number;
        savedPct: number;
        cancelled: boolean;
      }
    | { error: string },
) => void;

/**
 * How long a dropped connection's runs are held before being abandoned.
 *
 * A multi-tier run takes minutes, and for every one of those minutes a single
 * dropped websocket frame used to end it: `disconnect` aborted the run outright,
 * and Socket.IO fires that on a missed heartbeat, a proxy idle-timeout, or any
 * transient network blip — not only on a closed tab. The client reconnects
 * (`reconnection: true`), but it reconnects as a NEW socket, so nothing brought
 * the run back; the user saw a run that simply died while their page sat there
 * connected. Reported as "I tried stopping it, navigating away, and leaving it
 * to run, and in all three cases the response just died" — three different
 * actions collapsing onto this one abort.
 *
 * Holding the run is safe because the answer does not depend on the socket:
 * `runChatTurn` persists the assistant message via `store.addMessage` BEFORE it
 * emits anything, so a run allowed to finish is readable on the conversation
 * whether or not the emit lands. Aborting is what threw the answer away.
 *
 * The window is bounded so a genuinely-gone client still stops the spend, and
 * per-user concurrency/quota in entitlements.ts is unchanged.
 */
const RECONNECT_GRACE_MS = 90_000;

/**
 * A run's transport, decoupled from the connection that started it.
 *
 * `runChatTurn` needs exactly three things from a socket — `emit`, `on`, `off`
 * — which is why `RunSocket` in runs.ts names that surface instead of taking
 * socket.io's `Socket`. Handing it one of these rather than the raw socket is
 * what lets a run outlive the connection that began it: on reconnect the
 * transport is re-pointed and every later emit, plus the client-answer
 * listeners for `context:decision` and `escalation:decide`, follow the user to
 * the new socket.
 *
 * Listeners are tracked rather than merely forwarded because rebinding has to
 * move them: a listener registered on the old socket is dead weight once that
 * socket is gone, and the interactive gates are precisely the case where the
 * server is waiting on an answer only the CURRENT page can give.
 *
 * Emits with no current socket are dropped, which is the pre-existing
 * behaviour for a disconnected client and is safe for the same reason holding
 * the run is: `runChatTurn` persists the assistant message before it emits
 * anything, so the answer is on the conversation either way.
 */
export class RebindableTransport implements RunSocket {
  private current: Socket | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  private readonly observe: (event: string, payload: unknown) => void;
  /**
   * WHICH RUN everything sent through here belongs to.
   *
   * Stamped at the transport rather than at each emit site, because the number
   * of emit sites is the problem: `runs.ts` adds `conversationId` to roughly
   * thirty of them by hand, and a run identity added the same way would be
   * missing from whichever one was written next. Here it cannot be forgotten —
   * every event a run emits passes through this method, by construction.
   *
   * A FUNCTION rather than a value, because the run's own record is built
   * around this transport: the id is read at emit time, so construction order
   * does not decide whether the stamp is there.
   */
  private readonly runId: () => string | undefined;

  constructor(
    socket: Socket,
    observe: (event: string, payload: unknown) => void = () => {},
    runId: () => string | undefined = () => undefined,
  ) {
    this.current = socket;
    this.observe = observe;
    this.runId = runId;
  }

  emit(event: string, payload: unknown): unknown {
    // Stamped BEFORE it is observed, so the replay store holds what the client
    // would have received — a replayed gate has to be answerable, and answering
    // it now means naming the run.
    //
    // UNDER whatever the payload says, not over it: a caller that names a run
    // explicitly is describing something this transport cannot know better.
    const id = this.runId();
    const stamped = id !== undefined && payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { runId: id, ...(payload as Record<string, unknown>) }
      : payload;
    // Observed BEFORE delivery, and whether or not anything is bound. A run
    // that ends while its socket is gone emits into nothing, so this is the
    // only moment its outcome exists anywhere.
    this.observe(event, stamped);
    return this.current?.emit(event, stamped);
  }

  /**
   * The same transport, on Socket.IO's lossy channel.
   *
   * A GETTER rather than a field captured at construction, because `current`
   * changes: a run outlives the connection that started it, and a volatile
   * emitter frozen to the original socket would write into a dead one after a
   * reconnect. Resolving `current` per emit is what makes this follow `rebind`.
   *
   * Deliberately NOT observed. `observe` feeds the replay store, and the only
   * thing sent this way is a frame — which must never be replayed: handing a
   * reloaded page a picture from before it reloaded is the stale-picture
   * failure the panel exists to prevent. A dropped volatile emit is also, by
   * definition, not state anyone is entitled to get back.
   *
   * With no socket bound the frame is dropped, which is the correct answer for
   * a live view during a reconnect gap: by the time anyone could see it, it
   * would be a picture of a page that has moved on.
   */
  get volatile(): { emit(event: string, payload: unknown): unknown } {
    return { emit: (event, payload) => this.current?.volatile.emit(event, payload) };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
    return this.current?.on(event, listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): unknown {
    this.listeners.get(event)?.delete(listener);
    return this.current?.off(event, listener);
  }

  /** Point this run at a different connection, or at none. */
  rebind(next: Socket | null): void {
    for (const [event, set] of this.listeners) {
      for (const listener of set) {
        this.current?.off(event, listener);
        next?.on(event, listener);
      }
    }
    this.current = next;
  }
}

/**
 * One in-flight run: how to abort it, how to talk to it, and whether it is over.
 *
 * `done` exists because a finished run is still referenced by whichever set it
 * was in when it completed, and parking or adopting one is never right.
 */
export interface LiveRun {
  controller: AbortController;
  transport: RebindableTransport;
  done: boolean;
  /**
   * WHICH RUN this is — the identity a conversation cannot supply.
   *
   * One connection carries several runs and two of them can belong to the same
   * conversation, so addressing by conversation was ambiguous exactly where it
   * mattered: `chat:stop` aborted both, and a context decision answered both
   * gates. Taken from the client's `chat:run` payload when it sent one, so the
   * client can name its run from the instant it starts it rather than waiting
   * for a message to tell it; generated here otherwise, so the field is never
   * absent and the replay and resume paths never have to ask.
   */
  runId: string;
  /**
   * Which conversation this run belongs to, once anything knows.
   *
   * On a NEW chat the client has no id at all until the ack tells it — and the
   * ack is exactly what a reconnect loses. So the id is recorded here as soon
   * as it exists (from the payload for an existing conversation, from the
   * result for a new one) and handed to the replacement connection, which
   * otherwise has no way to name the conversation whose answer it should load.
   */
  conversationId?: string;
  /**
   * The last browser control state that a reloaded page still needs to know.
   *
   * Human ownership is one such state, but not the only one: after handback a
   * deliberately hidden picture can remain paused until the agent's next action
   * restores it. Dropping that `capturing: false` state lets a reload expose a
   * provider iframe while the CDP stream is still intentionally dark.
   */
  control?: Record<string, unknown>;
  /**
   * The supervision surface a replacement connection has to be given back.
   *
   * These two events are what make the hosted browser safe to run at all: the
   * live view is how the user sees what the agent is doing, and the approval
   * prompt is how they consent to a dangerous action. Both are ONE-SHOT — they
   * are emitted when the state changes and never again — and the client holds
   * them in React state, which a page reload throws away.
   *
   * A run survives a reload; that is the whole point of holding it. But the UI
   * that came back had no live view, no task id and therefore no browser Stop,
   * while the agent kept driving a real browser. Worse with "Allow for this
   * run": the escalator caches that decision task-wide, so subsequent actions
   * never prompt again — an agent browsing on, with the one page that could
   * see or halt it now blind.
   *
   * So the last state of each is retained here and replayed on rebind. Held on
   * the run, not the connection, because the connection is the thing that just
   * went away.
   */
  liveView?: Record<string, unknown>;
  /** Outstanding approval requests, by request id, in the order they arrived. */
  approvals?: Map<string, Record<string, unknown>>;
  /**
   * How the run actually ended, captured from its own terminal event.
   *
   * Recording only the successful result was not enough: `runChatTurn` can
   * create and persist a conversation and THEN fail, emitting `session:error`
   * and throwing. With the transport unbound that event reached nobody, the
   * success assignment was never made, and the held entry ended up
   * indistinguishable from a clean completion — so a reconnect cleared the
   * spinner, surfaced no error, and for a new chat had no id to reload either.
   * Which is the original "the response just died", one disconnect later.
   */
  /**
   * Questionnaires that have ENDED, so a reconnecting page can drop their forms.
   *
   * A reload needs only the open set; a reconnect keeps whatever it had on
   * screen, and nothing in an open-only replay can remove a form the page is
   * still showing. Bounded — see `MAX_REMEMBERED_CLOSURES`.
   */
  clarificationsClosed?: Set<string>;
  /**
   * Questionnaires still waiting on a person, keyed by request id.
   *
   * Same shape as `approvals`, and for the same reason: both are the run
   * BLOCKED on somebody, and a reload that loses them leaves the person
   * looking at a spinner for something nobody will ever be asked.
   */
  clarifications?: Map<string, { payload: Record<string, unknown>; askedAt: number }>;
  /**
   * Sections parked on a decision, keyed by request id.
   *
   * The same shape and the same reason as `clarifications`. This gate was the
   * one the clarification gate was modelled on, and it is the one that never
   * got the replay: a reload while a section was parked left the run alive on
   * the server and the modal gone from the page, with no way to answer until
   * the five-minute timer failed the section.
   */
  escalations?: Map<string, { payload: Record<string, unknown>; askedAt: number }>;
  escalationsClosed?: Set<string>;
  /**
   * The extended-context confirmation this run is blocked on, if it is.
   *
   * ONE SLOT, unlike the three keyed maps above, because the gate itself is one
   * slot: `Cascade.pendingContextApproval` holds a single callback, so a run can
   * only ever be asking this question once. There is no request id to key by
   * either — the conversation is the whole of the answer's address.
   *
   * It is the only gate that was not replayed, and the consequence was not a
   * missing dialog: the SDK's gate resolves TRUE on its two-minute timeout, so
   * a page that reloaded while the question was up could not answer it and the
   * run went ahead and compacted anyway. The user was asked before the money
   * was spent, and then it was spent without them.
   */
  contextApproval?: Record<string, unknown>;
  /**
   * Or its ENDING, when that is the last thing that happened to it.
   *
   * A tombstone for the same reason the questionnaire gate has a set of them:
   * a transient reconnect keeps whatever the page had on screen, so an
   * open-only replay can put a dialog up and never take one down — and the
   * question that was answered while the transport was unbound would sit there
   * with buttons that reach a gate which is already gone.
   *
   * One slot rather than a bounded set, because the gate is one slot. The two
   * fields are mutually exclusive by construction: each write clears the other.
   */
  contextApprovalClosed?: Record<string, unknown>;
  terminal?: { conversationId?: string; error?: string };
}

/**
 * How many ended questionnaires a run remembers for a reconnecting page.
 *
 * `ask_user` asks at most five questions per call, and a run makes few calls,
 * so this is far above the honest case — it exists so a long run cannot grow
 * this set without bound, not to ration anything.
 */
const MAX_REMEMBERED_CLOSURES = 32;

/** The events that mean a run is over, in either direction. */
const TERMINAL_EVENTS = new Set(['session:complete', 'session:error']);

/**
 * Keep the run's supervision surface up to date as it is emitted.
 *
 * Only state that remains relevant is kept. In particular, a paused picture is
 * still relevant after human ownership ends: until the agent restores capture,
 * a reloaded client must keep every viewing surface dark too.
 */
export function rememberForReplay(run: LiveRun, event: string, payload: unknown): void {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (event === 'browser:live-view') {
    // `active: false` is the run giving the browser up. Dropping the entry
    // rather than storing it also drops the live-view URL, which is a bearer
    // capability and has no business outliving the session it opens.
    if (p['active'] === true) {
      run.liveView = p;
    } else {
      delete run.liveView;
      // And with it every control state. Neither a takeover nor a hidden
      // handback can outlive the browser they refer to.
      delete run.control;
    }
    return;
  }
  if (event === 'browser:control') {
    // Only a statement of current state is worth keeping. A message carrying
    // just a detail describes a moment that has already passed — replaying
    // "that key cannot be sent" into a fresh page is noise about something the
    // person did before they reloaded.
    if (typeof p['human'] !== 'boolean') return;
    // Never recreate control state after the browser was withdrawn. Teardown
    // normally emits ownership before live-view withdrawal, but replay state
    // should not depend on that ordering remaining true forever.
    if (!run.liveView) {
      delete run.control;
      return;
    }
    // Human ownership must survive reload. So must a hidden picture after
    // handback/lapse: `human: false` is the client default, but
    // `capturing: false` is not — losing it would remount the provider iframe
    // while the user-requested pause is still in force. Once capture is really
    // restored (`human: false, capturing: true`) both fields are defaults and
    // there is nothing useful to replay.
    //
    // Stored WITHOUT `confirmed`, whatever it said. That flag is per-watch,
    // and a replay is by definition arriving at a new one. Carrying the old
    // watch's answer over would hand the fresh viewer a blind keyboard for a
    // page it has not been shown.
    if (p['human'] === true || p['capturing'] === false) {
      run.control = { ...p, confirmed: false };
    } else {
      delete run.control;
    }
    return;
  }
  // A question outstanding when the connection dropped.
  //
  // I argued against replaying these, on the grounds that nothing could clear
  // the record: the ANSWER arrives on the socket rather than as an emit, so
  // this function would never see it, and a question replayed after it was
  // answered is worse than one lost. `clarification:closed` removed that
  // objection — it is emitted for every ending, including the answered one, so
  // the record now has a reliable delete.
  //
  // Which also fixes the reverse case: a close emitted while the transport had
  // no socket was simply dropped, leaving a dead form on screen after
  // reconnection — and because the queue renders oldest-first, in front of
  // every later question the run asks.
  if (event === 'escalation:decision-required') {
    const id = p['requestId'];
    if (typeof id !== 'string') return;
    (run.escalations ??= new Map()).set(id, { payload: p, askedAt: Date.now() });
    return;
  }
  if (event === 'escalation:closed') {
    const id = p['requestId'];
    if (typeof id !== 'string') return;
    run.escalations?.delete(id);
    // Remembered as well as removed, for the reason the clarification
    // tombstones are: a reconnecting page keeps what it had on screen, so
    // absence from an open-only replay cannot take a dead modal down.
    const closed = (run.escalationsClosed ??= new Set());
    closed.add(id);
    while (closed.size > MAX_REMEMBERED_CLOSURES) {
      const oldest = closed.values().next();
      if (oldest.done) break;
      closed.delete(oldest.value);
    }
    return;
  }
  if (event === 'clarification:required') {
    const id = p['requestId'];
    if (typeof id !== 'string') return;
    // WHEN it was asked, not only what was asked. The gate is two minutes and
    // the payload states that flatly, so replaying it unchanged would hand a
    // reconnecting page a fresh two minutes while the server's timer kept
    // running — the countdown would read a minute and a half remaining on a
    // question about to be given up on.
    (run.clarifications ??= new Map()).set(id, { payload: p, askedAt: Date.now() });
    return;
  }
  if (event === 'clarification:closed') {
    const id = p['requestId'];
    if (typeof id !== 'string') return;
    run.clarifications?.delete(id);
    // Remembered as well as removed, because replay has to be able to take a
    // form DOWN and not only put one up.
    //
    // A full page reload starts with no forms, so the open set alone is right
    // for it. A transient socket reconnect does not: the page keeps what it had,
    // so a question that closed while the transport was unbound is invisible to
    // an open-only replay — absence cannot remove anything — and the dead form
    // stays, in front of every later question.
    //
    // Bounded, because a long run can ask many questions and this must not grow
    // without limit. Oldest first: the ones most likely to still be on a screen
    // are the recent ones.
    const closed = (run.clarificationsClosed ??= new Set());
    closed.add(id);
    while (closed.size > MAX_REMEMBERED_CLOSURES) {
      const oldest = closed.values().next();
      if (oldest.done) break;
      closed.delete(oldest.value);
    }
    return;
  }
  // The extended-context confirmation, which has no request id to key by — see
  // `contextApproval`. A plain slot and a plain clear, with the clear coming
  // from `context:approval-closed`: the answer arrives as an inbound socket
  // message this function never sees, exactly as it does for the questionnaire
  // gate, so the closure event is what makes the record safe to keep at all.
  if (event === 'context:approval-required') {
    run.contextApproval = p;
    delete run.contextApprovalClosed;
    return;
  }
  if (event === 'context:approval-closed') {
    delete run.contextApproval;
    run.contextApprovalClosed = p;
    return;
  }
  if (event === 'permission:user-required') {
    const id = p['id'] ?? p['requestId'];
    if (typeof id !== 'string') return;
    (run.approvals ??= new Map()).set(id, p);
    return;
  }
  if (event === 'permission:resolved') {
    const id = p['requestId'];
    if (typeof id === 'string') run.approvals?.delete(id);
  }
}

/**
 * Tell a connection what it owns, and only THEN hand back the state.
 *
 * The order is the contract, which is why it is a function rather than two
 * statements that happen to be adjacent. `replaySupervision` used to run inside
 * `adopt()`, long before `run:resumed` went out — and the client cannot
 * attribute a replayed event until it knows it is holding a resumed run. On a
 * first-turn reload it has no conversation id of its own, so the live view and
 * the approval prompt arrived unattributable, were filtered out as belonging to
 * some other chat, and never came again: they are one-shot. The page then sat
 * attached to a run whose agent was still driving a browser, showing neither
 * the view nor the Stop button — worst of all after "Allow for this run", where
 * the escalator has cached the decision and will never prompt again.
 */
export function resumeAndReplay(
  socket: Pick<Socket, 'emit'>,
  resumed: Record<string, unknown>,
  adopted: readonly LiveRun[],
): void {
  socket.emit('run:resumed', resumed);
  for (const run of adopted) replaySupervision(run, socket);
}

/** Give a replacement connection back the state the reloaded page lost. */
/**
 * The same question, with the time it has actually got left.
 *
 * Adjusted HERE, in server time, rather than by shipping an absolute deadline
 * for the client to subtract from its own clock: the two clocks disagree, and
 * a page whose clock runs a few minutes fast would show a question as already
 * expired. The client keeps the arrival-stamp arithmetic it already uses for
 * escalations, and this makes the number it is handed true at the moment of
 * replay.
 *
 * Clamped at zero rather than dropped. A question this late is about to be
 * closed by the gate's own timer, and `clarification:closed` is what takes the
 * form down — withholding it here would leave the page unable to show what the
 * run is still blocked on in the seconds before that arrives.
 */
function remainingDeadline(
  payload: Record<string, unknown>,
  askedAt: number,
): Record<string, unknown> {
  const stated = payload['timeoutMs'];
  if (typeof stated !== 'number' || !Number.isFinite(stated)) return payload;
  return { ...payload, timeoutMs: Math.max(0, stated - (Date.now() - askedAt)) };
}

export function replaySupervision(run: LiveRun, socket: Pick<Socket, 'emit'>): void {
  if (run.done) return;
  if (run.liveView) socket.emit('browser:live-view', run.liveView);
  // AFTER the live view, and that ordering is load-bearing rather than tidy:
  // the client files control state against the browser entry for the run, and
  // drops a control message for a run it has no entry for. Replayed first, it
  // would be discarded and the reloaded page would come back believing the
  // agent still had a browser the person was actually holding.
  if (run.control) socket.emit('browser:control', run.control);
  for (const request of run.approvals?.values() ?? []) {
    socket.emit('permission:user-required', request);
  }
  // The parked sections, same ordering rule as the questions below: a closure
  // can take a dead modal down, and an open-only replay could only ever add.
  for (const requestId of run.escalationsClosed ?? []) {
    socket.emit('escalation:closed', { requestId });
  }
  for (const { payload, askedAt } of run.escalations?.values() ?? []) {
    socket.emit('escalation:decision-required', remainingDeadline(payload, askedAt));
  }
  // Closures BEFORE openings, so a page that reconnects mid-question ends up
  // showing exactly what is still being asked: the dead ones come down first,
  // and anything genuinely open is put back after.
  for (const requestId of run.clarificationsClosed ?? []) {
    socket.emit('clarification:closed', { requestId });
  }
  // Still open, so still blocking the run: a reloaded page that never sees the
  // question waits out the full gate before the model gives up and assumes.
  for (const { payload, askedAt } of run.clarifications?.values() ?? []) {
    socket.emit('clarification:required', remainingDeadline(payload, askedAt));
  }
  // Closure before opening, the same ordering rule the two gates above follow
  // — though here the two are mutually exclusive, so exactly one of them ever
  // fires. A page that kept the dialog through a transient reconnect gets it
  // taken down; a page that reloaded gets it put back.
  if (run.contextApprovalClosed) socket.emit('context:approval-closed', run.contextApprovalClosed);
  if (run.contextApproval) socket.emit('context:approval-required', run.contextApproval);
}

export interface SocketOptions {
  /** Overridable for tests, which cannot wait out the real grace window. */
  reconnectGraceMs?: number;
  /** Overridable for tests. See OWNER_PROBE_MS. */
  /** Accepted and ignored; kept so existing callers do not break. */
  ownerProbeMs?: number;
}

export function attachSocket(
  httpServer: HttpServer,
  env: CloudEnv,
  store: CloudStore,
  options: SocketOptions = {},
): SocketIOServer {
  const graceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  void options.ownerProbeMs;
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    // Images travel over REST (POST /api/uploads), so run payloads stay small;
    // a modest ceiling keeps a malformed/oversized frame from exhausting memory.
    maxHttpBufferSize: 2 * 1024 * 1024,
    // Socket.IO's default is 20s, which a busy run can miss: the heartbeat is
    // answered on the event loop, and aggregating a large multi-section result
    // blocks it for longer than that. A missed pong then "disconnects" a client
    // that never went anywhere. 60s is well inside any sane proxy idle timeout
    // while leaving room for a stalled tick.
    pingTimeout: 60_000,
  });

  /**
   * Runs whose socket dropped, awaiting a reconnect. Keyed by userId because a
   * reconnect arrives as a new socket — the old socket id is gone, and the user
   * is the only identity that survives the gap. Scoped to this server instance
   * so tests attaching several do not share state.
   */
  const orphanedRuns = new Map<string, { runs: Set<LiveRun>; timer: NodeJS.Timeout }>();
  // Keys are `${userId}\u0000${clientId}` — see resumeKey() for why the tab has
  // to be part of it.

  /**
   * The socket currently answering for each resume key.
   *
   * Adoption alone is edge-triggered — it happens when a connection is created
   * and never again — which loses a run to pure event ordering. A client that
   * reconnects fast enough for its NEW socket to be accepted before the old
   * one's `disconnect` is processed found nothing held (there was nothing to
   * hold yet, so it was told `active: 0`), and the old socket then parked its
   * run under a key somebody was already connected on. Nobody was left to
   * rebind it and it sat transport-less until the grace timer aborted it — the
   * run dying on a reconnect that worked, which is the bug this whole path
   * exists to remove.
   *
   * Tracking the live owner closes it: a disconnect that is no longer the owner
   * hands its runs straight to whoever is, instead of parking them.
   *
   * This assumes one live socket per key, which is the client's job to
   * guarantee — see `claimClientId` in cloud/web/src/lib/client-id.ts, where a
   * duplicated tab (session storage is COPIED into a tab opened from another)
   * detects the collision and rotates to a fresh id.
   */
  const owners = new Map<string, {
    socket: Socket;
    adopt: (run: LiveRun) => void;
    /** Hand over the supervision state owed for runs adopted since the last flush. */
    flushReplay: () => void;
    /** Give up every live run, so the taker owns them outright. */
    release: () => LiveRun[];
    /** Live runs, left where they are — see `successors`. */
    peek: () => LiveRun[];
  }>();

  io.use((socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    const session = token ? verifySessionToken(token, env.SESSION_SECRET) : null;
    if (!session) { next(new Error('unauthorized')); return; }
    (socket.data as CloudSocketData).userId = session.userId;
    // Which TAB this is, not just which account. See resumeKey().
    const claimed = (socket.handshake.auth as { clientId?: unknown } | undefined)?.clientId;
    (socket.data as CloudSocketData).clientId =
      typeof claimed === 'string' && claimed.length > 0 && claimed.length <= 128 ? claimed : undefined;
    next();
  });

  /**
   * Who may inherit a held run.
   *
   * Keyed by user AND tab, because "the same account connected" is not "the
   * client came back". A user can have several tabs open, and Pro allows three
   * concurrent runs; with a user-only key the FIRST socket to arrive adopted
   * every held run for that account. Tab A drops mid-run, tab B reconnects or
   * refreshes first, and B inherits A's transport — A's tokens, statuses and
   * approval prompts then render in B's chat (no client handler filters on
   * conversationId), and B's Stop aborts a run it never started, while A is
   * told `active: 0` and gives up on its own run.
   *
   * A connection that claims no tab identity is not resumable at all: its runs
   * are aborted on disconnect exactly as they were before any of this existed.
   * Silently falling back to the account would restore the cross-tab bug for
   * precisely the clients that cannot prove which tab they are.
   */
  const resumeKey = (socket: Socket): string | undefined => {
    const { userId, clientId } = socket.data as CloudSocketData;
    return clientId ? `${userId}\u0000${clientId}` : undefined;
  };

  /**
   * A connection waiting to inherit a key it was not allowed to take.
   *
   * Ownership moves on DISCONNECT and on nothing else. When a second live
   * socket arrives on a key, it is given an identity of its own rather than
   * the incumbent's work — but the incumbent may also be a client whose
   * transport is already dead and whose `disconnect` is merely queued behind
   * this connection. Recording the newcomer here covers that ordering: when
   * the incumbent does go, its runs go to the socket that was waiting instead
   * of being parked under a key nobody will ask for again.
   */
  const successors = new Map<string, {
    socket: Socket;
    adopt: (run: LiveRun) => void;
    /** Re-announce what this connection owns, once it has inherited. */
    announce: () => void;
    /**
     * Whether this connection is already running something of its own.
     *
     * A successor is told `active: 0` when it is renamed, so its page is idle
     * and free to start work — and on Pro it may. Handing it a second run then
     * puts two on one socket, which the client cannot represent: it has a
     * single `busy` flag, a single lost-ack flag, and socket-wide stream and
     * status handlers. Whichever run finished first would settle the other's
     * state, and Stop would abort both.
     */
    busy: () => boolean;
    /**
     * The incumbent's runs AS THEY WERE at the moment of the collision.
     *
     * Succession is scoped to these and nothing else. An open-ended claim on a
     * key makes a renamed duplicate a generic future owner of it: the
     * incumbent could disconnect idle, reconnect, start entirely new work,
     * drop again, and that work would land in a tab which has been sitting
     * there since a collision minutes earlier.
     */
    runs: Set<LiveRun>;
  }>();

  io.on('connection', (socket: Socket) => {
    const userId = (socket.data as CloudSocketData).userId;

    // In-flight runs on THIS connection, so `chat:stop` (and a disconnect) can
    // abort them — otherwise a runaway run keeps burning the budget with no way
    // to halt it. Concurrency and daily quota are still enforced per-user inside
    // runChatTurn via entitlements.ts.
    const activeRuns = new Set<LiveRun>();

    /**
     * Decide whether this socket is the client coming back — and act on it.
     *
     * Deferred rather than done inline because it can require ASKING the
     * incumbent. Every handler below is registered synchronously first, so a
     * client that starts a run immediately is served normally while this
     * settles.
     */
    // Who this connection is, and what it may take.
    //
    // Ownership moves on DISCONNECT and on nothing else. Two sockets both
    // reporting connected are two live clients — that much is decidable — and
    // the newcomer is therefore given an identity of its own rather than the
    // incumbent's work.
    //
    // What is NOT decidable is whether a connection that has stopped answering
    // is gone. Two earlier versions of this tried to decide it anyway: a 50ms
    // BroadcastChannel claim in the browser, then a 750ms acknowledged probe
    // here. Both are the same mistake at different addresses — a finite wait
    // standing in for a fact. A live tab whose main thread is blocked, or which
    // the browser has frozen in the background, answers late and would have had
    // its run taken; and a probe cannot be un-answered once the transfer is
    // made. socket.io already decides this properly, with the transport and its
    // own ping timeout, and reports it as `disconnect`. So that is the only
    // signal trusted here.
    //
    // The cost is one ordering: an incumbent whose transport is already dead
    // but whose `disconnect` is queued behind this connection still looks
    // connected. `successors` covers exactly that — see its declaration.
    let key = resumeKey(socket);
    let assignedClientId: string | undefined;
    /** The key this socket is queued to inherit, if it was renamed. */
    let successorFor: string | undefined;

    /**
     * Runs adopted by this connection whose supervision state is still owed.
     *
     * Queued rather than replayed on the spot: the client has to be told it
     * holds a resumed run BEFORE that run's live view and approval prompt
     * arrive, or it has nothing to attribute them to. Drained by
     * `flushReplay`, which every path that adopts is responsible for calling
     * once it has announced.
     */
    const pendingReplay: LiveRun[] = [];
    const adopt = (run: LiveRun): void => {
      run.transport.rebind(socket);
      activeRuns.add(run);
      // Queued after the rebind, so when it does go out it goes to the
      // connection that took the run over rather than the one that dropped it.
      pendingReplay.push(run);
    };
    const flushReplay = (): void => {
      const owed = pendingReplay.splice(0);
      for (const run of owed) replaySupervision(run, socket);
    };

    if (key) {
      const incumbent = owners.get(key);
      if (incumbent && incumbent.socket !== socket) {
        if (incumbent.socket.connected) {
          // A second live client on one identity — session storage is copied
          // into a duplicated tab, so this is ordinary. It takes nothing, gets
          // an id of its own so its OWN runs can never be pooled with the
          // incumbent's, and waits in case the incumbent turns out to be on
          // its way out after all.
          successorFor = key;
          successors.set(key, {
            socket,
            adopt,
            // Succession must be VISIBLE. A socket told `active: 0` has, quite
            // correctly, concluded nothing is running for it — including the
            // flag that says its ack is lost — so a run injected silently
            // afterwards streams into a page that will discard its own
            // completion as a stray duplicate. Re-announcing is what turns an
            // inheritance into something the client can act on.
            announce: () => announceResume(),
            // Only what the incumbent held at THIS moment. Anything it starts
            // later belongs to whatever connection is around for it.
            runs: new Set(incumbent.peek()),
            busy: () => [...activeRuns].some((r) => !r.done),
          });
          assignedClientId = randomUUID();
          (socket.data as CloudSocketData).clientId = assignedClientId;
          key = resumeKey(socket);
        } else {
          // Already gone, just not yet reaped. This is the client coming back.
          for (const run of incumbent.release()) adopt(run);
        }
      }
    }

    if (key) {
      owners.set(key, {
        socket,
        adopt,
        flushReplay,
        release: () => {
          const live = [...activeRuns].filter((r) => !r.done);
          for (const run of live) activeRuns.delete(run);
          return live;
        },
        peek: () => [...activeRuns].filter((r) => !r.done),
      });
    }

    // Whatever was held for this key survives — a reconnect is the client
    // saying it still wants the result. Adopting is the whole point, and
    // clearing the timer is only half of it: the runs move INTO this
    // connection's `activeRuns` and their transports are re-pointed here.
    const held = key ? orphanedRuns.get(key) : undefined;
    if (held && key) {
      clearTimeout(held.timer);
      orphanedRuns.delete(key);
      for (const run of held.runs) {
        if (run.done) continue;
        adopt(run);
      }
    }

    socket.on('chat:run', async (payload: unknown, ack?: ChatRunAck) => {
      // The run holds a transport, not this socket. Same structural surface
      // (`RunSocket` in runs.ts — emit plus on/off), so runChatTurn is
      // unchanged; the difference is that it can be re-pointed at whatever
      // connection the user currently has.
      const run: LiveRun = {
        controller: new AbortController(),
        runId: randomUUID(),
        transport: new RebindableTransport(socket, (event, payload) => {
          // Captured on the way out, whether or not anything is listening —
          // which is the point: the events worth replaying are exactly the ones
          // a disconnected or reloading client missed.
          rememberForReplay(run, event, payload);
          const p = (payload ?? {}) as { conversationId?: string; error?: string };
          // AS SOON AS ANYTHING SAYS SO, not only at the end. Every event a run
          // emits carries the conversation it belongs to, and on a new chat the
          // first of them is the earliest moment the id exists at all — it is
          // how the client learns it too, long before the ack.
          //
          // Recorded from the terminal event only, a live first-turn run was
          // nameless for its whole duration: absent from `active_conversations`,
          // so a reconnecting page could not claim it, and indistinguishable
          // from another chat's run when a keyed `chat:stop` arrived.
          if (p.conversationId) run.conversationId = p.conversationId;
          if (!TERMINAL_EVENTS.has(event)) return;
          run.terminal = { conversationId: p.conversationId, error: p.error };
        }, () => run.runId),
        done: false,
      };
      activeRuns.add(run);
      try {
        const parsed = parseChatRunPayload(payload);
        // THE CLIENT'S NAME FOR THIS RUN, when it sent one.
        //
        // Taken rather than assigned back, because the client needs the name
        // from the instant it starts the run: a server-assigned id would arrive
        // in a message, and a Stop pressed before that message lands would have
        // nothing to say. The generated id above stands for clients that send
        // none, so the field is never absent.
        //
        // It addresses nothing outside this connection — every use is a lookup
        // in this socket's own `activeRuns` — so the worst a client can do by
        // choosing it, including choosing one it has already used, is address
        // its own runs.
        if (parsed.runId) run.runId = parsed.runId;
        // Known now for an existing conversation; only the result knows it for
        // a new one. Recorded at both points because a run can be orphaned
        // before it ever reaches the second.
        run.conversationId = parsed.conversationId;
        const result: ChatRunResult = await runChatTurn(parsed, {
          env, store, userId, socket: run.transport, signal: run.controller.signal,
        });
        run.conversationId = result.conversationId;
        ack?.(result);
      } catch (err) {
        const message = err instanceof ZodError ? formatZodError(err) : err instanceof Error ? err.message : String(err);
        ack?.({ error: message });
      } finally {
        // Marked done BEFORE leaving the set: a disconnect racing this must not
        // park a finished run, or the grace timer fires 90s later against a
        // controller nobody is waiting on and a reconnect adopts a corpse.
        run.done = true;
        activeRuns.delete(run);
        run.transport.rebind(null);
      }
    });

    // Stop the run the client named, or every run in flight on this connection
    // when it names none. The run resolves with its partial output, which still
    // gets persisted and acked normally.
    //
    // This used to abort them all, unconditionally. One connection carries
    // several runs — that is the whole premise of `activeRuns` being a set —
    // so a Stop pressed in one chat aborted a background run in another, which
    // then acked with whatever it had produced as though that were its answer.
    // Nothing told the user their other run had been killed.
    //
    // A run the server cannot yet NAME is still aborted either way. Its
    // conversation id arrives with its first event, which is a moment or two
    // into the run; before that there is nothing to compare against, and
    // refusing to stop it would make Stop do nothing at the very start of a
    // turn — a worse failure than the over-abort this replaces, and the one a
    // user is most likely to hit. Older clients send no payload at all and get
    // exactly the previous behaviour.
    socket.on('chat:stop', (payload?: unknown) => {
      const asked = (payload ?? {}) as { conversationId?: unknown; runIds?: unknown };
      // A LIST, because one Stop button in one chat can honestly mean several
      // runs: two of them can share the conversation on screen, and the client
      // has no way to offer a choice between them. Naming them is still exact —
      // it is the conversation fallback that was not.
      const askedRuns = Array.isArray(asked.runIds)
        ? asked.runIds.filter((id): id is string => typeof id === 'string' && !!id)
        : [];
      const only = typeof asked.conversationId === 'string' && asked.conversationId
        ? asked.conversationId
        : undefined;
      // THE RUN, when the client named one — and nothing else, not even as a
      // fallback. Scoping by conversation was still ambiguous where it counts:
      // two runs in one chat both matched, so Stop aborted the background one
      // as well and it acked with its partial output as though that were its
      // answer. A run id is the only address that distinguishes them.
      //
      // A named run that is not here is a run that already ended. Aborting
      // everything else instead would be the original bug wearing the fix's
      // clothes, so a miss stops nothing.
      if (askedRuns.length > 0) {
        const wanted = new Set(askedRuns);
        for (const r of activeRuns) if (wanted.has(r.runId)) r.controller.abort();
        return;
      }
      for (const r of activeRuns) {
        if (only && r.conversationId && r.conversationId !== only) continue;
        r.controller.abort();
      }
    });

    // Connection lost. That is NOT the same as "the user left": a missed
    // heartbeat, a proxy timeout, or a network blip fires this too, and the
    // client is already reconnecting. Hold the runs for the grace window and
    // abort only if nobody comes back — see RECONNECT_GRACE_MS.
    socket.on('disconnect', () => {
      const parkKey = resumeKey(socket);

      // Release ownership FIRST, on every disconnect — including the idle one
      // that owns no runs at all.
      //
      // Releasing it only on the run-carrying path left a dead socket named as
      // the owner of a key forever, and the handover below trusts that name: a
      // later disconnect would rebind a live run onto a closed socket and
      // return without arming a grace timer, so the run went on spending with
      // nothing attached and nothing able to stop it. The rotation path makes
      // that ordinary rather than exotic — a duplicated tab connects on the
      // copied id, rotates, and drops that first socket having run nothing.
      //
      // Guarded on still being the owner, so an older socket leaving does not
      // evict the replacement that has already taken the key.
      const wasOwner = !!parkKey && owners.get(parkKey)?.socket === socket;
      if (parkKey && wasOwner) owners.delete(parkKey);
      // Stop waiting to inherit a key this connection will never use.
      if (successorFor && successors.get(successorFor)?.socket === socket) successors.delete(successorFor);

      const inFlight = [...activeRuns].filter((r) => !r.done);
      activeRuns.clear();
      // Nothing more may be written to a socket that is gone; the listeners go
      // with it, and both come back on adoption.
      for (const r of inFlight) r.transport.rebind(null);

      // The owner leaving ends any claim on its key, runs or no runs. Skipping
      // this on the idle path left a renamed duplicate queued indefinitely,
      // free to inherit work started by a connection that arrived long after
      // the collision it was waiting on.
      const successorClaim = parkKey && wasOwner ? successors.get(parkKey) : undefined;
      if (parkKey && wasOwner) successors.delete(parkKey);

      if (inFlight.length === 0) return;

      // No tab identity means nothing can ever prove it is this client coming
      // back, so there is nobody to hold the run FOR. Abort now rather than
      // spend for 90 seconds on an answer no connection can claim.
      if (!parkKey) {
        for (const r of inFlight) r.controller.abort();
        return;
      }

      // Someone else is here for this key: either a replacement that connected
      // before this disconnect was processed, or a socket that was renamed off
      // this key and queued to inherit it. Hand the runs over rather than
      // parking them under a key nobody will look up again — but only to a
      // connection that is actually still there.
      //
      // The successor is what makes "ownership moves only on disconnect" work
      // in the one ordering it otherwise loses: a client whose transport is
      // already dead still reports connected while its `disconnect` is queued,
      // so the returning socket was renamed rather than recognised. It gets the
      // runs here, when the truth is finally known.
      const owner = owners.get(parkKey);
      if (owner && owner.socket !== socket && owner.socket.connected) {
        for (const r of inFlight) owner.adopt(r);
        // That connection is already established and already knows which
        // conversation it is on, so its replay is owed immediately — there is
        // no `run:resumed` coming for it to wait behind, and an undrained queue
        // would strand the live view and the approval prompt for good.
        owner.flushReplay();
        return;
      }

      // A socket renamed off this key may inherit — but only the runs it was
      // told about, and only if it is told again. Anything outside that set
      // parks as usual.
      // A successor that has since started work of its own is no longer a
      // place to put another run — the run parks instead, and the client that
      // owns it can still come back for it inside the grace window.
      const waiting = wasOwner ? successorClaim : undefined;
      if (waiting && waiting.socket !== socket && waiting.socket.connected && !waiting.busy()) {
        const inherited = inFlight.filter((r) => waiting.runs.has(r));
        for (const r of inherited) waiting.adopt(r);
        if (inherited.length) waiting.announce();
        const rest = inFlight.filter((r) => !waiting.runs.has(r));
        if (rest.length === 0) return;
        inFlight.length = 0;
        inFlight.push(...rest);
      }

      // A second disconnect while the first is still held must not drop the
      // first set on the floor: merge, and restart the clock from the latest.
      const existing = orphanedRuns.get(parkKey);
      if (existing) clearTimeout(existing.timer);
      const runs = existing?.runs ?? new Set<LiveRun>();
      for (const r of inFlight) runs.add(r);

      const timer = setTimeout(() => {
        orphanedRuns.delete(parkKey);
        for (const r of runs) r.controller.abort();
      }, graceMs);
      // Never hold the process open for a grace window: a shutting-down server
      // should exit, and the abort is pointless once it has.
      timer.unref?.();
      orphanedRuns.set(parkKey, { runs, timer });
    });

    // Ownership was settled synchronously above, before any handler could run,
    // so there is no window in which this connection's identity is unknown.
    // `chat:run` creating work under a key still being decided is how a
    // duplicate's OWN run could be handed to the incumbent it was colliding
    // with; there is no such window to exploit now.
    /** Tell this page what it owns, and who it is. */
    const announceResume = (assigned?: string): void => {
    //
    // `active` is true at the moment it is sent because the runs have already
    // moved — a count of a transfer that has not happened is a promise the
    // server cannot keep, and an under-report is worse still, since the client
    // treats no-active-runs as terminal and clears the flag saying its ack is
    // lost, discarding the real completion later as a duplicate.
    //
    // `finished` carries the conversation of a run that ended while nobody was
    // connected: its terminal event went to the void, and on a first turn that
    // id existed only in the ack this path already knows is gone.
    //
    // `clientId` appears only when this connection was renamed for colliding
    // with a live one. The client persists it, so the collision does not recur
    // on its next reload.
      resumeAndReplay(socket, {
        active: activeRuns.size,
        finished: [...(held?.runs ?? [])]
          .filter((r) => r.done)
          .map((r) => ({ conversationId: r.terminal?.conversationId ?? r.conversationId, error: r.terminal?.error })),
        // The conversations of the runs still going. A reloaded first-turn page
        // has no id of its own — the ack that would have carried it is exactly
        // what the reload lost — so without this it cannot name the run it is
        // now holding, and cannot claim the state replayed for it below.
        active_conversations: [...activeRuns].filter((r) => !r.done)
          .map((r) => r.conversationId).filter((id): id is string => !!id),
        // The same runs, named as RUNS — which `active_conversations` cannot
        // do. It drops those whose conversation is not known yet and collapses
        // nothing when two share one, so a client reading it has to reconstruct
        // the count from `active` and guess at the difference. This is
        // exhaustive and one entry per run, so there is nothing left to infer:
        // a run with no conversation still appears, by id.
        //
        // Alongside rather than instead of, because an older client reads only
        // the other field and a newer one must still work against a server that
        // sends only the other field.
        active_runs: [...activeRuns].filter((r) => !r.done)
          .map((r) => ({ runId: r.runId, ...(r.conversationId ? { conversationId: r.conversationId } : {}) })),
        ...(assigned ? { clientId: assigned } : {}),
      }, pendingReplay.splice(0));
    };

    announceResume(assignedClientId);
  });

  return io;
}
