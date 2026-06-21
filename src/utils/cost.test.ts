import { describe, it, expect } from 'vitest';
import { calculateCost, resolveModelPricing } from './cost.js';
import type { ModelInfo } from '../types.js';

const base: ModelInfo = {
  id: '', name: '', provider: 'anthropic', contextWindow: 0, isVisionCapable: false,
  inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 0, supportsStreaming: false, isLocal: false,
};

describe('cost — registry pricing fallback (the $0.00 bug)', () => {
  it('uses the model object pricing when it has any', () => {
    const m = { ...base, id: 'x', inputCostPer1kTokens: 0.01, outputCostPer1kTokens: 0.02 };
    expect(calculateCost(1000, 1000, m)).toBeCloseTo(0.03, 6);
  });

  it('falls back to the catalogue by id when the object pricing is zero', () => {
    const m = { ...base, id: 'claude-sonnet-4-6' }; // configured override with no pricing attached
    const cost = calculateCost(1000, 1000, m);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(0.003 + 0.015, 6); // sonnet-4-6 = $0.003 in / $0.015 out per 1k
  });

  it('prices a newly-added current model id (opus-4-8)', () => {
    expect(resolveModelPricing({ ...base, id: 'claude-opus-4-8' })).toEqual({ input: 0.015, output: 0.075 });
  });

  it('keeps genuinely-local models at zero cost', () => {
    const m = { ...base, id: 'llama3:70b', isLocal: true };
    expect(calculateCost(1_000_000, 1_000_000, m)).toBe(0);
  });

  it('returns zero for an unknown zero-priced id (no false pricing)', () => {
    expect(calculateCost(1000, 1000, { ...base, id: 'totally-unknown-model' })).toBe(0);
  });
});
