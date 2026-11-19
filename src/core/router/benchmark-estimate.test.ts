import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../types.js';
import { benchmarkBasis, benchmarkScore01, estimateBenchmark, parameterCountB } from './benchmarks.js';

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id, name: id, provider: 'openai-compatible', contextWindow: 32000, isVisionCapable: false,
    inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 4096,
    supportsStreaming: true, isLocal: false, ...extra,
  };
}

describe('parameterCountB', () => {
  it('reads the size from the server, then from the name', () => {
    expect(parameterCountB(model('anything', { minSizeB: 14 }))).toBe(14);
    expect(parameterCountB(model('acme-coder-32b-instruct'))).toBe(32);
    expect(parameterCountB(model('acme:7b'))).toBe(7);
    expect(parameterCountB(model('acme-1.5b'))).toBe(1.5);
    expect(parameterCountB(model('moe-8x22b'))).toBe(176);
  });

  it('reads the total, not the active parameters, and nothing from a name without a size', () => {
    expect(parameterCountB(model('acme-30b-a3b'))).toBe(30);
    expect(parameterCountB(model('acme-chat'))).toBeNull();
    expect(parameterCountB(model('gpt-4b0'))).toBeNull();
  });
});

describe('estimates for models no benchmark has measured', () => {
  it('places a bigger model above a smaller one', () => {
    const small = benchmarkScore01(model('acme-1b'), 'code');
    const mid = benchmarkScore01(model('acme-8b'), 'code');
    const big = benchmarkScore01(model('acme-70b'), 'code');
    expect(small).toBeLessThan(mid);
    expect(mid).toBeLessThan(big);
  });

  it('places a dearer model above a cheaper one', () => {
    const cheap = benchmarkScore01(model('zeta-cheap', { inputCostPer1kTokens: 0.0001, outputCostPer1kTokens: 0.0004 }), 'analysis');
    const dear = benchmarkScore01(model('zeta-dear', { inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015 }), 'analysis');
    expect(cheap).toBeLessThan(dear);
  });

  it('never ranks a guess above the measured leaders', () => {
    const lavish = model('zeta-lavish', { inputCostPer1kTokens: 1, outputCostPer1kTokens: 5 });
    const huge = model('acme-2000b');
    const frontier = model('claude-opus-5-5', { provider: 'anthropic' });
    expect(benchmarkScore01(lavish, 'code')).toBeLessThan(benchmarkScore01(frontier, 'code'));
    expect(benchmarkScore01(huge, 'code')).toBeLessThan(benchmarkScore01(frontier, 'code'));
  });

  it('says how each score was arrived at', () => {
    expect(benchmarkBasis(model('claude-opus-5-5', { provider: 'anthropic' }))).toBe('measured');
    expect(benchmarkBasis(model('acme-8b'))).toBe('estimated-from-size');
    expect(benchmarkBasis(model('zeta', { inputCostPer1kTokens: 0.001, outputCostPer1kTokens: 0.002 }))).toBe('estimated-from-price');
    expect(benchmarkBasis(model('zeta'))).toBe('unknown');
  });

  it('keeps the neutral 0.5 when nothing is known, and ignores a price Cascade does not have', () => {
    expect(benchmarkScore01(model('zeta'), 'code')).toBe(0.5);
    expect(estimateBenchmark(model('zeta', { inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: true }))).toBeNull();
  });

  it('gives no agentic score, so an orchestrating tier is not told a guess holds a tool loop', () => {
    expect(estimateBenchmark(model('acme-70b'))!.profile.agentic).toBeUndefined();
    expect(benchmarkScore01(model('acme-70b'), 'code', 1)).toBe(benchmarkScore01(model('acme-70b'), 'code', 0));
  });
});
