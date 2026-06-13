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

  it('returns a neutral 0.5 for a model with no benchmark profile', () => {
    const unknown = { id: 'mystery-model-x', name: 'Mystery', provider: 'openai' } as ModelInfo;
    expect(benchmarkScore01(unknown, 'code')).toBe(0.5);
  });

  it('produces an in-range score for the mixed task type', () => {
    const s = benchmarkScore01(MODELS['claude-sonnet-4']!, 'mixed');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});
