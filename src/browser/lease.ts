// ─────────────────────────────────────────────
//  Cascade AI — Who owns the browser right now
// ─────────────────────────────────────────────
//
//  Extracted from the desktop host so the web surface can use it rather than
//  grow a second copy. It reached its current shape over four rounds of review,
//  and every rule below is here because the version without it was wrong in a
//  way that corrupted a run. A reimplementation would rediscover those the hard
//  way, in a place where the browser is somebody else's and costs money.
//
//  The shape, in one paragraph. There is ONE browser and any number of workers.
//  A worker takes the lease and holds it across its WHOLE sequence — not one
//  action — because `navigate → fill → click` released between steps lets
//  another worker navigate away and land your fill on its page: every action
//  serialized, the outcome still wrong. The lease is keyed by ACTOR rather than
//  by run, because every T3 worker in a run shares the run's task id and a
//  run-keyed lease hands the same lease to all of them at once. It is released
//  by the worker's own terminal signal, never by a timer, because any fixed
//  bound is one a healthy worker exceeds — a worker waiting on a human approval
//  has ten minutes by default. Everyone else queues.

/**
 * Why an actor did not get the browser.
 *
 * A boolean was not enough: "the queue is full, try again" and "your run was
 * stopped" are different things to tell a model, and a waiter dropped because
 * the capability was switched off is neither. Reporting all three as "busy"
 * had a model politely retrying something that would never be granted.
 */
export type LeaseResult = 'granted' | 'busy' | 'cancelled' | 'off' | 'human';

/**
 * The actor id a human takeover holds the lease under.
 *
 * A person is an ACTOR, not a mode flag, because everything the lease already
 * knows how to do — serialize, refuse, hand on, drop with the run — is exactly
 * what a takeover needs, and a parallel `humanHasIt` boolean beside `actor`
 * would be a second answer to "who owns the browser" that can disagree with the
 * first. Prefixed and underscored so it cannot collide with a worker id, which
 * is derived from the run and the worker index.
 */
export const HUMAN_ACTOR = '__human__';

/**
 * How long a human hold survives with no input at all.
 *
 * A person is not a worker: there is no terminal signal when someone closes the
 * tab, walks away, or loses their connection mid-takeover, so the one rule that
 * makes timers wrong for workers — a healthy holder outlasts any bound — does
 * not hold here. And the hold is expensive: a browser session is billed while
 * it exists and, at the default `maxSessions: 1`, one abandoned takeover blocks
 * every other run on the deployment. Two minutes is long enough to read a page
 * and type a password, short enough that a forgotten tab is not an outage.
 */
const HUMAN_IDLE_MS = 120_000;

interface Waiter {
  actorId: string;
  sessionId: string;
  settle: (result: LeaseResult) => void;
}

/**
 * Defensive deadlock ceiling — NOT the sequence boundary.
 *
 * Only ever armed for a host that does NOT report worker terminal states. Where
 * one does, no timer decides ownership at all: a worker waiting on a human
 * approval gets 600s by default and a local generation 300s, both configurable
 * far higher, so any bound short enough to be a useful safety net is also short
 * enough to fire during normal work and hand the page away from a live worker.
 */
const LEASE_DEADLOCK_CEILING_MS = 300_000;
/** How long a queued actor waits, for hosts without lifecycle release. */
const QUEUE_WAIT_MS = 180_000;
/** Waiters beyond this are refused rather than queued indefinitely. */
const MAX_QUEUED = 8;
/** How long a new holder waits for the previous action to unwind. */
const ACTION_HANDOFF_MS = 2_000;
/**
 * How soon a handback that could not run yet asks again.
 *
 * A retry rather than a wait, because `handBack` is synchronous and a caller
 * holding the lease open to await an action would deadlock against it. This is
 * the ONLY polling left around the action slot: waiting FOR the slot is a queue
 * now — see `acquireActionSlot`.
 */
const HANDBACK_RETRY_MS = 25;

export interface BrowserLeaseOptions {
  /**
   * Whether a run has been stopped. The lease skips revoked runs when handing
   * on, so a stopped run is not dealt the browser only to refuse it a line
   * later while the actor behind it waits out the whole queue.
   */
  isRevoked?: (sessionId: string) => boolean;
  /** Called whenever ownership or queue depth changes, so a UI can follow. */
  onChange?: () => void;
}

export class BrowserLease {
  private actor: string | null = null;
  private session: string | null = null;
  private ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  private waiting: Waiter[] = [];
  private lifecycleWired = false;
  /**
   * The action holding the browser, if any.
   *
   * Needed alongside the lease for a reason the lease cannot cover: the lease
   * is RE-ENTRANT for its holder — that is what makes a sequence a sequence —
   * so nothing in it stops ONE actor running two actions at once. A retry
   * racing the call it retried is exactly that shape.
   *
   * A symbol because it identifies the individual call: only the action that
   * took the slot may release it.
   */
  private action: symbol | null = null;
  /**
   * Everyone waiting for that slot, IN THE ORDER THEY ASKED.
   *
   * A queue rather than a poll, and the ordering is the whole reason for it.
   * `acquireActionSlot` used to spin on a 25ms timer, which decides nothing
   * about who goes first: each waiter checks on its own phase, so the one that
   * asked SECOND can find the slot free a full poll ahead of the one that asked
   * first. The person types one event per keypress — `{ kind: 'text', text }`
   * carries a single character — so that reordering is not a theoretical
   * unfairness, it is "passowrd" appearing in the box.
   *
   * The slot is handed straight from `endAction` to the head of this line while
   * still synchronous, so nothing can slip in between the two, and a waiter
   * that reaches the front never has to be told the slot is already taken.
   */
  private actionQueue: Array<() => void> = [];
  /** Lapses a human hold nobody is using. See `HUMAN_IDLE_MS`. */
  private humanTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The person ASKED for the hold to end and it could not end yet.
   *
   * Kept as a request rather than only a retry timer, because the retry shares
   * `humanTimer` with the idle deadline: an authorised event settling after the
   * request would otherwise call `touch()`, re-arm that timer for a full idle
   * interval, and quietly cancel a handback the person had already asked for.
   * "Give it back" is not undone by activity that was already under way when
   * they said it.
   *
   * Explicit requests ONLY. An idle expiry must never set this: a deadline that
   * lands on the person's own in-flight event is evidence they were THERE, and
   * recording it here made `touch()` bail afterwards, so the hold dropped the
   * instant a fresh interaction finished. See `lapse()`.
   */
  private handBackWanted = false;

  private isRevoked: (sessionId: string) => boolean;
  private onChange: () => void;

  constructor(options: BrowserLeaseOptions = {}) {
    this.isRevoked = options.isRevoked ?? (() => false);
    this.onChange = options.onChange ?? (() => {});
  }

  get holderActor(): string | null { return this.actor; }
  /** Whether a person, rather than the agent, is driving the page right now. */
  get heldByHuman(): boolean { return this.actor === HUMAN_ACTOR; }
  /**
   * Whether THIS actor is the one holding the browser right now.
   *
   * For asking again after a wait. `acquire` is re-entrant for the holder, so
   * "I was granted the lease" is a fact about the moment it was granted and
   * says nothing about the moment the caller finally gets to act.
   */
  heldBy(actorId: string): boolean { return this.actor === actorId; }
  get holderSession(): string | null { return this.session; }
  get queueDepth(): number { return this.waiting.length; }
  get actionInFlight(): boolean { return this.action !== null; }

  /**
   * Declare that this host reports worker terminal states.
   *
   * When it does, timers stop being ownership boundaries entirely. When it does
   * not — an embedder that wired a controller but not the release — the
   * fallbacks stay, because something has to break a deadlock.
   */
  setLifecycleReleaseWired(on: boolean): void {
    this.lifecycleWired = on;
  }

  /**
   * Take the browser for this actor, waiting in line if someone else holds it.
   *
   * Re-entrant for the actor that already holds it: that is the sequence case —
   * the same worker coming back for its next step must not queue behind itself.
   */
  async acquire(actorId: string, sessionId: string, signal?: AbortSignal): Promise<LeaseResult> {
    // Refused outright, and deliberately not queued. A worker that parks behind
    // a person is a worker that will act the moment they look away — minutes
    // later, on a page they have since changed, with a plan made before they
    // touched it. Telling the model "the user has taken over" ends the sequence
    // instead, which is the honest outcome and the one it can report.
    if (this.actor === HUMAN_ACTOR && actorId !== HUMAN_ACTOR) return 'human';
    if (this.actor === null || this.actor === actorId) {
      this.actor = actorId;
      this.session = sessionId;
      this.armCeiling();
      return 'granted';
    }
    // Refused rather than queued past this point. An unbounded queue turns a
    // wide worker wave into hundreds of workers each holding a turn, which is a
    // stall no user would sit through.
    if (this.waiting.length >= MAX_QUEUED) return 'busy';
    return this.enqueue(actorId, sessionId, signal);
  }

  /**
   * One worker has finished its whole sequence, so its hold ends.
   *
   * THIS is the semantic release. It comes from the worker's own terminal path,
   * so it means "this actor will never ask again" — which a timer can never
   * mean about a worker that is merely thinking.
   *
   * Idempotent, and safe for an actor that never touched the browser.
   */
  actorEnded(actorId: string): void {
    if (!actorId) return;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const w = this.waiting[i]!;
      if (w.actorId === actorId) w.settle('cancelled');
    }
    this.releaseIfHeldBy(actorId);
    this.onChange();
  }

  /**
   * Give the browser up when about to return without using it.
   *
   * Two guards, both load-bearing. Never while an action is in flight, because
   * the lease is RE-ENTRANT: the action still running may be this same actor's
   * previous step, and taking the lease off it hands the page to a queued
   * worker mid-sequence. And only while still the holder, because by the time a
   * refusal path runs a Stop may already have handed the lease on.
   */
  releaseIfHeldBy(actorId: string): void {
    if (this.action) return;
    if (this.actor === actorId) this.release();
  }

  /**
   * Give the browser to the person watching it.
   *
   * Callers must have waited the in-flight action out first — see
   * `acquireActionSlot`. This does not interrupt one, because it cannot: a
   * Playwright call already inside the page finishes whatever it started, and
   * taking the lease off it would only mean the person and a still-running
   * `fill` were both touching the same form. Waiting is what makes "you have
   * control" true when the UI says it.
   *
   * Every queued worker is turned away rather than left in line, for the same
   * reason `acquire` refuses: they were planned against a page the person is
   * about to change.
   */
  takeOver(sessionId: string): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) this.waiting[i]!.settle('human');
    this.clearCeiling();
    this.actor = HUMAN_ACTOR;
    this.session = sessionId;
    this.touch();
    this.onChange();
  }

  /**
   * The person is still there — anything they did counts.
   *
   * Called per authorised input rather than on a heartbeat, so the hold is
   * extended by USE and not merely by a tab being open. A left-open panel on a
   * forgotten laptop stops holding a billed session two minutes later.
   */
  touch(): void {
    if (this.actor !== HUMAN_ACTOR) return;
    if (this.handBackWanted) return;
    this.armIdle();
  }

  /** (Re)start the idle interval. The only place the deadline is set. */
  private armIdle(): void {
    this.clearHumanIdle();
    this.humanTimer = setTimeout(() => { this.lapse(); }, HUMAN_IDLE_MS);
    this.humanTimer.unref?.();
  }

  /**
   * The idle deadline came round.
   *
   * Both ways a hold ends obey the same rule — never while one of the person's
   * own events is still landing — but they resolve that clash in OPPOSITE
   * directions, and routing the lapse through `handBack()` collapsed them into
   * one. An event in flight BEGAN before this deadline, which makes it evidence
   * the person was there; deferring the lapse and then releasing the moment
   * that event lands ends the hold immediately after a fresh interaction, which
   * is the precise opposite of what an idle deadline measures. So an
   * interrupted lapse yields: the interval starts again, and the next silence
   * decides.
   *
   * `handBack()` keeps the deferral instead, because "Give it back" is a
   * decision and activity already under way when it was made does not withdraw
   * it. Same rule, different answer, which is why they are different methods.
   */
  private lapse(): void {
    if (this.actor !== HUMAN_ACTOR) return;
    if (this.action) { this.armIdle(); return; }
    this.release();
  }

  /**
   * The person hands the browser back, or their hold lapses.
   *
   * Answers whether there was a human hold to end, so a caller can tell a real
   * handback from a duplicate click or a lapse that already happened.
   */
  handBack(): boolean {
    if (this.actor !== HUMAN_ACTOR) return false;
    // NEVER while one of their own events is still landing. The person's click
    // is dispatched over CDP and awaited; releasing while it is in flight lets
    // the next agent action acquire and start on top of a click that has not
    // finished — the exact overlap a takeover exists to prevent, reintroduced
    // at the moment control changes hands. Re-checked shortly rather than
    // waited on inline, because a caller holding the lease open to wait is the
    // same deadlock in a different shape.
    if (this.action) {
      this.handBackWanted = true;
      this.clearHumanIdle();
      this.humanTimer = setTimeout(() => { this.handBack(); }, HANDBACK_RETRY_MS);
      this.humanTimer.unref?.();
      return false;
    }
    this.release();
    return true;
  }

  private clearHumanIdle(): void {
    if (this.humanTimer) { clearTimeout(this.humanTimer); this.humanTimer = null; }
  }

  /** Drop every queued waiter belonging to a run, and the lease if it holds it. */
  dropRun(sessionId: string): void {
    // Backwards: settle() splices, so forward iteration would skip entries.
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const w = this.waiting[i]!;
      if (w.sessionId === sessionId) w.settle('cancelled');
    }
    // After the waiters, not before: release() hands the browser to the head of
    // the queue, and this run's own waiters must be gone by then.
    if (this.session === sessionId) this.release();
  }

  /** Turn everyone away — the capability itself has gone. */
  dropAll(): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) this.waiting[i]!.settle('off');
  }

  /** Hand the browser to the next actor in line, if any. */
  release(): void {
    this.clearCeiling();
    // Unconditional, because a human hold ends by every route the lease has —
    // the person handing it back, their idle lapsing, the run being stopped,
    // the capability being switched off — and a timer surviving one of those
    // would fire into a lease somebody else has since taken.
    this.clearHumanIdle();
    this.handBackWanted = false;
    this.actor = null;
    this.session = null;

    // Skip anyone whose run was stopped while they queued.
    let next = this.waiting.shift();
    while (next && this.isRevoked(next.sessionId)) {
      next.settle('cancelled');
      next = this.waiting.shift();
    }
    if (next) {
      this.actor = next.actorId;
      this.session = next.sessionId;
      // Armed even though the winner is about to clear it: between settle() and
      // the winner resuming there is a turn of the event loop, and if that actor
      // never resumes — its run cancelled in exactly that gap — the lease would
      // be held by nobody with nothing left to release it.
      this.armCeiling();
      next.settle('granted');
    }
    this.onChange();
  }

  /** Arm the deadlock ceiling. Not a release schedule — see the constant. */
  armCeiling(): void {
    this.clearCeiling();
    if (this.lifecycleWired) return;
    this.ceilingTimer = setTimeout(() => this.release(), LEASE_DEADLOCK_CEILING_MS);
    this.ceilingTimer.unref?.();
  }

  clearCeiling(): void {
    if (this.ceilingTimer) { clearTimeout(this.ceilingTimer); this.ceilingTimer = null; }
  }

  /**
   * Take the per-action slot, or null when one is already running.
   *
   * PRIVATE, so the queue is the only way in. A caller that could take the slot
   * without joining the line would be exactly the jump-the-queue the ordering
   * is there to prevent.
   */
  private beginAction(): symbol | null {
    if (this.action) return null;
    const token = Symbol('browser-action');
    this.action = token;
    return token;
  }

  /**
   * Release the slot, but only for the action that took it.
   *
   * Hands it to the head of the line rather than merely clearing it, and does
   * so SYNCHRONOUSLY: the waiter's `beginAction` runs before this call returns,
   * so there is no window in which the slot is free and somebody who asked
   * later can take it.
   */
  endAction(token: symbol): boolean {
    if (this.action !== token) return false;
    this.action = null;
    this.actionQueue.shift()?.();
    return true;
  }

  /**
   * Take the per-action slot, waiting in line for it if somebody has it.
   *
   * A release can hand the browser on while the previous holder's abort is
   * still propagating through an awaited navigation. That is a handoff, not a
   * conflict, so it is waited out rather than refused — but bounded, because a
   * wedged action must not pin the queue.
   *
   * Waiting and TAKING are one step, which they deliberately were not before:
   * the wait used to answer "the slot looks free" and leave the caller to call
   * `beginAction` afterwards. Two callers woken by the same release both saw it
   * free, and the loser was told "another action is already running" — a
   * refusal for having asked first. Granting it here means whoever reaches the
   * front of the line gets it, and everybody else is still waiting rather than
   * refused.
   *
   * `null` means the wait ran out, never that somebody jumped in.
   */
  async acquireActionSlot(withinMs = ACTION_HANDOFF_MS): Promise<symbol | null> {
    // The queue is empty whenever the slot is free — `endAction` fills it again
    // in the same breath as it clears it — so this is the ordinary path, and it
    // takes no timer at all. The length check is what keeps a newcomer from
    // stepping over a line that is already forming.
    if (!this.action && this.actionQueue.length === 0) return this.beginAction();
    return await new Promise<symbol | null>((resolve) => {
      let done = false;
      const wake = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(this.beginAction());
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const i = this.actionQueue.indexOf(wake);
        if (i >= 0) this.actionQueue.splice(i, 1);
        resolve(null);
      }, withinMs);
      timer.unref?.();
      this.actionQueue.push(wake);
    });
  }

  /**
   * Queue one actor, resolving when it gets the browser or is turned away.
   *
   * `settle` is wrapped so it runs at most once and always takes the waiter out
   * of the line: the timeout, an abort and a handoff all race, and settling
   * twice would silently leave a dead entry holding a queue slot.
   */
  private enqueue(actorId: string, sessionId: string, signal: AbortSignal | undefined): Promise<LeaseResult> {
    return new Promise<LeaseResult>((resolve) => {
      let done = false;
      const waiter: Waiter = {
        actorId,
        sessionId,
        settle: (result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', giveUp);
          const i = this.waiting.indexOf(waiter);
          if (i >= 0) this.waiting.splice(i, 1);
          resolve(result);
        },
      };
      // Same reasoning as the ceiling: a fixed timeout is shorter than a healthy
      // holder's interval, so it told queued workers the browser was busy while
      // it was working normally. With lifecycle release wired, a waiter is
      // bounded by its own run's cancellation, the user's Stop, and MAX_QUEUED.
      const timer = this.lifecycleWired
        ? undefined
        : setTimeout(() => waiter.settle('busy'), QUEUE_WAIT_MS);
      timer?.unref?.();
      const giveUp = () => waiter.settle('cancelled');
      signal?.addEventListener('abort', giveUp, { once: true });
      this.waiting.push(waiter);
    });
  }
}
