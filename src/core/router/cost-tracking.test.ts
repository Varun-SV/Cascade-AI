// ─────────────────────────────────────────────
//  Cascade AI — Per-Tier Cost Tracking Tests
// ─────────────────────────────────────────────

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CascadeRouter } from './index.js';
import type { CascadeConfig } from '../../types.js';

// ── Helpers ────────────────────────────────────

function makeConfig(overrides: Partial<CascadeConfig> = {}): CascadeConfig {
  return {
    providers: [],
    models: {},
    tools: { allowedTools: [] },
    ...overrides,
  } as unknown as CascadeConfig;
}

/**
 * Reach into router private state via the public getStats() snapshot.
 * We use a real router but stub out provider detection so init() completes
 * without network calls.
 */
async function makeRouter(): Promise<CascadeRouter> {
  const router = new CascadeRouter();
  // Patch private detectAvailableProviders to return empty set (no network)
  (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
  // Patch private discoverOllamaModels to no-op
  (router as unknown as Record<string, unknown>)['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
  await router.init(makeConfig());
  return router;
}

function simulateCall(
  router: CascadeRouter,
  tier: 'T1' | 'T2' | 'T3',
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  featureTag?: string,
): void {
  // Reach into recordStats directly via casting
  const r = router as unknown as {
    recordStats: (tier: string, model: { provider: string }, usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number }, featureTag?: string) => void;
  };
  r.recordStats(tier, { provider: 'anthropic' }, {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: costUsd,
  }, featureTag);
}

// ── Tests ──────────────────────────────────────

describe('RouterStats — per-tier cost tracking', () => {
  let router: CascadeRouter;

  beforeEach(async () => {
    router = await makeRouter();
  });

  it('starts with empty per-tier stats', () => {
    const stats = router.getStats();
    expect(stats.costByTier).toEqual({});
    expect(stats.tokensByTier).toEqual({});
    expect(stats.inputTokensByTier).toEqual({});
    expect(stats.outputTokensByTier).toEqual({});
  });

  it('accumulates cost and tokens for a single tier', () => {
    simulateCall(router, 'T3', 500, 200, 0.0003);

    const stats = router.getStats();
    expect(stats.costByTier['T3']).toBeCloseTo(0.0003, 8);
    expect(stats.tokensByTier['T3']).toBe(700);
    expect(stats.inputTokensByTier['T3']).toBe(500);
    expect(stats.outputTokensByTier['T3']).toBe(200);
  });

  it('accumulates multiple calls for the same tier', () => {
    simulateCall(router, 'T2', 400, 100, 0.0015);
    simulateCall(router, 'T2', 600, 200, 0.0024);

    const stats = router.getStats();
    expect(stats.costByTier['T2']).toBeCloseTo(0.0039, 8);
    expect(stats.tokensByTier['T2']).toBe(1300);
    expect(stats.inputTokensByTier['T2']).toBe(1000);
    expect(stats.outputTokensByTier['T2']).toBe(300);
  });

  it('tracks each tier independently', () => {
    simulateCall(router, 'T1', 2000, 800, 0.042);
    simulateCall(router, 'T2', 800, 300, 0.0066);
    simulateCall(router, 'T3', 300, 100, 0.0002);

    const stats = router.getStats();
    expect(stats.costByTier['T1']).toBeCloseTo(0.042, 6);
    expect(stats.costByTier['T2']).toBeCloseTo(0.0066, 6);
    expect(stats.costByTier['T3']).toBeCloseTo(0.0002, 6);

    // Total should be sum of all tiers
    const tierTotal = (stats.costByTier['T1'] ?? 0)
      + (stats.costByTier['T2'] ?? 0)
      + (stats.costByTier['T3'] ?? 0);
    expect(stats.totalCostUsd).toBeCloseTo(tierTotal, 8);
  });

  it('getTierCostSummary produces readable strings per tier', () => {
    simulateCall(router, 'T1', 1000, 400, 0.021);
    simulateCall(router, 'T2', 500, 200, 0.0021);

    const summary = router.getTierCostSummary();
    expect(summary['T1']).toMatch(/^\$[\d.]+\s+\(1 call/);
    expect(summary['T2']).toMatch(/^\$[\d.]+\s+\(1 call/);
  });

  it('getTierCostPercentages sums to ~100 across tiers', () => {
    simulateCall(router, 'T1', 1000, 400, 0.040);
    simulateCall(router, 'T2', 500, 200, 0.010);

    const pcts = router.getTierCostPercentages();
    const total = Object.values(pcts).reduce((a, b) => a + b, 0);
    // Allow ±1% due to rounding
    expect(total).toBeGreaterThan(99);
    expect(total).toBeLessThanOrEqual(100.1);
    expect(pcts['T1']).toBeCloseTo(80, 0);
    expect(pcts['T2']).toBeCloseTo(20, 0);
  });

  it('getTierCostPercentages returns empty object when no cost recorded', () => {
    expect(router.getTierCostPercentages()).toEqual({});
  });

  it('resetStats clears per-tier data', () => {
    simulateCall(router, 'T1', 1000, 400, 0.021);
    simulateCall(router, 'T3', 200, 80, 0.0002);

    router.resetStats();

    const stats = router.getStats();
    expect(stats.costByTier).toEqual({});
    expect(stats.tokensByTier).toEqual({});
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.totalTokens).toBe(0);
  });

  it('getStats returns a snapshot — mutations do not affect internal state', () => {
    simulateCall(router, 'T2', 400, 100, 0.0015);
    const snap1 = router.getStats();
    snap1.costByTier['T2'] = 999; // mutate snapshot

    const snap2 = router.getStats();
    expect(snap2.costByTier['T2']).toBeCloseTo(0.0015, 8); // internal state unchanged
  });

  it('accumulates cost per feature tag across tiers, untagged calls excluded', () => {
    simulateCall(router, 'T3', 500, 200, 0.0003, 'Auth: JWT support');
    simulateCall(router, 'T3', 400, 150, 0.0002, 'Auth: JWT support');
    simulateCall(router, 'T2', 300, 100, 0.0010, 'UI refactor');
    simulateCall(router, 'T1', 1000, 400, 0.0200); // untagged (planning)

    const stats = router.getStats();
    expect(stats.costByFeature['Auth: JWT support']).toBeCloseTo(0.0005, 8);
    expect(stats.costByFeature['UI refactor']).toBeCloseTo(0.0010, 8);
    expect(Object.keys(stats.costByFeature)).toHaveLength(2);
  });

  it('resetStats clears per-feature data too', () => {
    simulateCall(router, 'T3', 500, 200, 0.0003, 'Some feature');
    router.resetStats();
    expect(router.getStats().costByFeature).toEqual({});
  });
});

// ── Untracked spend ────────────────────────────
//
// A call on a model with no published price adds $0 to every total. That is
// not free money — it is money the totals cannot see, and it means a cost cap
// can never be tripped by that model. These assert the counters that let the
// UI and the CLI label such a total as an undercount instead of a fact.

describe('untracked spend accounting', () => {
  let router: CascadeRouter;

  beforeEach(async () => {
    router = await makeRouter();
  });

  function simulateUnpricedCall(modelId: string, tokens: number): void {
    const r = router as unknown as {
      recordStats: (
        tier: string,
        model: { id: string; provider: string },
        usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number; costUnknown?: boolean },
      ) => void;
    };
    r.recordStats('T3', { id: modelId, provider: 'openai-compatible' }, {
      inputTokens: tokens,
      outputTokens: tokens,
      totalTokens: tokens * 2,
      estimatedCostUsd: 0,
      costUnknown: true,
    });
  }

  it('reports no untracked calls when every price is known', () => {
    simulateCall(router, 'T3', 500, 200, 0.0003);
    const stats = router.getStats();
    expect(stats.untrackedCostCalls).toBe(0);
    expect(stats.untrackedCostModels).toEqual([]);
  });

  it('counts calls whose price is unknown and names the models responsible', () => {
    simulateUnpricedCall('mystery-model-a', 1000);
    simulateUnpricedCall('mystery-model-a', 1000);
    simulateUnpricedCall('mystery-model-b', 500);

    const stats = router.getStats();
    expect(stats.untrackedCostCalls).toBe(3);
    // Deduped — one entry per model, not per call.
    expect(stats.untrackedCostModels).toEqual(['mystery-model-a', 'mystery-model-b']);
  });

  it('leaves the spend total untouched, so the two numbers stay distinguishable', () => {
    simulateCall(router, 'T3', 500, 200, 0.0025);
    simulateUnpricedCall('mystery-model-a', 1000);

    const stats = router.getStats();
    // The priced call is all the total can honestly claim...
    expect(stats.totalCostUsd).toBeCloseTo(0.0025, 8);
    // ...and the counter is what says the real figure is higher than that.
    expect(stats.untrackedCostCalls).toBe(1);
    // Tokens ARE counted for both — only the money is unknown.
    expect(stats.totalTokens).toBe(700 + 2000);
  });

  it('resetStats clears the untracked counters too', () => {
    simulateUnpricedCall('mystery-model-a', 1000);
    router.resetStats();
    const stats = router.getStats();
    expect(stats.untrackedCostCalls).toBe(0);
    expect(stats.untrackedCostModels).toEqual([]);
  });
});
