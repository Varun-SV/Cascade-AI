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
const ACTION_HANDOFF_POLL_MS = 25;

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
  /** Lapses a human hold nobody is using. See `HUMAN_IDLE_MS`. */
  private humanTimer: ReturnType<typeof setTimeout> | null = null;

  private isRevoked: (sessionId: string) => boolean;
  private onChange: () => void;

  constructor(options: BrowserLeaseOptions = {}) {
    this.isRevoked = options.isRevoked ?? (() => false);
    this.onChange = options.onChange ?? (() => {});
  }

  get holderActor(): string | null { return this.actor; }
  /** Whether a person, rather than the agent, is driving the page right now. */
  get heldByHuman(): boolean { return this.actor === HUMAN_ACTOR; }
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
   * `awaitActionSlot`. This does not interrupt one, because it cannot: a
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
    this.clearHumanIdle();
    // Through handBack rather than straight to release, so a lapse obeys the
    // same "not while their event is still landing" rule an explicit handback
    // does. One rule, one place, whichever way the hold ends.
    this.humanTimer = setTimeout(() => { this.handBack(); }, HUMAN_IDLE_MS);
    this.humanTimer.unref?.();
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
      this.clearHumanIdle();
      this.humanTimer = setTimeout(() => { this.handBack(); }, ACTION_HANDOFF_POLL_MS);
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

  /** Take the per-action slot, or null when one is already running. */
  beginAction(): symbol | null {
    if (this.action) return null;
    const token = Symbol('browser-action');
    this.action = token;
    return token;
  }

  /** Release the slot, but only for the action that took it. */
  endAction(token: symbol): boolean {
    if (this.action !== token) return false;
    this.action = null;
    return true;
  }

  /**
   * Wait, briefly, for an outgoing action to unwind.
   *
   * A release can hand the browser on while the previous holder's abort is
   * still propagating through an awaited navigation. That is a handoff, not a
   * conflict, so it is waited out rather than refused — but bounded, because a
   * wedged action must not pin the queue.
   */
  async awaitActionSlot(withinMs = ACTION_HANDOFF_MS): Promise<boolean> {
    for (let waited = 0; waited < withinMs; waited += ACTION_HANDOFF_POLL_MS) {
      if (!this.action) return true;
      await new Promise((r) => setTimeout(r, ACTION_HANDOFF_POLL_MS));
    }
    return this.action === null;
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
