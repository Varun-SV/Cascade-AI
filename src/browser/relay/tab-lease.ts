// ─────────────────────────────────────────────
//  Cascade AI — The one lease on one tab, and its fence
// ─────────────────────────────────────────────
//
//  Not BrowserLease (src/browser/lease.ts), which decides which worker holds a
//  browser within a run. This decides which RUN holds a tab on the user's device.
//
//  The fence changes synchronously, before anything else runs, on revoke, suspend
//  and hand-back. Every command is checked against it twice: leaving the queue, and
//  in the same synchronous step as the socket write. So nothing is FORWARDED after
//  the fence changes. A command already written to the browser can't be recalled:
//  that limit, and what revoke does about it, is in stage-1-plan.md section 4.
//
//  A revoke doesn't free the tab while a teardown holds it: the lease waits in
//  `ending`, refusing every reservation, until each hold is released. So nothing a
//  revoked lease's cleanup does to the page can land on a later lease.

export type LeaseState = 'idle' | 'reserved' | 'held' | 'suspended' | 'ending';

export interface Fence { generation: number; epoch: number }

export interface Reservation { readonly id: number }

export interface TabLease {
  state(): LeaseState;
  /** Atomic and local. Null means the tab is taken: refuse without touching the nonce. */
  reserve(): Reservation | null;
  release(r: Reservation): void;
  /** Turns a reservation into the lease, with a new generation. */
  promote(r: Reservation, opts: { expiresAt: number }): Fence | null;
  /** The current fence, or null when commands may not run. */
  fence(): Fence | null;
  /** The generation of the lease held or suspended now, or null when there's none. */
  generation(): number | null;
  isCurrent(f: Fence): boolean;
  suspend(): void;
  handBack(): void;
  /** Ends the lease. With a teardown holding it, the tab stays `ending`, not `idle`, until that's released. */
  revoke(reason: string): void;
  /**
   * Keeps the tab from being leased again, once this lease is revoked, until the
   * returned release is called. Null when no lease is held or suspended. Releasing
   * twice does nothing.
   */
  holdTeardown(): (() => void) | null;
  /** Called synchronously on every fence change. */
  onChange(fn: (reason: string, state: LeaseState) => void): void;
}

export interface LeaseClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

export const systemClock: LeaseClock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};

export function createTabLease(clock: LeaseClock = systemClock): TabLease {
  let state: LeaseState = 'idle';
  let generation = 0;
  let epoch = 0;
  let reservation: Reservation | null = null;
  let nextReservation = 1;
  let cancelExpiry: (() => void) | null = null;
  let expiresAt: number | null = null;
  let holds = 0;
  const listeners: ((reason: string, s: LeaseState) => void)[] = [];
  const changed = (reason: string): void => { epoch += 1; for (const fn of listeners) fn(reason, state); };

  /** Checked synchronously wherever the fence is: past the deadline, the lease is over now. */
  const expireIfDue = (): void => {
    if (expiresAt !== null && (state === 'held' || state === 'suspended') && clock.now() >= expiresAt) lease.revoke('capability expired');
  };

  const lease: TabLease = {
    state: () => { expireIfDue(); return state; },
    reserve() {
      if (state !== 'idle') return null;
      state = 'reserved';
      reservation = { id: nextReservation++ };
      return reservation;
    },
    release(r) {
      if (reservation !== r || state !== 'reserved') return;
      reservation = null;
      state = 'idle';
    },
    promote(r, { expiresAt: deadline }) {
      if (reservation !== r || state !== 'reserved') return null;
      reservation = null;
      state = 'held';
      generation += 1;
      epoch += 1;
      expiresAt = deadline;
      // The timer ends a lease nobody is using. It can't be the only check: it runs when
      // JavaScript next yields, and a burst of commands crossing the deadline doesn't yield.
      cancelExpiry = clock.setTimer(() => lease.revoke('capability expired'), Math.max(0, deadline - clock.now()));
      return { generation, epoch };
    },
    fence: () => { expireIfDue(); return state === 'held' ? { generation, epoch } : null; },
    generation: () => { expireIfDue(); return state === 'held' || state === 'suspended' ? generation : null; },
    isCurrent: (f) => { expireIfDue(); return state === 'held' && f.generation === generation && f.epoch === epoch; },
    suspend() {
      if (state !== 'held') return;
      state = 'suspended';
      changed('suspended');
    },
    handBack() {
      if (state !== 'suspended') return;
      state = 'held';
      changed('handed back');
    },
    revoke(reason) {
      if (state !== 'held' && state !== 'suspended') return;
      state = holds > 0 ? 'ending' : 'idle';
      cancelExpiry?.();
      cancelExpiry = null;
      expiresAt = null;
      changed(reason);
    },
    holdTeardown() {
      if (state !== 'held' && state !== 'suspended') return null;
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        // No later generation can exist while a hold is out: reserve() refuses until now.
        if (holds === 0 && state === 'ending') { state = 'idle'; changed('teardown finished'); }
      };
    },
    onChange(fn) { listeners.push(fn); },
  };
  return lease;
}

/** Where forwarded commands go. A test transport can hold them at a barrier. */
export interface CommandTransport<C> {
  /** Runs before the final check; a test's barrier awaits here. */
  beforeForward?(command: C): Promise<void>;
  /** Writes to the browser. Synchronous on purpose: nothing can run between check and write. */
  write(command: C): void;
}

export class CommandFenced extends Error {
  constructor(reason: string) { super(`Command refused: ${reason}`); this.name = 'CommandFenced'; }
}

export interface FencedForwarder<C, R> {
  /** Queues a command under the current fence. Rejects if it can't be forwarded. */
  dispatch(command: C, key: number): Promise<R>;
  /** Delivers a browser reply, unless its command's fence has since changed. */
  deliver(key: number, reply: R): void;
}

/** With `generation`, nothing is dispatched under any other generation's lease. */
export function createFencedForwarder<C, R>(lease: TabLease, transport: CommandTransport<C>, generation?: number): FencedForwarder<C, R> {
  interface Entry { resolve(r: R): void; reject(e: Error): void; fence: Fence }
  const inFlight = new Map<number, Entry>();
  lease.onChange((reason) => {
    const err = new CommandFenced(reason);
    for (const e of inFlight.values()) e.reject(err);
    inFlight.clear();
  });
  return {
    async dispatch(command, key) {
      const fence = lease.fence();
      if (!fence) throw new CommandFenced('the lease is not active');
      if (generation !== undefined && fence.generation !== generation) throw new CommandFenced('the lease changed');
      return new Promise<R>((resolve, reject) => {
        inFlight.set(key, { resolve, reject, fence });
        const forward = async (): Promise<void> => {
          await transport.beforeForward?.(command);
          // In the same synchronous step as the write: no await between them.
          if (!inFlight.has(key)) return;
          if (!lease.isCurrent(fence)) { inFlight.delete(key); reject(new CommandFenced('the lease changed')); return; }
          transport.write(command);
        };
        forward().catch((e: unknown) => { inFlight.delete(key); reject(e instanceof Error ? e : new Error(String(e))); });
      });
    },
    deliver(key, reply) {
      const e = inFlight.get(key);
      if (!e) return;
      inFlight.delete(key);
      if (lease.isCurrent(e.fence)) e.resolve(reply);
      else e.reject(new CommandFenced('the lease changed'));
    },
  };
}

// ── Claim order ──────────────────────────────────────────────────────────────

export type LeaseClaim =
  | { outcome: 'leased'; fence: Fence }
  | { outcome: 'tab-leased' }
  | { outcome: 'refused'; reason: string; reusable: boolean };

/** What the server said about a claim. Same shape as capability.ts's ClaimResult. */
export type ServerClaim =
  | { outcome: 'claimed' } | { outcome: 'refused'; reason: string }
  | { outcome: 'replay' } | { outcome: 'unavailable' } | { outcome: 'unknown' };

/**
 * Reserve, then claim, then promote. Reserving first means a request that loses
 * only to a held tab never uses up its approval. See the table in plan section 2:
 * an unknown store result treats the approval as used, so a retry can't claim twice.
 */
export async function acquireLease(opts: {
  lease: TabLease;
  admit(): { ok: true; exp: number } | { ok: false; reason: string };
  claim(): Promise<ServerClaim>;
  burn(): void;
}): Promise<LeaseClaim> {
  const admitted = opts.admit();
  if (!admitted.ok) return { outcome: 'refused', reason: admitted.reason, reusable: false };
  // Held, or still ending: the approval isn't touched, so it can be used once the tab is free.
  const reservation = opts.lease.reserve();
  if (!reservation) return { outcome: 'tab-leased' };
  let result: ServerClaim;
  try { result = await opts.claim(); } catch { result = { outcome: 'unknown' }; }
  switch (result.outcome) {
    case 'claimed': {
      // Burned on promotion; the lease ending can't make it usable again.
      opts.burn();
      const fence = opts.lease.promote(reservation, { expiresAt: admitted.exp });
      if (fence) return { outcome: 'leased', fence };
      return { outcome: 'refused', reason: 'reservation lost', reusable: false };
    }
    case 'replay':
      opts.lease.release(reservation);
      opts.burn();
      return { outcome: 'refused', reason: 'approval was already claimed', reusable: false };
    case 'unavailable':
      opts.lease.release(reservation);
      return { outcome: 'refused', reason: 'nonce store unavailable', reusable: true };
    case 'unknown':
      opts.lease.release(reservation);
      opts.burn();
      return { outcome: 'refused', reason: 'claim outcome unknown; a new approval is needed', reusable: false };
    case 'refused':
      opts.lease.release(reservation);
      return { outcome: 'refused', reason: result.reason, reusable: false };
  }
}
