// ─────────────────────────────────────────────
//  Cascade AI — Cheaper models as the budget runs down
// ─────────────────────────────────────────────
//
// With a cost cap, Cascade Auto only picks among models a subtask can afford:
// one call may cost a quarter of what is left for work, split across the calls
// a manager or worker makes. What it passed over is said, for /why.

import { describe, expect, it, vi } from 'vitest';
import { TaskAnalyzer } from './task-analyzer.js';
import { CascadeRouter } from './index.js';
import type { ModelSelector } from './selector.js';
import type { CascadeConfig, ModelInfo } from '../../types.js';

const model = (id: string, inPer1k: number, outPer1k: number) =>
  ({ id, provider: 'anthropic', inputCostPer1kTokens: inPer1k, outputCostPer1kTokens: outPer1k }) as unknown as ModelInfo;

// A planned call (1,500 in, 700 out): BIG $0.075, MID $0.015, SMALL $0.0012.
const BIG = model('big', 0.015, 0.075);
const MID = model('mid', 0.003, 0.015);
const SMALL = model('small', 0.0003, 0.00125);

function analyzerPreferring(order: ModelInfo[]) {
  const analyzer = new TaskAnalyzer();
  // The benchmark-and-cost score is not what is under test: rank by the order given.
  (analyzer as unknown as { scoreModel: (m: ModelInfo) => number }).scoreModel = (m) => order.length - order.indexOf(m);
  const selector = {
    getCandidatesForTier: () => [SMALL, MID, BIG],
    selectForTier: () => BIG,
    selectVisionModel: () => null,
  } as unknown as ModelSelector;
  return { analyzer, selector };
}

describe('Cascade Auto under a budget', () => {
  it('picks the preferred model when the budget can afford it', async () => {
    const { analyzer, selector } = analyzerPreferring([BIG, MID, SMALL]);
    const { model: chosen } = await analyzer.select('write the report', 'T3', selector, { maxCallUsd: 0.1 });
    expect(chosen?.id).toBe('big');
  });

  it('passes over a model a call cannot afford, and says so', async () => {
    const { analyzer, selector } = analyzerPreferring([BIG, MID, SMALL]);
    const { model: chosen, note } = await analyzer.select('write the report', 'T3', selector, { maxCallUsd: 0.02 });
    expect(chosen?.id).toBe('mid');
    expect(note).toMatch(/chose mid over big, which costs more than what is left of this task's budget allows/);
  });

  it('runs the cheapest when none is within reach', async () => {
    const { analyzer, selector } = analyzerPreferring([BIG, MID, SMALL]);
    const { model: chosen } = await analyzer.select('write the report', 'T3', selector, { maxCallUsd: 0.0001 });
    expect(chosen?.id).toBe('small');
  });

  it('changes nothing without a limit', async () => {
    const { analyzer, selector } = analyzerPreferring([BIG, MID, SMALL]);
    const { model: chosen, note } = await analyzer.select('write the report', 'T3', selector);
    expect(chosen?.id).toBe('big');
    expect(note).toBeNull();
  });
});

describe('Cascade Auto under a budget, for a subtask that needs vision', () => {
  const vision = (id: string, inPer1k: number, outPer1k: number) => ({ ...model(id, inPer1k, outPer1k), isVisionCapable: true }) as ModelInfo;
  // Planned call: BIG_EYES $0.075, SMALL_EYES $0.015. SMALL (no vision) is cheaper than both.
  const BIG_EYES = vision('big-eyes', 0.015, 0.075);
  const SMALL_EYES = vision('small-eyes', 0.003, 0.015);

  function visionSelector() {
    const analyzer = new TaskAnalyzer();
    const selector = {
      getCandidatesForTier: () => [SMALL, BIG_EYES, SMALL_EYES],
      selectForTier: () => BIG,
      // The vision route's own preference, best first.
      selectVisionModel: () => BIG_EYES,
      visionModels: () => [BIG_EYES, SMALL_EYES],
    } as unknown as ModelSelector;
    return { analyzer, selector };
  }
  const PROMPT = 'describe what this screenshot shows';

  it('keeps the preferred vision model when a call can afford it', async () => {
    const { analyzer, selector } = visionSelector();
    const { model: chosen, note } = await analyzer.select(PROMPT, 'T3', selector, { maxCallUsd: 0.1 });
    expect(chosen?.id).toBe('big-eyes');
    expect(note).toBeNull();
  });

  it('takes a vision model the budget affords, never one that cannot see', async () => {
    const { analyzer, selector } = visionSelector();
    const { model: chosen, note } = await analyzer.select(PROMPT, 'T3', selector, { maxCallUsd: 0.02 });
    expect(chosen?.id).toBe('small-eyes');
    expect(note).toMatch(/chose small-eyes over big-eyes, which costs more than what is left of this task's budget allows/);
  });

  it('runs the cheapest vision model when none is within reach', async () => {
    const { analyzer, selector } = visionSelector();
    const { model: chosen } = await analyzer.select(PROMPT, 'T3', selector, { maxCallUsd: 0.0001 });
    expect(chosen?.id).toBe('small-eyes');
  });

  it('changes nothing for a vision subtask without a limit', async () => {
    const { analyzer, selector } = visionSelector();
    const { model: chosen, note } = await analyzer.select(PROMPT, 'T3', selector);
    expect(chosen?.id).toBe('big-eyes');
    expect(note).toBeNull();
  });
});

describe('the router hands Auto what a call can afford', () => {
  async function routerWith(budget?: CascadeConfig['budget']) {
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
    (router as unknown as Record<string, unknown>)['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
    await router.init({ providers: [], models: {}, tools: { allowedTools: [] }, cascadeAuto: true, ...(budget ? { budget } : {}) } as unknown as CascadeConfig);
    router.beginRun();
    const select = vi.fn(async () => ({ model: MID, note: null }));
    (router as unknown as { taskAnalyzer: unknown }).taskAnalyzer = { select };
    return { router, select };
  }

  it('lets a worker call cost a quarter of what is left for work, over its four calls', async () => {
    const { router, select } = await routerWith({ maxCostPerRunUsd: 1 });
    (router as unknown as { runCostUsd: number }).runCostUsd = 0.4;
    await router.selectModelForSubtask('T3', 'write the report');
    // $0.80 for work, $0.40 spent: $0.40 left, a quarter is $0.10, over 4 calls.
    expect((select.mock.calls[0] as unknown[])[3]).toMatchObject({ maxCallUsd: expect.closeTo(0.025, 6) });
  });

  it('and a section manager over its three', async () => {
    const { router, select } = await routerWith({ maxCostPerRunUsd: 1 });
    await router.selectModelForSubtask('T2', 'plan the section');
    expect((select.mock.calls[0] as unknown[])[3]).toMatchObject({ maxCallUsd: expect.closeTo(0.8 / 12, 6) });
  });

  it('sets no limit without a cost cap', async () => {
    const { router, select } = await routerWith();
    await router.selectModelForSubtask('T3', 'write the report', { requiresToolUse: true });
    expect((select.mock.calls[0] as unknown[])[3]).toEqual({ requiresToolUse: true });
  });
});
