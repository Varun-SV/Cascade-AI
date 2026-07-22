// ─────────────────────────────────────────────
//  Cascade AI — Benchmark-routing scores
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { benchmarkScore01 } from './benchmarks.js';
import { MODELS } from '../../constants.js';
import type { ModelInfo } from '../../types.js';

describe('benchmarkScore01', () => {
  it('rates Claude highest for coding among the frontier models', () => {
    const claude = benchmarkScore01(MODELS['claude-sonnet-4']!, 'code');
    const gpt = benchmarkScore01(MODELS['gpt-4o']!, 'code');
    const gemini = benchmarkScore01(MODELS['gemini-2.5-flash']!, 'code');
    expect(claude).toBeGreaterThan(gpt);
    expect(claude).toBeGreaterThan(gemini);
  });

  it('rates Gemini Pro above a small Claude for analysis', () => {
    const gemini = benchmarkScore01(MODELS['gemini-2.5-pro']!, 'analysis');
    const claudeHaiku = benchmarkScore01(MODELS['claude-haiku-4-5']!, 'analysis');
    expect(gemini).toBeGreaterThan(claudeHaiku);
  });

  it('rates GPT-4.1 highest for creative writing vs a flash model', () => {
    const gpt = benchmarkScore01(MODELS['gpt-4.1']!, 'creative');
    const gemFlash = benchmarkScore01(MODELS['gemini-2.0-flash']!, 'creative');
    expect(gpt).toBeGreaterThan(gemFlash);
  });

  it('scores a newer Gemini model discovered live (not in the table) by its class', () => {
    const g35Flash: ModelInfo = {
      id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'gemini',
      contextWindow: 1_000_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
      maxOutputTokens: 8_000, supportsStreaming: true, isLocal: false,
    };
    // Generic gemini→flash fallback ⇒ a real score, not the neutral 0.5 default.
    expect(benchmarkScore01(g35Flash, 'code')).toBeGreaterThan(0.5);
    // A pro variant should out-score a flash variant of the same generation.
    const g3Pro: ModelInfo = { ...g35Flash, id: 'gemini-3-pro', name: 'Gemini 3 Pro' };
    expect(benchmarkScore01(g3Pro, 'analysis')).toBeGreaterThan(benchmarkScore01(g35Flash, 'analysis'));
  });

  it('returns a neutral 0.5 for a model with no benchmark profile', () => {
    const unknown = { id: 'mystery-model-x', name: 'Mystery', provider: 'openai' } as ModelInfo;
    expect(benchmarkScore01(unknown, 'code')).toBe(0.5);
  });

  it('scores the gpt-5 family (no longer a neutral 0.5)', () => {
    expect(benchmarkScore01(MODELS['gpt-5']!, 'code')).toBeGreaterThan(0.9);
    // A gpt-5 point release / Azure deployment resolves via baseModelId.
    const azureDeploy = { id: 'prod-fast', name: 'Prod', provider: 'azure', baseModelId: 'gpt-5' } as ModelInfo;
    expect(benchmarkScore01(azureDeploy, 'analysis')).toBeGreaterThan(0.9);
    // gpt-5-mini ranks below the full gpt-5.
    expect(benchmarkScore01(MODELS['gpt-5-mini']!, 'code'))
      .toBeLessThan(benchmarkScore01(MODELS['gpt-5']!, 'code'));
  });

  it('scores distinct gpt-5 point releases (5.5 > 5.4 > 5.4-mini)', () => {
    const v55 = benchmarkScore01(MODELS['gpt-5.5']!, 'code');
    const v54 = benchmarkScore01(MODELS['gpt-5.4']!, 'code');
    const v54mini = benchmarkScore01(MODELS['gpt-5.4-mini']!, 'code');
    expect(v55).toBeGreaterThan(v54);
    expect(v54).toBeGreaterThan(v54mini);
    // The reported mis-route: an Azure gpt-5.4 deployment must NOT resolve to
    // the (weaker) gpt-5.4-mini family.
    const azure54 = { id: 'gpt-5.4', name: 'gpt-5.4', provider: 'azure', baseModelId: 'gpt-5.4' } as ModelInfo;
    const azure54mini = { id: 'gpt-5.4-mini', name: 'gpt-5.4-mini', provider: 'azure', baseModelId: 'gpt-5.4-mini' } as ModelInfo;
    expect(benchmarkScore01(azure54, 'code')).toBeGreaterThan(benchmarkScore01(azure54mini, 'code'));
  });

  it('produces an in-range score for the mixed task type', () => {
    const s = benchmarkScore01(MODELS['claude-sonnet-4']!, 'mixed');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});
