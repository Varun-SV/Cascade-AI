// ─────────────────────────────────────────────
//  Cascade AI — Benchmark-routing scores
// ─────────────────────────────────────────────
//
// These assert what the captured boards say (scripts/benchmarks/sources/),
// not a preferred ordering. The old suite pinned "GPT-4.1 is the best writer"
// and "Claude beats GPT-4o at code" against hand-typed seeds; when the seeds
// went, those orderings had nothing under them.

import { describe, expect, it } from 'vitest';
import { benchmarkProfile, benchmarkScore01, resolveFamily } from './benchmarks.js';
import { MODELS } from '../../constants.js';
import type { ModelInfo } from '../../types.js';
import benchmarkData from './benchmark-data.json' with { type: 'json' };

function m(id: string, provider: ModelInfo['provider'] = 'openai', baseModelId?: string): ModelInfo {
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

describe('resolveFamily', () => {
  it('gives every model version its own family', () => {
    expect(resolveFamily(m('claude-opus-5-5', 'anthropic'))).toBe('claude-opus-5.5');
    expect(resolveFamily(m('claude-opus-5', 'anthropic'))).toBe('claude-opus-5');
    expect(resolveFamily(m('claude-opus-4-5-20251101', 'anthropic'))).toBe('claude-opus-4.5');
    expect(resolveFamily(m('claude-haiku-4-5-20251001', 'anthropic'))).toBe('claude-haiku-4.5');
    expect(resolveFamily(m('gpt-6.1-sol'))).toBe('gpt-6.1-sol');
    expect(resolveFamily(m('gpt-6-sol'))).toBe('gpt-6-sol');
    expect(resolveFamily(m('gpt-5.4-nano'))).toBe('gpt-5.4-nano');
    expect(resolveFamily(m('gpt-5-2025-08-07'))).toBe('gpt-5');
    expect(resolveFamily(m('gemini-3.5-flash-lite', 'gemini'))).toBe('gemini-3.5-flash-lite');
    expect(resolveFamily(m('gemini-3.1-pro-preview', 'gemini'))).toBe('gemini-3.1-pro');
  });

  it('reads a version out of a display name and a gateway id', () => {
    expect(resolveFamily({ ...m('x', 'anthropic'), name: 'Claude Opus 4.5' })).toBe('claude-opus-4.5');
    expect(resolveFamily(m('anthropic/claude-sonnet-4.5', 'openai-compatible'))).toBe('claude-sonnet-4.5');
  });

  it('scores Mythos as Fable — the same model', () => {
    expect(resolveFamily(m('claude-mythos-5-1', 'anthropic'))).toBe('claude-fable-5.1');
  });

  it('never scores a retired model as the newest of its line', () => {
    // These would otherwise fall into the "newer than this table" rules.
    for (const id of ['claude-3-7-sonnet-20250219', 'claude-sonnet-4-20250514', 'claude-opus-4-1-20250805', 'claude-3-5-haiku-20241022']) {
      expect(benchmarkScore01(m(id, 'anthropic'), 'code'), id).toBe(0.5);
    }
    expect(benchmarkScore01(m('gemini-2.0-flash-lite', 'gemini'), 'code')).toBe(0.5);
    expect(benchmarkScore01(m('gemini-1.5-pro', 'gemini'), 'code')).toBe(0.5);
  });

  it('scores a newer release than the table by the newest measured model of its line', () => {
    expect(resolveFamily(m('claude-opus-6', 'anthropic'))).toBe('claude-opus-5.5');
    expect(resolveFamily(m('gemini-3.9-flash', 'gemini'))).toBe('gemini-3.8-flash');
  });

  it('resolves an arbitrarily named Azure deployment through baseModelId', () => {
    expect(benchmarkScore01(m('prod-west', 'azure', 'gpt-5.6-sol'), 'analysis'))
      .toBe(benchmarkScore01(m('gpt-5.6-sol'), 'analysis'));
  });
});

describe('benchmarkScore01', () => {
  it('separates versions the old generic families scored as one', () => {
    // Terminal-Bench 2.1: Opus 5.5 87.6%, Opus 4.5 not run; SWE-bench
    // Verified puts Opus 4.5 at 76.4% — well behind the current generation.
    expect(benchmarkScore01(MODELS['claude-opus-5-5']!, 'code'))
      .toBeGreaterThan(benchmarkScore01(MODELS['claude-opus-4-5']!, 'code') + 0.2);
    expect(benchmarkScore01(MODELS['claude-haiku-5-5']!, 'code'))
      .toBeGreaterThan(benchmarkScore01(MODELS['claude-haiku-4-5']!, 'code'));
  });

  it('rates the GPT-6.1 tiers in order and above the model they replace', () => {
    const sol = benchmarkScore01(MODELS['gpt-6.1-sol']!, 'code');
    const terra = benchmarkScore01(MODELS['gpt-6.1-terra']!, 'code');
    const luna = benchmarkScore01(MODELS['gpt-6-luna']!, 'code');
    expect(sol).toBeGreaterThan(terra);
    expect(terra).toBeGreaterThan(luna);
    expect(luna).toBeGreaterThan(benchmarkScore01(m('gpt-4o'), 'code'));
  });

  it('no longer credits models shut down or being shut down with seed scores', () => {
    // τ²-bench (AA): GPT-4o 25%, Gemini 2.5 Flash 15% — they could not hold a
    // tool loop together, whatever the old seed table said (85 and 82).
    expect(benchmarkScore01(MODELS['gpt-4o']!, 'code')).toBeLessThan(0.6);
    expect(benchmarkScore01(MODELS['gemini-2.5-flash']!, 'code')).toBeLessThan(0.6);
    expect(benchmarkScore01(MODELS['gpt-4o-mini']!, 'code')).toBe(0.5);
  });

  it('keeps gemini-2.5-flash-lite apart from the full gemini-2.5-flash', () => {
    expect(resolveFamily(MODELS['gemini-2.5-flash-lite']!)).toBe('gemini-2.5-flash-lite');
    expect(resolveFamily(MODELS['gemini-2.5-flash']!)).toBe('gemini-2.5-flash');
  });

  it('does not score GPT-5.4 Nano as the full GPT-5.4 model', () => {
    expect(benchmarkScore01(m('gpt-5.4-nano'), 'code')).toBeLessThan(benchmarkScore01(MODELS['gpt-5.4']!, 'code'));
  });

  it('returns a neutral 0.5 for a model with no benchmark profile', () => {
    const unknown = { id: 'mystery-model-x', name: 'Mystery', provider: 'openai' } as ModelInfo;
    expect(benchmarkScore01(unknown, 'code')).toBe(0.5);
  });

  it('produces an in-range score for the mixed task type, ignoring the agentic key', () => {
    const model = MODELS['claude-sonnet-5']!;
    const p = benchmarkProfile(model)!;
    const mean = (p.code! + p.analysis! + p.creative! + p.data!) / 4;
    expect(benchmarkScore01(model, 'mixed')).toBeCloseTo(mean / 100, 5);
  });
});

describe('agentic weighting', () => {
  it('blends the agentic score in by the weight given', () => {
    const model = MODELS['gemini-3.8-flash']!;
    const p = benchmarkProfile(model)!;
    expect(p.agentic).toBeTypeOf('number');
    expect(benchmarkScore01(model, 'creative', 0.5)).toBeCloseTo((p.creative! + p.agentic!) / 200, 5);
    expect(benchmarkScore01(model, 'creative', 0)).toBeCloseTo(p.creative! / 100, 5);
  });

  it('scores a model no agentic board measured on the task alone', () => {
    const local = { ...m('qwen2.5:7b', 'ollama'), isLocal: true };
    expect(benchmarkScore01(local, 'code', 0.5)).toBe(benchmarkScore01(local, 'code', 0));
  });

  it('puts a planner that holds tool loops together ahead of one that does not', () => {
    // On analysis alone Gemini 4 Argon leads the Vals Index; on Terminal-Bench
    // 2.1 it trails Opus 5.5 by 30 points. The planner weighting sees both.
    const argon = MODELS['gemini-4-argon']!;
    const opus = MODELS['claude-opus-5-5']!;
    expect(benchmarkScore01(opus, 'analysis', 0.5) - benchmarkScore01(argon, 'analysis', 0.5))
      .toBeGreaterThan(benchmarkScore01(opus, 'analysis', 0) - benchmarkScore01(argon, 'analysis', 0));
  });
});

describe('the committed snapshot', () => {
  const families = (benchmarkData as { families: Record<string, Record<string, number>> }).families;

  it('has a family for every model in the catalogue Auto can route to', () => {
    const unscored = Object.values(MODELS)
      .filter((model) => !model.isLocal)
      .filter((model) => benchmarkProfile(model) === null)
      .map((model) => model.id);
    // gpt-4o-mini: no current board measures it and it shuts down 2027-01-14.
    expect(unscored).toEqual(['gpt-4o-mini']);
  });

  it('keeps the generic family keys older builds still look up', () => {
    for (const legacy of ['claude-opus', 'claude-sonnet', 'claude-haiku']) {
      expect(families[legacy], legacy).toBeDefined();
    }
  });

  it('every score is an integer in [0, 100]', () => {
    for (const [fam, profile] of Object.entries(families)) {
      for (const [task, v] of Object.entries(profile)) {
        expect(Number.isInteger(v) && v >= 0 && v <= 100, `${fam}.${task}=${v}`).toBe(true);
      }
    }
  });
});
