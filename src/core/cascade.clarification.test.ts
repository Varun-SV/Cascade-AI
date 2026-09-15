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

describe('ask_user is offered only where somebody can answer', () => {
  it('is absent until a host says it can put the question to a person', () => {
    // Registering a tool is a promise the host has to keep. A host that offers
    // `ask_user` without listening for `clarification:required` hands the model
    // a tool that always answers "there is nobody watching this run" — while a
    // person sits at the terminal looking at it. Worse than not offering it:
    // it costs a round trip and then says something false.
    //
    // Only cloud/server bridges the protocol today; the CLI REPL and the
    // dashboard do not, and must not advertise it.
    const c = new Cascade(baseConfig, '/tmp');
    expect(c.getToolRegistry().hasTool('ask_user'), 'not offered by default').toBe(false);

    c.enableClarification();
    expect(c.getToolRegistry().hasTool('ask_user'), 'offered once a host can serve it').toBe(true);
  });

  it('stays absent on a run that has nobody on it, whatever the host claims', () => {
    const c = new Cascade(baseConfig, '/tmp');
    c.setUnattended(true);
    c.enableClarification();
    expect(c.getToolRegistry().hasTool('ask_user')).toBe(false);
  });

  it('stays absent on a run whose whole point is not being interrupted', () => {
    const c = new Cascade({ ...baseConfig, autonomy: 'auto' } as CascadeConfig, '/tmp');
    c.enableClarification();
    expect(c.getToolRegistry().hasTool('ask_user')).toBe(false);
  });

  it('honours a deployment that turned it off', () => {
    const c = new Cascade(
      { ...baseConfig, tools: { ...baseConfig.tools, disabledTools: ['ask_user'] } } as CascadeConfig,
      '/tmp',
    );
    c.enableClarification();
    expect(c.getToolRegistry().hasTool('ask_user')).toBe(false);
  });
});

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

  it('says the question is over however it ended, so no dead form is left standing', async () => {
    // The form has no other way to learn it is closed. An abort and a teardown
    // release both settle silently, so Stop used to leave a live questionnaire
    // whose submit button answered a request nobody held — and because the
    // queue shows the oldest first, that dead form sat in front of every later
    // question the run asked.
    const c = new Cascade(baseConfig, '/tmp');
    const closed: Array<{ requestId?: string }> = [];
    c.on('clarification:required', () => {});
    c.on('clarification:closed', (e: unknown) => closed.push(e as { requestId?: string }));

    const abort = new AbortController();
    const asking = c.askUser(ONE, abort.signal);
    abort.abort();
    await asking;

    expect(closed, 'Stop closes the form too, not only a timeout').toHaveLength(1);
    expect(closed[0]?.requestId, 'and names which form').toBeTruthy();
  });

  it('is not parked by a listener that throws on the way out', async () => {
    // The close used to be announced BEFORE the promise resolved, which put the
    // whole gate at the mercy of a listener: one that threw unwound `settle`
    // before `resolve` ran, and the map entry was already deleted — so the
    // timeout, the abort and any answer had all become no-ops and the run
    // parked on a question forever. That is the single thing this gate promises
    // cannot happen.
    //
    // The same mistake as the release observer, made again somewhere else.
    const c = new Cascade(baseConfig, '/tmp');
    c.on('clarification:required', () => {});
    c.on('clarification:closed', () => { throw new Error('a listener blew up'); });

    const abort = new AbortController();
    const asking = c.askUser(ONE, abort.signal);
    abort.abort();

    await expect(asking, 'the run is unblocked regardless')
      .resolves.toEqual({ outcome: 'aborted', answers: [] });
  });

  it('is not parked by a timeout listener that throws', async () => {
    // The third place this gate family made the same mistake, and the worst of
    // them. The close announcement at least ran AFTER the map delete, so a
    // throwing listener left a promise nobody could settle; here the emit ran
    // before `settle` itself, so the entry stayed in `pendingClarifications`
    // with the timer already spent — one-shot, nothing else coming.
    //
    // And a timer callback has no caller to unwind into, so the throw does not
    // merely park the run, it surfaces as an uncaught exception.
    vi.useFakeTimers();
    try {
      const c = new Cascade(baseConfig, '/tmp');
      c.on('clarification:required', () => {});
      c.on('clarification:timeout', () => { throw new Error('a listener blew up'); });

      const asking = c.askUser(ONE);
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 100);

      await expect(asking, 'the run is unblocked regardless')
        .resolves.toEqual({ outcome: 'timeout', answers: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('still takes the form down when the timeout listener throws', async () => {
    // Settling first is only half of it. `clarification:closed` is what the
    // client removes the form on, and it is emitted from `settle` — so if the
    // timeout announcement could still unwind the callback, the run would
    // resume while a dead questionnaire stayed on screen in front of every
    // later question.
    vi.useFakeTimers();
    try {
      const c = new Cascade(baseConfig, '/tmp');
      const closed: unknown[] = [];
      c.on('clarification:required', () => {});
      c.on('clarification:closed', (e: unknown) => closed.push(e));
      c.on('clarification:timeout', () => { throw new Error('a listener blew up'); });

      const asking = c.askUser(ONE);
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 100);
      await asking;

      expect(closed, 'the form is closed before the announcement can fail').toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the form exactly once, however many ways it could settle', async () => {
    // The map delete is what makes this exactly-once. Emitting twice would take
    // down a LATER form: the client removes by request id, and a repeat for an
    // id already gone is at best noise, at worst a race with the next question.
    vi.useFakeTimers();
    try {
      const c = new Cascade(baseConfig, '/tmp');
      const closed: unknown[] = [];
      let requestId: string | undefined;
      c.on('clarification:required', (e: unknown) => { requestId = (e as { requestId: string }).requestId; });
      c.on('clarification:closed', (e: unknown) => closed.push(e));

      const asking = c.askUser(ONE);
      await vi.advanceTimersByTimeAsync(0);
      c.resolveClarification([{ id: 'q1', value: 'A' }], requestId);
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 100);
      await asking;

      expect(closed, 'answered, then the timeout fires and changes nothing').toHaveLength(1);
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
