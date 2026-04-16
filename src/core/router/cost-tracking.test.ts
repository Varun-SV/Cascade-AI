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
): void {
  // Reach into recordStats directly via casting
  const r = router as unknown as {
    recordStats: (tier: string, model: { provider: string }, usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number }) => void;
  };
  r.recordStats(tier, { provider: 'anthropic' }, {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: costUsd,
  });
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
});
