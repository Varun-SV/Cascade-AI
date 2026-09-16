// ─────────────────────────────────────────────
//  Cascade AI — Escalation round-trip
// ─────────────────────────────────────────────
//
//  A section that ends ESCALATED asks the user a question. These pin the two
//  properties that are easy to get wrong and impossible to notice in a unit
//  test of the happy path:
//
//   1. Sections in a wave run CONCURRENTLY (t1-administrator dispatches each
//      wave with Promise.all), so more than one escalation can be parked at
//      once. A single pending slot loses the first one — and worse, the first
//      one's timer then finds the slot occupied by the second and returns
//      without resolving anything, parking the run past its own timeout.
//   2. Stop must unpark the run. T2 has already passed its cancellation
//      checkpoint by the time it escalates, so a gate that only watches for an
//      answer holds the run (and, in cloud, server resources) for the full five
//      minutes after the user asked it to stop.

import { describe, expect, it, vi } from 'vitest';
import { Cascade } from './cascade.js';
import type { CascadeConfig, EscalationDecision } from '../types.js';

const config: CascadeConfig = {
  version: '1.0',
  defaultIdentityId: 'default',
  providers: [],
  models: {},
  tools: { shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false },
  hooks: {},
  dashboard: { port: 4891, auth: false, teamMode: 'single' },
  telemetry: { enabled: false },
  memory: { maxSessionMessages: 1000, autoSummarizeAt: 150000, retentionDays: 90 },
  theme: 'cascade',
  workspace: {
    cascadeMdPath: 'CASCADE.md',
    configPath: '.cascade/config.json',
    keystorePath: '.cascade/keystore.enc',
    auditLogPath: '.cascade/audit.log',
  },
};

/** The gate is private — it is only ever reached through a running section. */
type EscalationGate = (
  ctx: { sectionId: string; sectionTitle: string; issues: string[]; summary: string },
  taskId: string,
  signal?: AbortSignal,
) => Promise<EscalationDecision>;

function gateOf(c: Cascade): EscalationGate {
  return (c as unknown as { requestEscalationDecision: EscalationGate }).requestEscalationDecision.bind(c);
}

function ctx(sectionId: string) {
  return { sectionId, sectionTitle: `Section ${sectionId}`, issues: ['worker was unsure'], summary: 'partial work' };
}

describe('escalation gate', () => {
  it('skips when nobody is listening, rather than hanging', async () => {
    // No listener means no host UI can answer. Skipping keeps whatever the
    // section produced; waiting would stall a run nobody can rescue.
    // `automatic: true` — the SDK decided this, not a person; see
    // EscalationDecision.automatic and its userSkipped consequence in T2.
    const c = new Cascade(config, '/tmp');
    await expect(gateOf(c)(ctx('a'), 'task-1')).resolves.toEqual({ action: 'skip', automatic: true });
  });

  it('skips in autonomous mode without emitting anything', async () => {
    const c = new Cascade({ ...config, autonomy: 'auto' }, '/tmp');
    const seen = vi.fn();
    c.on('escalation:decision-required', seen);
    await expect(gateOf(c)(ctx('a'), 'task-1')).resolves.toEqual({ action: 'skip', automatic: true });
    expect(seen).not.toHaveBeenCalled();
  });

  it('delivers the answer the user actually gave', async () => {
    const c = new Cascade(config, '/tmp');
    c.on('escalation:decision-required', (e: { requestId: string }) => {
      setTimeout(() => c.resolveEscalation('guidance', 'only the public repos', e.requestId), 0);
    });
    await expect(gateOf(c)(ctx('a'), 'task-1')).resolves.toEqual({
      action: 'guidance', note: 'only the public repos',
    });
  });

  it('lets a host settle a gate on nobody\'s behalf, marked automatic — not a real answer', async () => {
    // A dashboard/cloud host can decide nobody is reachable to answer (an
    // orphaned REST caller who never connected, a session halt) and settle
    // the gate itself. That is the same "not a person's decision" fact as the
    // SDK's own no-listener/autonomy-auto/abort skips, so it must carry the
    // same marker — T2 reads it to decide whether to set `userSkipped`.
    const c = new Cascade(config, '/tmp');
    c.on('escalation:decision-required', (e: { requestId: string }) => {
      setTimeout(() => c.resolveEscalation('skip', 'No client was connected to answer.', e.requestId, true), 0);
    });
    await expect(gateOf(c)(ctx('a'), 'task-1')).resolves.toEqual({
      action: 'skip', note: 'No client was connected to answer.', automatic: true,
    });
  });

  // ── The concurrency case ──────────────────────

  it('routes each answer to the section that asked, when two are parked', async () => {
    const c = new Cascade(config, '/tmp');
    const ids: string[] = [];
    c.on('escalation:decision-required', (e: { requestId: string }) => { ids.push(e.requestId); });

    const first = gateOf(c)(ctx('alpha'), 'task-1');
    const second = gateOf(c)(ctx('beta'), 'task-1');
    await Promise.resolve();

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // distinct — not one slot reused

    // Answer them in the opposite order to the one they arrived in: if the
    // resolvers were keyed by anything positional this is where it breaks.
    c.resolveEscalation('skip', undefined, ids[1]!);
    c.resolveEscalation('retry', undefined, ids[0]!);

    await expect(first).resolves.toEqual({ action: 'retry' });
    await expect(second).resolves.toEqual({ action: 'skip' });
  });

  it('leaves the other section still waiting when only one is answered', async () => {
    // The old singleton resolved both promises' worth of state with one answer.
    const c = new Cascade(config, '/tmp');
    const ids: string[] = [];
    c.on('escalation:decision-required', (e: { requestId: string }) => { ids.push(e.requestId); });

    const first = gateOf(c)(ctx('alpha'), 'task-1');
    const second = gateOf(c)(ctx('beta'), 'task-1');
    await Promise.resolve();

    c.resolveEscalation('skip', undefined, ids[0]!);
    await expect(first).resolves.toEqual({ action: 'skip' });

    const pending = vi.fn();
    void second.then(pending);
    await Promise.resolve();
    expect(pending).not.toHaveBeenCalled();

    c.resolveEscalation('retry', undefined, ids[1]!);
    await expect(second).resolves.toEqual({ action: 'retry' });
  });

  it('answers the oldest request when the host sends no requestId', async () => {
    // Hosts with a single escalation in flight (and any caller predating the
    // id) must keep working.
    const c = new Cascade(config, '/tmp');
    c.on('escalation:decision-required', () => { /* parked */ });

    const first = gateOf(c)(ctx('alpha'), 'task-1');
    const second = gateOf(c)(ctx('beta'), 'task-1');
    await Promise.resolve();

    c.resolveEscalation('skip');
    await expect(first).resolves.toEqual({ action: 'skip' });

    c.resolveEscalation('retry');
    await expect(second).resolves.toEqual({ action: 'retry' });
  });

  // ── Cancellation ──────────────────────────────

  it('unparks the run when the user hits Stop', async () => {
    // Skip, not timeout: an abort is the user leaving, not the section failing.
    // `automatic: true` — pressing Stop is not a per-section review decision.
    const c = new Cascade(config, '/tmp');
    c.on('escalation:decision-required', () => { /* parked */ });
    const ac = new AbortController();

    const parked = gateOf(c)(ctx('alpha'), 'task-1', ac.signal);
    await Promise.resolve();
    ac.abort();

    await expect(parked).resolves.toEqual({ action: 'skip', automatic: true });
  });

  it('does not even ask when the run was already aborted', async () => {
    const c = new Cascade(config, '/tmp');
    const seen = vi.fn();
    c.on('escalation:decision-required', seen);
    const ac = new AbortController();
    ac.abort();

    await expect(gateOf(c)(ctx('alpha'), 'task-1', ac.signal)).resolves.toEqual({ action: 'skip', automatic: true });
    expect(seen).not.toHaveBeenCalled();
  });

  it('ignores a late answer that arrives after the abort', async () => {
    const c = new Cascade(config, '/tmp');
    let requestId = '';
    c.on('escalation:decision-required', (e: { requestId: string }) => { requestId = e.requestId; });
    const ac = new AbortController();

    const parked = gateOf(c)(ctx('alpha'), 'task-1', ac.signal);
    await Promise.resolve();
    ac.abort();
    c.resolveEscalation('retry', undefined, requestId);

    // First settle wins; the late retry must not re-resolve an settled promise.
    await expect(parked).resolves.toEqual({ action: 'skip', automatic: true });
  });

  // ── Timeout ───────────────────────────────────

  it('fails the section when nobody answers in time', async () => {
    vi.useFakeTimers();
    try {
      const c = new Cascade(config, '/tmp');
      const timedOut = vi.fn();
      c.on('escalation:decision-required', () => { /* parked */ });
      c.on('escalation:timeout', timedOut);

      const parked = gateOf(c)(ctx('alpha'), 'task-1');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

      await expect(parked).resolves.toEqual({ action: 'timeout' });
      expect(timedOut).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the section is no longer parked, however it stopped being parked', () => {
    // The gate had exactly one announcement of an ending — `escalation:timeout`
    // — and that is one of four. Answered, stopped and released-by-teardown all
    // settled silently, so nothing downstream could tell a live section from a
    // decided one.
    //
    // That is what made the request unsafe to REMEMBER: a replay store sees
    // emits, never the answer (which arrives on a socket), so without a
    // reliable delete a reloaded page could be handed back a decision already
    // made. The clarification gate got this event two rounds earlier; this is
    // the gate it was copied from.
    const c = new Cascade(config, '/tmp');
    const closed: Array<{ requestId?: string }> = [];
    c.on('escalation:decision-required', () => {});
    c.on('escalation:closed', (e: unknown) => closed.push(e as { requestId?: string }));

    const parked = gateOf(c)(ctx('alpha'), 'task-1');
    c.resolveEscalation('skip');

    return parked.then(() => {
      expect(closed, 'answering is an ending too, not only the timeout').toHaveLength(1);
      expect(closed[0]?.requestId, 'and it names which section').toBeTruthy();
    });
  });

  it('closes the section exactly once, however many ways it could settle', async () => {
    // The map delete is what makes this exactly-once. A second emission would
    // take down a LATER prompt: the client removes by request id, and a repeat
    // for an id already gone races the next section to park.
    vi.useFakeTimers();
    try {
      const c = new Cascade(config, '/tmp');
      const closed: unknown[] = [];
      c.on('escalation:decision-required', () => {});
      c.on('escalation:closed', (e: unknown) => closed.push(e));

      const parked = gateOf(c)(ctx('alpha'), 'task-1');
      await vi.advanceTimersByTimeAsync(0);
      c.resolveEscalation('retry');
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await parked;

      expect(closed, 'answered, then the timeout fires and changes nothing').toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not parked by a closed listener that throws', async () => {
    // The rule this file now applies in five places, applied to the new emit
    // before it had a chance to become the sixth door.
    const c = new Cascade(config, '/tmp');
    c.on('escalation:decision-required', () => {});
    c.on('escalation:closed', () => { throw new Error('the telemetry sink is down'); });

    const parked = gateOf(c)(ctx('alpha'), 'task-1');
    c.resolveEscalation('skip');

    await expect(parked, 'the section is released regardless')
      .resolves.toMatchObject({ action: 'skip' });
  });

  it('is not parked by a timeout listener that throws', async () => {
    // The announcement used to run BEFORE `settle`, inside a one-shot timer.
    // A listener that threw unwound the callback before the gate settled, so
    // the request stayed in `pendingEscalations` with its promise unresolved
    // and nothing was ever coming back for it — the section held its worker
    // until teardown. Being a timer callback, the throw also had no caller to
    // unwind into: it surfaced as an uncaught exception.
    //
    // Not reported by review — this gate is outside the PR's diff. Found by
    // walking every door of the rule after the same mistake was caught in the
    // clarification gate, which was itself the second time it had been made.
    vi.useFakeTimers();
    try {
      const c = new Cascade(config, '/tmp');
      c.on('escalation:decision-required', () => { /* parked */ });
      c.on('escalation:timeout', () => { throw new Error('the telemetry sink is down'); });

      const parked = gateOf(c)(ctx('alpha'), 'task-1');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

      await expect(parked, 'the section is released regardless')
        .resolves.toEqual({ action: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out each parked section independently', async () => {
    // The failure this guards: one section's timer clearing the shared slot,
    // leaving the other permanently unresolvable.
    vi.useFakeTimers();
    try {
      const c = new Cascade(config, '/tmp');
      c.on('escalation:decision-required', () => { /* parked */ });

      const first = gateOf(c)(ctx('alpha'), 'task-1');
      const second = gateOf(c)(ctx('beta'), 'task-1');
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

      await expect(first).resolves.toEqual({ action: 'timeout' });
      await expect(second).resolves.toEqual({ action: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the section when the listener throws on delivery, rather than failing T2', async () => {
    // The delivery emit sits inside the Promise executor, so an unguarded
    // throw does not merely fail to show the prompt — it REJECTS the gate, and
    // the rejection surfaces inside T2's review of the section. A host whose
    // socket is momentarily down would turn "ask about this section" into a
    // thrown error in the run.
    //
    // Same answer as `listenerCount === 0` above, because it is the same fact
    // arriving later: a listener that throws on receipt did not receive it.
    // `automatic: true` keeps T2 from reading this as a person having accepted
    // the section — nobody saw it.
    const c = new Cascade(config, '/tmp');
    c.on('escalation:decision-required', () => { throw new Error('socket is down'); });

    await expect(gateOf(c)(ctx('a'), 'task-1')).resolves.toEqual({ action: 'skip', automatic: true });
  });

  it('closes a modal another host DID open before a later listener threw', async () => {
    // Listeners run in order, so one dashboard can have the section on screen
    // when the next host throws. Without the close it stays there, answerable
    // into a gate that has already settled.
    const c = new Cascade(config, '/tmp');
    const closed: unknown[] = [];
    let openedFor: string | undefined;
    c.on('escalation:decision-required', (e: { requestId: string }) => { openedFor = e.requestId; });
    c.on('escalation:decision-required', () => { throw new Error('second host is down'); });
    c.on('escalation:closed', (e: unknown) => closed.push(e));

    await expect(gateOf(c)(ctx('a'), 'task-1')).resolves.toEqual({ action: 'skip', automatic: true });
    expect(openedFor, 'the first host did open it').toBeTruthy();
    expect(closed, 'and is told to close it').toEqual([
      { taskId: 'task-1', requestId: openedFor, sectionId: 'a' },
    ]);
  });

  it('releases the section when an async listener REJECTS, not only when it throws', async () => {
    // The twin of the clarification case, and the one with more to lose: an
    // escalation that never settles holds a T2 section and its worker for the
    // full five minutes. `emit` discards what a listener returns, so an async
    // host failing was invisible to the guard around it.
    //
    // Real timers and no advance: if the rejection did not settle the gate,
    // this hangs rather than passes.
    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown) => { escaped.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const c = new Cascade(config, '/tmp');
      c.on('escalation:decision-required', async () => { throw new Error('the socket is down'); });

      await expect(gateOf(c)(ctx('a'), 'task-1')).resolves.toEqual({ action: 'skip', automatic: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(escaped, 'and nothing reached the process').toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
