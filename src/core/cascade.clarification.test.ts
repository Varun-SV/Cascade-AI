// ─────────────────────────────────────────────
//  Cascade AI — the gate that asks instead of assuming
// ─────────────────────────────────────────────
//
//  Every test here is about a NON-answer. The happy path is the easy half; the
//  half that decides whether this tool can exist at all is what happens when
//  nobody replies, because a question that can park a run forever is a question
//  that cannot be offered to a model.

import { describe, expect, it, vi } from 'vitest';
import { Cascade } from './cascade.js';
import type { CascadeConfig } from '../types.js';

const baseConfig: CascadeConfig = {
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

const ONE = [{ id: 'q1', prompt: 'Which account?', kind: 'choice' as const, options: ['A', 'B'] }];

describe('Cascade.askUser — a question that cannot hang the run', () => {
  it('answers no-listener rather than waiting when nothing is attached', async () => {
    // The headless case: a scheduled run, an API caller with no socket. Nothing
    // is listening, so there is no one to time out waiting for.
    const c = new Cascade(baseConfig, '/tmp');
    await expect(c.askUser(ONE)).resolves.toEqual({ outcome: 'no-listener', answers: [] });
  });

  it('does not ask a run that has declared there is nobody there', async () => {
    // `setUnattended` can land AFTER construction, which is why the check is
    // made here and not only at registration.
    const c = new Cascade(baseConfig, '/tmp');
    c.on('clarification:required', () => {});
    c.setUnattended(true);
    await expect(c.askUser(ONE)).resolves.toEqual({ outcome: 'no-listener', answers: [] });
  });

  it('does not interrupt a run whose whole point is not being interrupted', async () => {
    const c = new Cascade({ ...baseConfig, autonomy: 'auto' } as CascadeConfig, '/tmp');
    c.on('clarification:required', () => {});
    await expect(c.askUser(ONE)).resolves.toEqual({ outcome: 'no-listener', answers: [] });
  });

  it('routes the answer to the question that asked it', async () => {
    const c = new Cascade(baseConfig, '/tmp');
    let seen: { requestId?: string } = {};
    c.on('clarification:required', (e: unknown) => {
      seen = e as { requestId?: string };
      c.resolveClarification([{ id: 'q1', value: 'A' }], seen.requestId);
    });

    await expect(c.askUser(ONE)).resolves.toEqual({
      outcome: 'answered',
      answers: [{ id: 'q1', value: 'A' }],
    });
    expect(seen.requestId, 'the id the answer has to name').toBeTruthy();
  });

  it('unparks the run when the person presses Stop', async () => {
    // They pressed Stop and watched the question stay on screen while the run
    // sat holding its worker — the same failure the escalation gate exists to
    // avoid, one gate along.
    const c = new Cascade(baseConfig, '/tmp');
    c.on('clarification:required', () => {});
    const abort = new AbortController();

    const asking = c.askUser(ONE, abort.signal);
    abort.abort();

    await expect(asking).resolves.toEqual({ outcome: 'aborted', answers: [] });
  });

  it('does not even ask when the run is already stopped', async () => {
    const c = new Cascade(baseConfig, '/tmp');
    c.on('clarification:required', () => { throw new Error('should not have asked'); });
    await expect(c.askUser(ONE, AbortSignal.abort())).resolves.toEqual({ outcome: 'aborted', answers: [] });
  });

  it('gives up on its own, so an unanswered question is not a stuck run', async () => {
    vi.useFakeTimers();
    try {
      const c = new Cascade(baseConfig, '/tmp');
      const timedOut: unknown[] = [];
      c.on('clarification:required', () => {});
      c.on('clarification:timeout', (e: unknown) => timedOut.push(e));

      const asking = c.askUser(ONE);
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 100);

      await expect(asking).resolves.toEqual({ outcome: 'timeout', answers: [] });
      expect(timedOut, 'and says so, rather than going quiet').toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the first of answer and timeout win, and makes the loser a no-op', async () => {
    // Answer, timeout and abort all race. Settling twice would resolve a
    // promise nobody is holding any more, or worse, answer the NEXT question
    // with this one's reply.
    vi.useFakeTimers();
    try {
      const c = new Cascade(baseConfig, '/tmp');
      let requestId: string | undefined;
      c.on('clarification:required', (e: unknown) => { requestId = (e as { requestId: string }).requestId; });

      const asking = c.askUser(ONE);
      await vi.advanceTimersByTimeAsync(0);
      c.resolveClarification([{ id: 'q1', value: 'A' }], requestId);
      // The timeout fires afterwards and must change nothing.
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 100);

      await expect(asking).resolves.toEqual({
        outcome: 'answered',
        answers: [{ id: 'q1', value: 'A' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
