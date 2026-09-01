// ─────────────────────────────────────────────
//  Cascade AI — Benchmark-routing scores
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { benchmarkScore01 } from './benchmarks.js';
import { MODELS } from '../../constants.js';
import type { ModelInfo } from '../../types.js';

function syntheticCloudModel(id: string, provider: ModelInfo['provider'] = 'openai', baseModelId?: string): ModelInfo {
  return {
    id,
    name: id,
    provider,
    ...(baseModelId ? { baseModelId } : {}),
    contextWindow: 1_050_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0,
    outputCostPer1kTokens: 0,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  };
}

describe('benchmarkScore01', () => {
  it('rates Claude highest for coding among the frontier models', () => {
    const claude = benchmarkScore01(syntheticCloudModel('claude-sonnet-4', 'anthropic'), 'code');
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
    const gemFlash = benchmarkScore01(syntheticCloudModel('gemini-2.0-flash', 'gemini'), 'creative');
    expect(gpt).toBeGreaterThan(gemFlash);
  });

  it('scores a newer Gemini model discovered live (not in the table) by its class', () => {
    const g35Flash: ModelInfo = {
      id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'gemini',
      contextWindow: 1_000_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
      maxOutputTokens: 8_000, supportsStreaming: true, isLocal: false,
    };
    expect(benchmarkScore01(g35Flash, 'code')).toBeGreaterThan(0.5);
    const g3Pro: ModelInfo = { ...g35Flash, id: 'gemini-3-pro', name: 'Gemini 3 Pro' };
    expect(benchmarkScore01(g3Pro, 'analysis')).toBeGreaterThan(benchmarkScore01(g35Flash, 'analysis'));
  });

  it('scores gemini-2.5-flash-lite BELOW the full gemini-2.5-flash, not the same', () => {
    const lite: ModelInfo = {
      id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'gemini',
      contextWindow: 1_000_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
      maxOutputTokens: 8_000, supportsStreaming: true, isLocal: false,
    };
    const full = benchmarkScore01(MODELS['gemini-2.5-flash']!, 'code');
    const liteScore = benchmarkScore01(lite, 'code');
    expect(liteScore).toBeLessThan(full);
    const oldLite = benchmarkScore01(syntheticCloudModel('gemini-2.0-flash-lite', 'gemini'), 'code');
    expect(liteScore).toBeGreaterThan(oldLite);
  });

  it('returns a neutral 0.5 for a model with no benchmark profile', () => {
    const unknown = { id: 'mystery-model-x', name: 'Mystery', provider: 'openai' } as ModelInfo;
    expect(benchmarkScore01(unknown, 'code')).toBe(0.5);
  });

  it('scores the gpt-5 family (no longer a neutral 0.5)', () => {
    expect(benchmarkScore01(MODELS['gpt-5']!, 'code')).toBeGreaterThan(0.9);
    const azureDeploy = { id: 'prod-fast', name: 'Prod', provider: 'azure', baseModelId: 'gpt-5' } as ModelInfo;
    expect(benchmarkScore01(azureDeploy, 'analysis')).toBeGreaterThan(0.9);
    expect(benchmarkScore01(MODELS['gpt-5-mini']!, 'code'))
      .toBeLessThan(benchmarkScore01(MODELS['gpt-5']!, 'code'));
  });

  it('scores distinct gpt-5 point releases (5.5 > 5.4 > 5.4-mini)', () => {
    const v55 = benchmarkScore01(MODELS['gpt-5.5']!, 'code');
    const v54 = benchmarkScore01(MODELS['gpt-5.4']!, 'code');
    const v54mini = benchmarkScore01(MODELS['gpt-5.4-mini']!, 'code');
    expect(v55).toBeGreaterThan(v54);
    expect(v54).toBeGreaterThan(v54mini);
    const azure54 = { id: 'gpt-5.4', name: 'gpt-5.4', provider: 'azure', baseModelId: 'gpt-5.4' } as ModelInfo;
    const azure54mini = { id: 'gpt-5.4-mini', name: 'gpt-5.4-mini', provider: 'azure', baseModelId: 'gpt-5.4-mini' } as ModelInfo;
    expect(benchmarkScore01(azure54, 'code')).toBeGreaterThan(benchmarkScore01(azure54mini, 'code'));
  });

  it('keeps GPT-5.6 Sol, Terra and Luna as distinct benchmark families', () => {
    const sol = syntheticCloudModel('gpt-5.6-sol');
    const terra = syntheticCloudModel('gpt-5.6-terra');
    const luna = syntheticCloudModel('gpt-5.6-luna');
    expect(benchmarkScore01(sol, 'code')).toBeGreaterThan(benchmarkScore01(terra, 'code'));
    expect(benchmarkScore01(terra, 'code')).toBeGreaterThan(benchmarkScore01(luna, 'code'));
    expect(benchmarkScore01(sol, 'creative')).toBeGreaterThan(benchmarkScore01(terra, 'creative'));
    expect(benchmarkScore01(terra, 'creative')).toBeGreaterThan(benchmarkScore01(luna, 'creative'));
  });

  it('resolves an arbitrarily named Azure GPT-5.6 deployment through baseModelId', () => {
    const azureSol = syntheticCloudModel('prod-west', 'azure', 'gpt-5.6-sol');
    const directSol = syntheticCloudModel('gpt-5.6-sol');
    expect(benchmarkScore01(azureSol, 'analysis')).toBe(benchmarkScore01(directSol, 'analysis'));
  });

  it('does not score GPT-5.4 Nano as the full GPT-5.4 model', () => {
    const nano = syntheticCloudModel('gpt-5.4-nano');
    expect(benchmarkScore01(nano, 'analysis')).toBeLessThan(benchmarkScore01(MODELS['gpt-5.4']!, 'analysis'));
  });

  it('produces an in-range score for the mixed task type', () => {
    const s = benchmarkScore01(MODELS['claude-sonnet-5']!, 'mixed');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});
