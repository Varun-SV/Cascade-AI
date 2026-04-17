// ─────────────────────────────────────────────
//  Cascade AI — Budget Warning Tests
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

async function makeRouter(budgetOverrides?: CascadeConfig['budget']): Promise<CascadeRouter> {
  const router = new CascadeRouter();
  (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
  (router as unknown as Record<string, unknown>)['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
  await router.init(makeConfig(budgetOverrides ? { budget: budgetOverrides } : {}));
  return router;
}

function simulateCall(
  router: CascadeRouter,
  tier: 'T1' | 'T2' | 'T3',
  costUsd: number,
): void {
  const r = router as unknown as {
    recordStats: (
      tier: string,
      model: { provider: string },
      usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number },
    ) => void;
  };
  r.recordStats(tier, { provider: 'anthropic' }, {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: costUsd,
  });
}

// ── Tests ──────────────────────────────────────

describe('Budget warning event', () => {
  let router: CascadeRouter;

  describe('with a $1.00 cap and default 80% warn threshold', () => {
    beforeEach(async () => {
      router = await makeRouter({ sessionBudgetUsd: 1.00, warnAtPct: 80 });
    });

    it('does NOT fire budget:warning below the threshold', () => {
      const handler = vi.fn();
      router.on('budget:warning', handler);

      simulateCall(router, 'T3', 0.70); // 70% — below 80%
      expect(handler).not.toHaveBeenCalled();
    });

    it('fires budget:warning exactly when spend crosses the threshold', () => {
      const handler = vi.fn();
      router.on('budget:warning', handler);

      simulateCall(router, 'T3', 0.79); // 79% — still below
      expect(handler).not.toHaveBeenCalled();

      simulateCall(router, 'T3', 0.02); // now 81% — crosses 80%
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('fires the warning only once per session, not on every subsequent call', () => {
      const handler = vi.fn();
      router.on('budget:warning', handler);

      simulateCall(router, 'T3', 0.85); // crosses 80%
      simulateCall(router, 'T3', 0.05); // still above threshold but warning already fired
      simulateCall(router, 'T3', 0.05); // again

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('provides accurate payload fields in the warning event', () => {
      const handler = vi.fn();
      router.on('budget:warning', handler);

      simulateCall(router, 'T2', 0.85);

      expect(handler).toHaveBeenCalledOnce();
      const payload = handler.mock.calls[0]![0] as {
        spentUsd: number;
        capUsd: number;
        spendPct: number;
        warnAtPct: number;
        remainingUsd: number;
      };
      expect(payload.capUsd).toBe(1.00);
      expect(payload.warnAtPct).toBe(80);
      expect(payload.spentUsd).toBeCloseTo(0.85, 6);
      expect(payload.spendPct).toBeCloseTo(85, 0);
      expect(payload.remainingUsd).toBeCloseTo(0.15, 6);
    });

    it('throws BudgetExceededError when the hard cap is hit, not just the warn threshold', () => {
      router.on('budget:warning', () => { /* suppress */ });
      simulateCall(router, 'T1', 0.85); // triggers warning
      expect(() => simulateCall(router, 'T1', 0.20)).toThrow('Session budget'); // now at $1.05 → hard stop
    });
  });

  describe('with a custom warnAtPct of 50%', () => {
    beforeEach(async () => {
      router = await makeRouter({ sessionBudgetUsd: 2.00, warnAtPct: 50 });
    });

    it('fires warning at 50% rather than 80%', () => {
      const handler = vi.fn();
      router.on('budget:warning', handler);

      simulateCall(router, 'T3', 0.99); // 49.5% — just below 50%
      expect(handler).not.toHaveBeenCalled();

      simulateCall(router, 'T3', 0.02); // now 50.5% — crosses 50%
      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0]![0] as { warnAtPct: number }).warnAtPct).toBe(50);
    });
  });

  describe('without a session budget cap', () => {
    beforeEach(async () => {
      router = await makeRouter(); // no budget configured
    });

    it('never fires budget:warning when no cap is set', () => {
      const handler = vi.fn();
      router.on('budget:warning', handler);

      simulateCall(router, 'T1', 999); // huge spend — but no cap
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('resetStats() clears the warn guard', () => {
    beforeEach(async () => {
      router = await makeRouter({ sessionBudgetUsd: 1.00, warnAtPct: 80 });
    });

    it('re-fires budget:warning after resetStats()', () => {
      const handler = vi.fn();
      router.on('budget:warning', handler);

      simulateCall(router, 'T3', 0.85); // fires once
      expect(handler).toHaveBeenCalledTimes(1);

      router.resetStats();

      simulateCall(router, 'T3', 0.85); // should fire again after reset
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
