import { describe, it, expect } from 'vitest';
import { answeredExactly, assessRun, modelBindingsMatch, pageShows, scheduleRuns, summarise } from './results.mjs';
import { TASKS } from './tasks.mjs';

describe('browser comparison validity', () => {
  const taskList = [{ id: 'a' }, { id: 'b' }];
  it('interleaves all settings for each task/repeat and preserves the complete matrix', () => {
    const rows = [...scheduleRuns(['m1', 'm2'], ['off', 'list', 'image', 'marked'], taskList, 2)];
    expect(rows).toHaveLength(32);
    expect(new Set(rows.map((r) => `${r.model}/${r.arm}/${r.task.id}/${r.repeat}`)).size).toBe(32);
    for (const model of ['m1', 'm2']) {
      expect(new Set(rows.slice(0, 8).filter((r) => r.model === model).map((r) => r.arm)).size).toBe(4);
    }
    const starts = rows.filter((r, i) => i % 4 === 0).map((r) => r.arm);
    expect(new Set(starts).size).toBeGreaterThan(1);
  });

  it('rejects initial model substitutions and fallback-served results', () => {
    const bound = { id: 'requested', provider: 'openai' };
    expect(modelBindingsMatch('requested', [bound, bound, bound])).toBe(true);
    expect(modelBindingsMatch('openai:requested', [bound, bound, bound])).toBe(true);
    expect(modelBindingsMatch('requested', [bound, { ...bound, id: 'fallback' }, bound])).toBe(false);
    const row = assessRun({ ok: true, usage: { totalTokens: 20, estimatedCostUsd: 0.2 }, decisions: [{ kind: 'failover' }] });
    expect(row).toMatchObject({ valid: false, ok: false, costUsd: 0.2, tokens: 20 });
    expect(row.error).toMatch(/excluded/i);
  });

  it('retains recorded partial usage after a late failure and keeps missing usage unknown', () => {
    expect(assessRun({ ok: false, error: 'late failure', stats: { totalTokens: 40, totalCostUsd: 0.1 } }))
      .toMatchObject({ valid: true, ok: false, tokens: 40, costUsd: 0.1 });
    expect(assessRun({ ok: false, error: 'no usage available' })).toMatchObject({ tokens: null, costUsd: null });
    expect(assessRun({ stats: { totalTokens: 40, totalCostUsd: 0.1, untrackedCostCalls: 1 } }).costUsd).toBeNull();
  });

  it('excludes substituted models and unavailable measurements from means', () => {
    const base = { model: 'm', arm: 'image', task: 'a', steps: 1 };
    const rows = [
      { ...base, ...assessRun({ ok: true, usage: { totalTokens: 20, estimatedCostUsd: 0.2 } }) },
      { ...base, ...assessRun({ ok: true, usage: { totalTokens: 9000, estimatedCostUsd: 99 }, decisions: [{ kind: 'failover' }] }) },
      { ...base, ...assessRun({ ok: false, error: 'missing' }) },
      { ...base, ...assessRun({ ok: false, stats: { totalTokens: 40, totalCostUsd: 0.1 } }) },
    ];
    const report = summarise(rows, taskList);
    expect(report).toContain('3/4');
    expect(report).toContain('$0.1500');
    expect(report).not.toContain('$24.');
    const unknown = summarise([{ ...base, ...assessRun({ error: 'missing' }) }], taskList);
    expect(unknown).toContain('n/a');
    expect(unknown).not.toContain('$0.0000');
  });

  it('passes an answer-scored run only on the short answer itself', () => {
    const answers = Object.fromEntries(TASKS.filter((t) => t.check.answer).map((t) => [t.id, t.check.answer]));
    expect(answeredExactly(answers.plans, 'Team')).toBe(true);
    expect(answeredExactly(answers.plans, '**Team**.')).toBe(true);
    expect(answeredExactly(answers.plans, ' "team" ')).toBe(true);
    expect(answeredExactly(answers.reviews, '5')).toBe(true);
    expect(answeredExactly(answers.reviews, '5 stars')).toBe(true);
    expect(answeredExactly(answers.menu, '₹640')).toBe(true);
    expect(answeredExactly(answers.menu, 'Rs. 640')).toBe(true);
    // Mentioning the answer, guessing between answers, or explaining a failure.
    expect(answeredExactly(answers.plans, 'I could not verify whether Team is the middle plan')).toBe(false);
    expect(answeredExactly(answers.plans, 'Team or Pro')).toBe(false);
    expect(answeredExactly(answers.reviews, 'Probably 5, but I could not open the tab')).toBe(false);
    expect(answeredExactly(answers.reviews, '15')).toBe(false);
    expect(answeredExactly(answers.menu, '6400')).toBe(false);
    expect(answeredExactly(answers.menu, 'I could not find 640 on the menu')).toBe(false);
    expect(answeredExactly(answers.menu, undefined)).toBe(false);
  });

  it('lets the scripted check find the answer on the page, as a whole word', () => {
    expect(pageShows(['Team'], 'Pro ₹999 a month Basic ₹199 a month Team ₹2,499 a month')).toBe(true);
    expect(pageShows(['640'], 'Mushroom risotto — ₹640')).toBe(true);
    expect(pageShows(['5'], 'Priya — 15 stars')).toBe(false);
  });

  it('excludes a picture setting whose model was sent text in place of screenshots', () => {
    expect(assessRun({ ok: true, arm: 'image', shots: { sent: 0, leftOut: 3 } })).toMatchObject({ valid: false, ok: false });
    expect(assessRun({ ok: true, arm: 'marked', shots: { sent: 2, leftOut: 1 } }).error).toMatch(/not a fair marked run/);
    expect(assessRun({ ok: true, arm: 'image', shots: { sent: 4, leftOut: 0 } })).toMatchObject({ valid: true, ok: true });
    // The list settings send no pictures to begin with.
    expect(assessRun({ ok: true, arm: 'list', shots: { sent: 0, leftOut: 2 } })).toMatchObject({ valid: true, ok: true });
    expect(assessRun({ ok: true })).toMatchObject({ valid: true });
  });
});
