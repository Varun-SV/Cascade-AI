import { describe, expect, it } from 'vitest';
import { assembleFinishedWork, budgetNote, keepFirst, plannedCallUsd, sectionsWithin, workersWithin } from './run-budget.js';
import type { ModelInfo } from '../../types.js';

/** $3 per million input tokens, $15 per million output: one planned call is $0.015. */
const PRICED = {
  id: 'sonnet', provider: 'anthropic', inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015,
} as unknown as ModelInfo;
const LOCAL = { id: 'llama', provider: 'ollama', inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, isLocal: true } as unknown as ModelInfo;

describe('sizing a plan to the budget', () => {
  it('prices a call of the plan\'s shape', () => {
    expect(plannedCallUsd(PRICED)).toBeCloseTo(0.015, 6);
    expect(plannedCallUsd(undefined)).toBe(0);
  });

  it('counts the sections the work budget pays for', () => {
    // A section: 3 manager calls ($0.045) + 2 workers × 4 calls ($0.12) = $0.165.
    expect(sectionsWithin(0.8, PRICED, PRICED)).toBe(4);
    expect(sectionsWithin(3, PRICED, PRICED)).toBe(18);
  });

  it('always allows one section with one worker: a plan of nothing answers nothing', () => {
    expect(sectionsWithin(0.01, PRICED, PRICED)).toBe(1);
    expect(workersWithin(0.01, PRICED, PRICED)).toBe(1);
  });

  it('sets no limit where the models have no price', () => {
    expect(sectionsWithin(0.8, LOCAL, LOCAL)).toBeNull();
    expect(workersWithin(0.8, LOCAL, LOCAL)).toBe(Number.POSITIVE_INFINITY);
  });

  it('counts the workers a section\'s share pays for, after its manager', () => {
    // $0.30 - $0.045 for the manager = $0.255, at $0.06 a worker.
    expect(workersWithin(0.3, PRICED, PRICED)).toBe(4);
  });

  it('keeps an item only with the items it depends on, never rewriting its dependencies', () => {
    // s1 depends on s3, planned later: keeping s1 means keeping s3, so s2 goes.
    const plan = [
      { id: 's1', dependsOn: ['s3'] },
      { id: 's2', dependsOn: [] as string[] },
      { id: 's3', dependsOn: [] as string[] },
    ];
    const kept = keepFirst(plan, 2, (i) => i.id);
    expect(kept.map((i) => i.id)).toEqual(['s1', 's3']);
    expect(kept[0]!.dependsOn).toEqual(['s3']);
    expect(keepFirst(plan, 5, (i) => i.id)).toEqual(plan);
  });

  it('drops an item whose prerequisites do not fit beside it, and keeps what does', () => {
    const plan = [
      { id: 'a', dependsOn: [] as string[] },
      { id: 'b', dependsOn: ['c', 'd'] }, // needs three places; only one is left
      { id: 'c', dependsOn: [] as string[] },
      { id: 'd', dependsOn: [] as string[] },
    ];
    expect(keepFirst(plan, 2, (i) => i.id).map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('follows dependencies through other items', () => {
    const plan = [
      { id: 'apply', dependsOn: ['change'] },
      { id: 'change', dependsOn: ['research'] },
      { id: 'other', dependsOn: [] as string[] },
      { id: 'research', dependsOn: [] as string[] },
    ];
    expect(keepFirst(plan, 3, (i) => i.id).map((i) => i.id)).toEqual(['apply', 'change', 'research']);
    // Two places cannot hold the whole chain: its end goes, and the next
    // item in the plan's order that fits with its prerequisite is kept.
    expect(keepFirst(plan, 2, (i) => i.id).map((i) => i.id)).toEqual(['change', 'research']);
  });

  it('keeps the smallest whole group when a cycle leaves nothing that fits', () => {
    const plan = [
      { id: 'p', dependsOn: ['q'] },
      { id: 'q', dependsOn: ['p'] },
      { id: 'r', dependsOn: ['p', 'q'] },
    ];
    expect(keepFirst(plan, 1, (i) => i.id).map((i) => i.id)).toEqual(['p', 'q']);
  });
});

describe('what a wrapped-up run says', () => {
  it('names the budget the planned work did not fit in', () => {
    expect(budgetNote({ capUsd: 1, spentUsd: 0.8, usedTokens: 0, wrappingUp: true, workNotStarted: 1 }))
      .toMatch(/not all the planned work fitted in this task's \$1\.00 budget \(\$0\.80 spent\)/);
    expect(budgetNote({ capTokens: 200_000, spentUsd: 0, usedTokens: 160_000, wrappingUp: true, workNotStarted: 1 }))
      .toMatch(/this task's 200,000-token budget \(160,000 used\)/);
  });

  it('returns the finished work under headings, then what was not finished', () => {
    const out = assembleFinishedWork([{ title: 'Pricing', text: 'Three tiers.' }], ['Benchmarks'], 'No budget left to write it up.');
    expect(out).toBe('_No budget left to write it up._\n\n## Pricing\n\nThree tiers.\n\n**Not finished:** Benchmarks.');
  });
});
