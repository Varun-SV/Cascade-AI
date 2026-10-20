import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from '../core/router/index.js';
import type { CascadeConfig, ModelInfo } from '../types.js';
import { cloudRunReport, cloudTurnAccounting } from './run-report.js';

async function makeRouter(): Promise<CascadeRouter> {
  const router = new CascadeRouter();
  (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
  (router as unknown as Record<string, unknown>)['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
  await router.init({ providers: [], models: {}, tools: { allowedTools: [] } } as unknown as CascadeConfig);
  return router;
}

// $10 in and $30 out per million tokens: what the run would have cost on T1.
const t1 = { id: 'big', provider: 'anthropic', inputCostPer1kTokens: 0.01, outputCostPer1kTokens: 0.03 } as ModelInfo;

describe('a device run\'s /why for the cloud', () => {
  let router: CascadeRouter;
  const call = (tier: string, provider: string, id: string, input: number, output: number, cost: number) =>
    (router as unknown as {
      recordStats: (tier: string, model: { id: string; provider: string }, usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number }) => void;
    }).recordStats(tier, { id, provider }, { inputTokens: input, outputTokens: output, totalTokens: input + output, estimatedCostUsd: cost });

  beforeEach(async () => { router = await makeRouter(); });

  it('splits a run by tier and model, and says what it saved against T1', () => {
    call('T1', 'anthropic', 'big', 1000, 0, 0.01);
    call('T3', 'openai', 'mini', 1000, 1000, 0.002);
    call('T3', 'openai', 'nano', 3000, 0, 0.0003);

    const report = cloudRunReport({ stats: router.getStats(), t1Model: t1, decisions: [], durationMs: 1200 });
    expect(report.totalCostUsd).toBeCloseTo(0.0123, 8);
    expect(report.totalTokens).toBe(6000);
    expect(report.costByModel['T3']).toEqual({ 'openai:mini': 0.002, 'openai:nano': 0.0003 });
    expect(report.tokensByModel['T3']).toEqual({ 'openai:mini': 2000, 'openai:nano': 3000 });
    // T1 would have charged $0.01 + $0.04 + $0.03 = $0.08.
    expect(report.savedUsd).toBeCloseTo(0.08 - 0.0123, 8);
    // The tier with the most work, and each tier's busiest model.
    expect(report.tier).toBe('T3');
    expect(report.model).toBe('openai:nano');
    expect(report.models).toEqual({ T1: 'anthropic:big', T3: 'openai:nano' });
    expect(report.durationMs).toBe(1200);
  });

  it('counts only what a run added when the router serves a whole session', () => {
    call('T1', 'anthropic', 'big', 1000, 1000, 0.04);
    const before = router.getStats();
    call('T3', 'openai', 'mini', 1000, 0, 0.001);

    const report = cloudRunReport({ stats: router.getStats(), before, t1Model: t1, decisions: [], durationMs: 0 });
    expect(report.totalCostUsd).toBeCloseTo(0.001, 8);
    expect(report.totalTokens).toBe(1000);
    expect(report.costByTier).toEqual({ T3: 0.001 });
    expect(report.costByModel).toEqual({ T3: { 'openai:mini': 0.001 } });
    // Savings against T1 for this run's 1,000 tokens alone: $0.01 − $0.001.
    expect(report.savedUsd).toBeCloseTo(0.009, 8);
    expect(report.models).toEqual({ T3: 'openai:mini' });
  });

  it('takes the stats as they are when they were reset since the run began', () => {
    call('T1', 'anthropic', 'big', 1000, 1000, 0.04);
    const before = router.getStats();
    router.resetStats();
    call('T3', 'openai', 'mini', 500, 0, 0.0005);

    const report = cloudRunReport({ stats: router.getStats(), before, t1Model: t1, decisions: [], durationMs: 0 });
    expect(report.totalCostUsd).toBeCloseTo(0.0005, 8);
    expect(report.costByModel).toEqual({ T3: { 'openai:mini': 0.0005 } });
  });

  it('claims no savings for a run with a call on a model that has no price', () => {
    call('T3', 'openai', 'mini', 1000, 0, 0.001);
    (router as unknown as {
      recordStats: (tier: string, model: { id: string; provider: string }, usage: Record<string, unknown>) => void;
    }).recordStats('T3', { id: 'mystery', provider: 'openai-compatible' }, {
      inputTokens: 5000, outputTokens: 0, totalTokens: 5000, estimatedCostUsd: 0, costUnknown: true,
    });
    const report = cloudRunReport({ stats: router.getStats(), t1Model: t1, decisions: [], durationMs: 0 });
    expect(report.savedUsd).toBe(0);
  });

  it('does not hold an earlier run\'s unpriced call against a later one', () => {
    (router as unknown as {
      recordStats: (tier: string, model: { id: string; provider: string }, usage: Record<string, unknown>) => void;
    }).recordStats('T3', { id: 'mystery', provider: 'openai-compatible' }, {
      inputTokens: 5000, outputTokens: 0, totalTokens: 5000, estimatedCostUsd: 0, costUnknown: true,
    });
    const before = router.getStats();
    call('T3', 'openai', 'mini', 1000, 0, 0.001);
    const report = cloudRunReport({ stats: router.getStats(), before, t1Model: t1, decisions: [], durationMs: 0 });
    expect(report.savedUsd).toBeCloseTo(0.009, 8);
  });

  it('is what the cloud\'s /turns takes: the cost, and the report as JSON', () => {
    call('T2', 'openai', 'mini', 100, 0, 0.0001);
    const report = cloudRunReport({ stats: router.getStats(), t1Model: null, decisions: [{ at: 'now', kind: 'model', detail: 'T2 → mini' }], durationMs: 5 });
    const accounting = cloudTurnAccounting(report);
    expect(accounting.costUsd).toBeCloseTo(0.0001, 8);
    expect(JSON.parse(accounting.why)).toEqual(report);
    // No T1 model to compare against: no savings claimed.
    expect(report.savedUsd).toBe(0);
  });
});
