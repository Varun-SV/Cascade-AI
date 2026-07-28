import { describe, it, expect } from 'vitest';
import { buildTokenUsage, calculateCost, resolveModelPricing } from './cost.js';
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

  it('prices a newly-added current model id (opus-4-8) from the pricing dataset', () => {
    // $5 / $25 per 1M — https://platform.claude.com/docs/en/about-claude/pricing.
    // The hand-maintained catalogue still said $15/$75 (the Opus 4.1 price);
    // the dataset is the authoritative baseline and corrects it.
    expect(resolveModelPricing({ ...base, id: 'claude-opus-4-8' }))
      .toEqual({ input: 0.005, output: 0.025, unknown: false });
  });

  it('keeps genuinely-local models at zero cost', () => {
    const m = { ...base, id: 'llama3:70b', isLocal: true };
    expect(calculateCost(1_000_000, 1_000_000, m)).toBe(0);
    expect(resolveModelPricing(m).unknown).toBe(false);
  });

  it('reports an unpriced cloud model as UNKNOWN, not free', () => {
    const m = { ...base, id: 'totally-unknown-model' };
    const p = resolveModelPricing(m);
    expect(p.unknown).toBe(true);
    // The 0s are a placeholder for "no data" — never render them as $0.00.
    expect(calculateCost(1000, 1000, m)).toBe(0);
  });

  it('flags unknown pricing on the TokenUsage it builds', () => {
    expect(buildTokenUsage(1000, 1000, { ...base, id: 'totally-unknown-model' }).costUnknown).toBe(true);
    expect(buildTokenUsage(1000, 1000, { ...base, id: 'claude-opus-4-8' }).costUnknown).toBeUndefined();
    expect(buildTokenUsage(1000, 1000, { ...base, id: 'llama3:70b', isLocal: true }).costUnknown).toBeUndefined();
  });
});
