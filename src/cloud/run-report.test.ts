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

  it('tells a free local model apart from a model with no price', () => {
    const rec = (router as unknown as {
      recordStats: (tier: string, model: { id: string; provider: string }, usage: Record<string, unknown>) => void;
    }).recordStats.bind(router);
    // Priced at $0: a local model really is free.
    rec('T3', { id: 'llama', provider: 'ollama' }, { inputTokens: 800, outputTokens: 200, totalTokens: 1000, estimatedCostUsd: 0 });
    // No published price: its spend could not be counted.
    rec('T3', { id: 'mystery', provider: 'openai-compatible' }, {
      inputTokens: 500, outputTokens: 0, totalTokens: 500, estimatedCostUsd: 0, costUnknown: true,
    });
    const report = cloudRunReport({ stats: router.getStats(), t1Model: t1, decisions: [], durationMs: 0 });
    expect(report.tokensByModel['T3']).toEqual({ 'ollama:llama': 1000, 'openai-compatible:mystery': 500 });
    expect(report.unpricedByModel).toEqual({ T3: { 'openai-compatible:mystery': 1 } });
  });

  it('keeps a late call from the previous run out of the next run\'s report', () => {
    const rec = (router as unknown as {
      recordStats: (tier: string, model: { id: string; provider: string }, usage: Record<string, unknown>, featureTag?: string, generation?: number) => void;
    }).recordStats.bind(router);
    const usage = (tokens: number, cost: number) => ({ inputTokens: tokens, outputTokens: 0, totalTokens: tokens, estimatedCostUsd: cost });

    router.beginRun();
    const first = router.getRunGeneration();
    rec('T1', { id: 'big', provider: 'anthropic' }, usage(1000, 0.01), undefined, first);

    router.beginRun();
    const second = router.getRunGeneration();
    rec('T3', { id: 'mini', provider: 'openai' }, usage(1000, 0.001), undefined, second);
    // A call admitted in the first run settles now, while the second is running.
    rec('T1', { id: 'big', provider: 'anthropic' }, usage(2000, 0.02), undefined, first);

    const report = cloudRunReport({ stats: router.getRunStats(second), t1Model: t1, decisions: [], durationMs: 0 });
    expect(report.totalCostUsd).toBeCloseTo(0.001, 8);
    expect(report.totalTokens).toBe(1000);
    expect(report.costByModel).toEqual({ T3: { 'openai:mini': 0.001 } });
    // The straggler stays with the run that made it.
    expect(router.getRunStats(first).totalCostUsd).toBeCloseTo(0.03, 8);
    expect(router.getRunStats(first).costByTierModel).toEqual({ T1: { 'anthropic:big': 0.03 } });
    // The session total still counts both: the money was spent either way.
    expect(router.getStats().totalCostUsd).toBeCloseTo(0.031, 8);
  });

  it('waits for a run\'s late call, so its report includes it', async () => {
    const r = router as unknown as {
      generateCall: (...a: unknown[]) => Promise<unknown>;
      recordStats: (tier: string, model: { id: string; provider: string }, usage: Record<string, unknown>, featureTag?: string, generation?: number) => void;
    };
    router.beginRun();
    const first = router.getRunGeneration();
    // A call admitted in the first run that settles only after the next begins.
    let settle!: () => void;
    r.generateCall = () => new Promise((resolve) => { settle = () => {
      r.recordStats('T3', { id: 'mini', provider: 'openai' }, { inputTokens: 500, outputTokens: 0, totalTokens: 500, estimatedCostUsd: 0.0005 }, undefined, first);
      resolve({});
    }; });
    const call = router.generate('T3', { messages: [] } as never);
    router.beginRun();

    let settled: boolean | undefined;
    const waiting = router.whenRunSettled(first, 5_000).then((v) => { settled = v; });
    await Promise.resolve();
    expect(settled).toBeUndefined();
    expect(router.getRunStats(first).totalTokens).toBe(0);
    settle();
    await call;
    await waiting;
    expect(settled).toBe(true);
    expect(router.getRunStats(first).totalTokens).toBe(500);
    expect(router.getRunStats().totalTokens).toBe(0);
  });

  it('stops waiting for a run whose call never settles', async () => {
    const r = router as unknown as { generateCall: (...a: unknown[]) => Promise<unknown> };
    router.beginRun();
    r.generateCall = () => new Promise(() => {});
    void router.generate('T3', { messages: [] } as never);
    expect(await router.whenRunSettled(router.getRunGeneration(), 20)).toBe(false);
    // A run with nothing in flight has settled already.
    router.beginRun();
    expect(await router.whenRunSettled(router.getRunGeneration(), 20)).toBe(true);
  });

  it('keeps a model whose id is __proto__', () => {
    const rec = (router as unknown as {
      recordStats: (tier: string, model: { id: string; provider: string }, usage: Record<string, unknown>) => void;
    }).recordStats.bind(router);
    rec('T3', { id: '__proto__', provider: '' }, { inputTokens: 10, outputTokens: 0, totalTokens: 10, estimatedCostUsd: 0.001, costUnknown: true });
    const report = cloudRunReport({ stats: router.getStats(), t1Model: t1, decisions: [], durationMs: 0, before: { ...router.getStats(), totalTokens: 0, totalCostUsd: 0, costByTierModel: {}, tokensByTierModel: {}, untrackedByTierModel: {} } });
    const parsed = JSON.parse(JSON.stringify(report)) as { costByModel: Record<string, Record<string, number>>; tokensByModel: Record<string, Record<string, number>>; unpricedByModel: Record<string, Record<string, number>> };
    expect(Object.keys(parsed.tokensByModel['T3']!)).toEqual([':__proto__']);
    // The id with an empty provider is ':__proto__'; one with none at all is still an own key.
    const bare = Object.fromEntries([['__proto__', 5]]) as Record<string, number>;
    const kept = cloudRunReport({ stats: { ...router.getStats(), tokensByTierModel: { T3: bare }, costByTierModel: { T3: bare }, untrackedByTierModel: { T3: bare } }, before: { ...router.getStats(), totalTokens: 0, totalCostUsd: 0, tokensByTierModel: {}, costByTierModel: {}, untrackedByTierModel: {} }, t1Model: t1, decisions: [], durationMs: 0 });
    expect(Object.prototype.hasOwnProperty.call(kept.tokensByModel['T3'], '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(kept)).unpricedByModel.T3).toEqual(JSON.parse('{"__proto__":5}'));
  });

  it('keeps each run\'s cost by feature', () => {
    const rec = (router as unknown as {
      recordStats: (tier: string, model: { id: string; provider: string }, usage: Record<string, unknown>, featureTag?: string) => void;
    }).recordStats.bind(router);
    router.beginRun();
    rec('T2', { id: 'mini', provider: 'openai' }, { inputTokens: 10, outputTokens: 0, totalTokens: 10, estimatedCostUsd: 0.002 }, 'Research');
    router.beginRun();
    rec('T2', { id: 'mini', provider: 'openai' }, { inputTokens: 10, outputTokens: 0, totalTokens: 10, estimatedCostUsd: 0.001 }, 'Write-up');
    expect(router.getRunStats().costByFeature).toEqual({ 'Write-up': 0.001 });
    expect(router.getStats().costByFeature).toEqual({ Research: 0.002, 'Write-up': 0.001 });
  });

  it('forgets per-run usage when the stats are reset between independent tasks', () => {
    router.beginRun();
    call('T3', 'openai', 'mini', 1000, 0, 0.001);
    router.resetStats();
    expect(router.getRunStats().totalTokens).toBe(0);
    call('T3', 'openai', 'mini', 100, 0, 0.0001);
    expect(router.getRunStats().totalTokens).toBe(100);
    expect(router.getRunStats().totalCostUsd).toBeCloseTo(0.0001, 8);
  });

  it('keeps a run that is still settling, however many runs come after it', async () => {
    const r = router as unknown as {
      generateCall: (...a: unknown[]) => Promise<unknown>;
      recordStats: (tier: string, model: { id: string; provider: string }, usage: Record<string, unknown>, featureTag?: string, generation?: number) => void;
    };
    router.beginRun();
    const slow = router.getRunGeneration();
    r.recordStats('T3', { id: 'mini', provider: 'openai' }, { inputTokens: 100, outputTokens: 0, totalTokens: 100, estimatedCostUsd: 0.0001 }, undefined, slow);
    let settle!: () => void;
    r.generateCall = () => new Promise((resolve) => { settle = () => {
      r.recordStats('T3', { id: 'mini', provider: 'openai' }, { inputTokens: 400, outputTokens: 0, totalTokens: 400, estimatedCostUsd: 0.0004 }, undefined, slow);
      resolve({});
    }; });
    const pending = router.generate('T3', { messages: [] } as never);
    for (let i = 0; i < 12; i++) {
      router.beginRun();
      call('T3', 'openai', 'mini', 10, 0, 0.00001);
    }
    settle();
    await pending;
    expect(await router.whenRunSettled(slow, 100)).toBe(true);
    expect(router.getRunStats(slow).totalTokens).toBe(500);
  });

  it('keeps only recent runs, and reports an unknown run as empty', () => {
    for (let i = 0; i < 12; i++) {
      router.beginRun();
      call('T3', 'openai', 'mini', 100, 0, 0.0001);
    }
    const latest = router.getRunGeneration();
    expect(router.getRunStats(latest).totalTokens).toBe(100);
    expect(router.getRunStats(latest - 11).totalTokens).toBe(0);
    expect(router.getRunStats(-1)).toMatchObject({ totalTokens: 0, totalCostUsd: 0, costByTierModel: {} });
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
