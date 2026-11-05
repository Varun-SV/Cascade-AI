import { describe, expect, it, vi } from 'vitest';
import { CommandFenced, acquireLease, createFencedForwarder, createTabLease, type CommandTransport, type LeaseClock, type ServerClaim } from './tab-lease.js';

function fakeClock(start = 1000) {
  const timers: { at: number; fn: () => void; off: boolean }[] = [];
  let t = start;
  const clock: LeaseClock = {
    now: () => t,
    setTimer(fn, ms) { const e = { at: t + ms, fn, off: false }; timers.push(e); return () => { e.off = true; }; },
  };
  return { clock, advance(ms: number) { t += ms; for (const e of timers) if (!e.off && e.at <= t) { e.off = true; e.fn(); } } };
}
// Later than any test runs. A time already past would end a lease on the system clock
// as soon as its timer fired, which made a test fail only under load.
const FAR = Date.now() + 600_000;
const leased = (clock?: LeaseClock) => {
  const lease = createTabLease(clock);
  const r = lease.reserve()!;
  const fence = lease.promote(r, { expiresAt: FAR })!;
  return { lease, fence };
};

describe('O2: one lease per tab', () => {
  it('refuses a second reservation while reserved, held or suspended', () => {
    const lease = createTabLease();
    const r = lease.reserve()!;
    expect(lease.reserve()).toBeNull();
    lease.promote(r, { expiresAt: FAR });
    expect(lease.reserve()).toBeNull();
    lease.suspend();
    expect(lease.reserve()).toBeNull();
    lease.revoke('stop');
    expect(lease.reserve()).not.toBeNull();
  });
  it('human takeover refuses commands until hand-back', () => {
    const { lease, fence } = leased();
    lease.suspend();
    expect(lease.fence()).toBeNull();
    expect(lease.isCurrent(fence)).toBe(false);
    lease.handBack();
    expect(lease.fence()).not.toBeNull();
    // A fence from before the takeover stays dead after it.
    expect(lease.isCurrent(fence)).toBe(false);
  });
  it('a released reservation frees the tab, and only its holder can release', () => {
    const lease = createTabLease();
    const r = lease.reserve()!;
    lease.release({ id: -1 });
    expect(lease.state()).toBe('reserved');
    lease.release(r);
    expect(lease.state()).toBe('idle');
    expect(lease.promote(r, { expiresAt: 1 })).toBeNull();
  });
});

describe('O3: generations and expiry', () => {
  it('a fence from an older generation is never current', () => {
    const lease = createTabLease();
    const f1 = lease.promote(lease.reserve()!, { expiresAt: FAR })!;
    lease.revoke('drop');
    const f2 = lease.promote(lease.reserve()!, { expiresAt: FAR })!;
    expect(f2.generation).toBeGreaterThan(f1.generation);
    expect(lease.isCurrent(f1)).toBe(false);
    expect(lease.isCurrent(f2)).toBe(true);
  });
  it('a lease ends on its expiry timer, with no command needed to notice', () => {
    const { clock, advance } = fakeClock();
    const lease = createTabLease(clock);
    const seen: string[] = [];
    lease.onChange((why) => seen.push(why));
    lease.promote(lease.reserve()!, { expiresAt: 1500 });
    advance(499);
    expect(lease.state()).toBe('held');
    advance(1);
    expect(lease.state()).toBe('idle');
    expect(seen).toEqual(['capability expired']);
  });
  it('revoking cancels the expiry timer of that lease', () => {
    const { clock, advance } = fakeClock();
    const lease = createTabLease(clock);
    lease.promote(lease.reserve()!, { expiresAt: 1500 });
    lease.revoke('stop');
    const f2 = lease.promote(lease.reserve()!, { expiresAt: 9000 })!;
    advance(600);
    expect(lease.isCurrent(f2)).toBe(true);
  });
});

/** A transport with a barrier per command, and a log standing in for the browser. */
function barrierTransport() {
  const received: string[] = [];
  const gates = new Map<string, () => void>();
  const arrived = new Map<string, () => void>();
  const transport: CommandTransport<string> = {
    beforeForward: (c) => new Promise<void>((release) => { gates.set(c, release); arrived.get(c)?.(); }),
    write: (c) => { received.push(c); },
  };
  const reached = (c: string) => new Promise<void>((r) => { if (gates.has(c)) r(); else arrived.set(c, r); });
  return { transport, received, reached, release: (c: string) => gates.get(c)!() };
}
const settle = () => new Promise((r) => setImmediate(r));

describe('O3: deterministic races, with a barrier between dispatch and forward', () => {
  it.each([
    ['revoke', (l: ReturnType<typeof createTabLease>) => l.revoke('stop')],
    ['suspend', (l: ReturnType<typeof createTabLease>) => l.suspend()],
  ])('%s while a command is held: 0 reach the browser, and the caller is rejected', async (_n, act) => {
    const { lease } = leased();
    const t = barrierTransport();
    const f = createFencedForwarder<string, string>(lease, t.transport);
    const p = f.dispatch('cmd', 1);
    const outcome = expect(p).rejects.toBeInstanceOf(CommandFenced);
    await t.reached('cmd');
    act(lease);
    t.release('cmd');
    await outcome;
    await settle();
    expect(t.received).toEqual([]);
  });
  it('after hand-back, a command held across a takeover has still not run', async () => {
    const { lease } = leased();
    const t = barrierTransport();
    const f = createFencedForwarder<string, string>(lease, t.transport);
    const outcome = expect(f.dispatch('cmd', 1)).rejects.toBeInstanceOf(CommandFenced);
    await t.reached('cmd');
    lease.suspend();
    lease.handBack();
    t.release('cmd');
    await outcome;
    await settle();
    expect(t.received).toEqual([]);
  });
  it('N queued commands: all rejected on revoke, 0 received', async () => {
    const { lease } = leased();
    const t = barrierTransport();
    const f = createFencedForwarder<string, string>(lease, t.transport);
    const outcomes = Array.from({ length: 10 }, (_, i) => expect(f.dispatch(`c${i}`, i)).rejects.toBeInstanceOf(CommandFenced));
    await Promise.all(Array.from({ length: 10 }, (_, i) => t.reached(`c${i}`)));
    lease.revoke('stop');
    for (let i = 0; i < 10; i++) t.release(`c${i}`);
    await Promise.all(outcomes);
    await settle();
    expect(t.received).toEqual([]);
  });
  it('a command from the old generation cannot run under a new lease', async () => {
    const { lease } = leased();
    const t = barrierTransport();
    const f = createFencedForwarder<string, string>(lease, t.transport);
    const outcome = expect(f.dispatch('old', 1)).rejects.toBeInstanceOf(CommandFenced);
    await t.reached('old');
    lease.revoke('drop');
    const f2 = lease.promote(lease.reserve()!, { expiresAt: FAR })!;
    t.release('old');
    await outcome;
    await settle();
    expect(t.received).toEqual([]);
    expect(lease.isCurrent(f2)).toBe(true);
  });
  it('dispatching with no active lease refuses at once', async () => {
    const lease = createTabLease();
    const write = vi.fn();
    const f = createFencedForwarder<string, string>(lease, { write });
    await expect(f.dispatch('cmd', 1)).rejects.toBeInstanceOf(CommandFenced);
    expect(write).not.toHaveBeenCalled();
  });
  it('a reply after revoke is not delivered', async () => {
    const { lease } = leased();
    const write = vi.fn();
    const f = createFencedForwarder<string, string>(lease, { write });
    const p = f.dispatch('cmd', 1);
    const outcome = expect(p).rejects.toBeInstanceOf(CommandFenced);
    await settle();
    expect(write).toHaveBeenCalledOnce();
    lease.revoke('stop');
    f.deliver(1, 'late');
    await outcome;
  });
  it('a command on the current fence is written and its reply delivered', async () => {
    const { lease } = leased();
    const write = vi.fn();
    const f = createFencedForwarder<string, string>(lease, { write });
    const p = f.dispatch('cmd', 1);
    await settle();
    f.deliver(1, 'ok');
    await expect(p).resolves.toBe('ok');
  });
});

describe('claim order: reserve, then claim, then promote', () => {
  const ok = { ok: true as const, exp: 1_000_000 };
  const run = (lease: ReturnType<typeof createTabLease>, claim: () => Promise<ServerClaim>) => {
    const burn = vi.fn();
    return { burn, result: acquireLease({ lease, admit: () => ok, claim, burn }) };
  };

  it('a request losing to a held tab never contacts the store or burns anything', async () => {
    const { lease } = leased();
    const claim = vi.fn(async (): Promise<ServerClaim> => ({ outcome: 'claimed' }));
    const { burn, result } = run(lease, claim);
    expect(await result).toEqual({ outcome: 'tab-leased' });
    expect(claim).not.toHaveBeenCalled();
    expect(burn).not.toHaveBeenCalled();
  });
  it('simultaneous contenders: one lease, and the loser\'s approval still works afterwards', async () => {
    const lease = createTabLease();
    let finish!: (c: ServerClaim) => void;
    const first = run(lease, () => new Promise((r) => { finish = r; }));
    const claim2 = vi.fn(async (): Promise<ServerClaim> => ({ outcome: 'claimed' }));
    const second = run(lease, claim2);
    expect(await second.result).toEqual({ outcome: 'tab-leased' });
    expect(claim2).not.toHaveBeenCalled();
    finish({ outcome: 'claimed' });
    expect(await first.result).toMatchObject({ outcome: 'leased' });
    lease.revoke('run ended');
    const retry = run(lease, claim2);
    expect(await retry.result).toMatchObject({ outcome: 'leased' });
    expect(claim2).toHaveBeenCalledOnce();
  });
  it.each<[string, ServerClaim, boolean, boolean]>([
    ['already claimed', { outcome: 'replay' }, false, true],
    ['store says not inserted', { outcome: 'unavailable' }, true, false],
    ['outcome unknown', { outcome: 'unknown' }, false, true],
    ['server refused', { outcome: 'refused', reason: 'no' }, false, false],
  ])('%s: reservation released, reusable=%s', async (_n, answer, reusable, burned) => {
    const lease = createTabLease();
    const { burn, result } = run(lease, async () => answer);
    expect(await result).toMatchObject({ outcome: 'refused', reusable });
    expect(lease.state()).toBe('idle');
    expect(burn).toHaveBeenCalledTimes(burned ? 1 : 0);
  });
  it('a claim that throws is treated as unknown: burned, not retried', async () => {
    const lease = createTabLease();
    const { burn, result } = run(lease, async () => { throw new Error('socket closed'); });
    expect(await result).toMatchObject({ outcome: 'refused', reusable: false });
    expect(burn).toHaveBeenCalledOnce();
    expect(lease.state()).toBe('idle');
  });
  it('a won claim burns the approval, and the lease ending does not restore it', async () => {
    const lease = createTabLease();
    const { burn, result } = run(lease, async () => ({ outcome: 'claimed' }));
    expect(await result).toMatchObject({ outcome: 'leased' });
    expect(burn).toHaveBeenCalledOnce();
    lease.revoke('drop');
    expect(burn).toHaveBeenCalledOnce();
  });
  it('an approval the device refuses never reserves the tab', async () => {
    const lease = createTabLease();
    const claim = vi.fn();
    const r = await acquireLease({ lease, admit: () => ({ ok: false, reason: 'approval already used' }), claim, burn: vi.fn() });
    expect(r).toMatchObject({ outcome: 'refused', reusable: false });
    expect(lease.state()).toBe('idle');
    expect(claim).not.toHaveBeenCalled();
  });
  it('with the store down, an existing lease still ends locally, and no new one can start', async () => {
    const { clock, advance } = fakeClock();
    const lease = createTabLease(clock);
    lease.promote(lease.reserve()!, { expiresAt: 1500 });
    const down = async (): Promise<ServerClaim> => ({ outcome: 'unavailable' });
    expect(await run(lease, down).result).toEqual({ outcome: 'tab-leased' });
    advance(600);
    expect(lease.state()).toBe('idle');
    expect(await run(lease, down).result).toMatchObject({ outcome: 'refused', reusable: true });
    expect(lease.state()).toBe('idle');
  });
});
