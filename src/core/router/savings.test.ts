import { describe, expect, it } from 'vitest';
import { computeDelegationSavings } from './savings.js';
import type { ModelInfo } from '../../types.js';

const t1Model: ModelInfo = {
  id: 'premium',
  name: 'Premium',
  provider: 'anthropic',
  contextWindow: 200_000,
  isVisionCapable: false,
  inputCostPer1kTokens: 0.01,
  outputCostPer1kTokens: 0.05,
  maxOutputTokens: 8192,
  supportsStreaming: true,
  isLocal: false,
};

const localT1: ModelInfo = { ...t1Model, id: 'local', provider: 'ollama', inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, isLocal: true };

describe('computeDelegationSavings', () => {
  it('reports savings when cheap tiers did most of the work', () => {
    const stats = {
      totalCostUsd: 0.1, // actual spend
      inputTokensByTier: { T1: 1000, T2: 10_000, T3: 50_000 },
      outputTokensByTier: { T1: 500, T2: 5_000, T3: 20_000 },
    };
    // counterfactual: 61k input → $0.61, 25.5k output → $1.275 ⇒ $1.885
    const s = computeDelegationSavings(stats, t1Model);
    expect(s.counterfactualUsd).toBeCloseTo(1.885, 6);
    expect(s.savedUsd).toBeCloseTo(1.785, 6);
    expect(s.savedPct).toBeCloseTo(94.7, 1);
  });

  it('returns zero savings when everything already ran on T1', () => {
    const stats = {
      totalCostUsd: 0.5,
      inputTokensByTier: { T1: 30_000 },
      outputTokensByTier: { T1: 4_000 },
    };
    // counterfactual = 0.3 + 0.2 = 0.5 = actual ⇒ no savings
    const s = computeDelegationSavings(stats, t1Model);
    expect(s.savedUsd).toBe(0);
    expect(s.savedPct).toBe(0);
  });

  it('returns zero savings when the T1 model is free/local', () => {
    const stats = {
      totalCostUsd: 0.02,
      inputTokensByTier: { T2: 10_000 },
      outputTokensByTier: { T2: 2_000 },
    };
    const s = computeDelegationSavings(stats, localT1);
    expect(s.savedUsd).toBe(0);
    expect(s.counterfactualUsd).toBe(0);
  });

  it('returns zeros when no T1 model is resolved', () => {
    const s = computeDelegationSavings({ totalCostUsd: 1, inputTokensByTier: { T3: 100 }, outputTokensByTier: {} }, null);
    expect(s).toEqual({ savedUsd: 0, savedPct: 0, counterfactualUsd: 0 });
  });

  it('returns zeros for an empty session', () => {
    const s = computeDelegationSavings({ totalCostUsd: 0, inputTokensByTier: {}, outputTokensByTier: {} }, t1Model);
    expect(s.savedUsd).toBe(0);
  });
});
