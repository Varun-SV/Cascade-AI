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
});
