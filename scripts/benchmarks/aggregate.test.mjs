// Tests for the benchmark aggregator engine (scripts/benchmarks/aggregate.mjs).
// Run by vitest via the `scripts/**/*.test.mjs` include in vitest.config.ts.

import { describe, it, expect } from 'vitest';
import {
  TASK_KEYS,
  clampScore,
  defaultBand,
  calibrationFor,
  normalizeValue,
  normalizeSource,
  conservativeAggregate,
  buildFamilies,
} from './aggregate.mjs';

describe('clampScore', () => {
  it('rounds and clamps into [0,100]', () => {
    expect(clampScore(72.4)).toBe(72);
    expect(clampScore(72.5)).toBe(73);
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(140)).toBe(100);
  });
  it('returns null for non-finite input', () => {
    expect(clampScore('x')).toBeNull();
    expect(clampScore(NaN)).toBeNull();
    expect(clampScore(undefined)).toBeNull();
  });
});

describe('defaultBand / calibrationFor', () => {
  it('maps index0-100 and percent to a 0..100 band', () => {
    expect(defaultBand('index0-100')).toEqual({ min: 0, max: 100 });
    expect(defaultBand('percent')).toEqual({ min: 0, max: 100 });
  });
  it('maps elo to the reference band, honouring overrides', () => {
    expect(defaultBand('elo')).toEqual({ min: 1000, max: 1500 });
    expect(defaultBand('elo', { eloFloor: 1100, eloCeil: 1400 })).toEqual({ min: 1100, max: 1400 });
  });
  it('lets a source override the band per task (reference-max calibration)', () => {
    const src = { scale: 'percent', calibration: { code: { min: 0, max: 75 } } };
    expect(calibrationFor(src, 'code')).toEqual({ min: 0, max: 75 });
    // A task without an override falls back to the scale default.
    expect(calibrationFor(src, 'analysis')).toEqual({ min: 0, max: 100 });
  });
});

describe('normalizeValue', () => {
  it('is identity for a 0..100 band', () => {
    expect(normalizeValue(83, { min: 0, max: 100 })).toBe(83);
  });
  it('maps an Elo band linearly to 0..100', () => {
    expect(normalizeValue(1000, { min: 1000, max: 1500 })).toBe(0);
    expect(normalizeValue(1250, { min: 1000, max: 1500 })).toBe(50);
    expect(normalizeValue(1500, { min: 1000, max: 1500 })).toBe(100);
    expect(normalizeValue(1600, { min: 1000, max: 1500 })).toBe(100); // clamped
  });
  it('calibrates a raw benchmark % against a reference-max', () => {
    // SWE-bench Verified ~70% against a 75% frontier ceiling → a ~93 quality score.
    expect(normalizeValue(70, { min: 0, max: 75 })).toBe(93);
  });
  it('returns null for missing values or a degenerate band', () => {
    expect(normalizeValue(undefined, { min: 0, max: 100 })).toBeNull();
    expect(normalizeValue(50, { min: 100, max: 100 })).toBeNull();
  });
});

describe('normalizeSource', () => {
  it('keeps only the task cells the source actually rates', () => {
    const src = {
      source: 's', scale: 'index0-100',
      models: { 'claude-opus': { code: 95, analysis: 92 } }, // no creative/data
    };
    const out = normalizeSource(src);
    expect(out['claude-opus']).toEqual({ code: 95, analysis: 92 });
    expect(Object.keys(out['claude-opus'])).not.toContain('creative');
  });
  it('applies elo normalization across a source', () => {
    const src = {
      source: 'arena', scale: 'elo', eloFloor: 1000, eloCeil: 1500,
      models: { m: { code: 1250 } },
    };
    expect(normalizeSource(src).m.code).toBe(50);
  });
});

describe('conservativeAggregate', () => {
  it('takes the lowest by default (strict quality-to-cost)', () => {
    // The user's example: SWE-bench 80 + Arena 77 → 77.
    expect(conservativeAggregate([80, 77])).toBe(77);
    expect(conservativeAggregate([90, 85, 88])).toBe(85);
  });
  it('robust mode drops one low outlier only with >= 3 values', () => {
    expect(conservativeAggregate([40, 85, 88], 'robust')).toBe(85); // 40 dropped
    expect(conservativeAggregate([80, 77], 'robust')).toBe(77);     // <3 → plain min
  });
  it('returns null when there are no finite values', () => {
    expect(conservativeAggregate([])).toBeNull();
    expect(conservativeAggregate([NaN, undefined])).toBeNull();
  });
});

describe('buildFamilies', () => {
  const sources = [
    {
      source: 'aa', scale: 'index0-100',
      models: { fam: { code: 90, analysis: 88, creative: 84, data: 86 } },
    },
    {
      source: 'arena', scale: 'elo', eloFloor: 1000, eloCeil: 1500,
      // code 1400→80, analysis 1440→88, creative 1450→90, data 1420→84
      models: { fam: { code: 1400, analysis: 1440, creative: 1450, data: 1420 } },
    },
  ];

  it('takes the conservative min per cell across covering sources', () => {
    const { families } = buildFamilies(sources, { mode: 'min' });
    // code: min(90,80)=80 ; analysis: min(88,88)=88 ; creative: min(84,90)=84 ; data: min(86,84)=84
    expect(families.fam).toEqual({ code: 80, analysis: 88, creative: 84, data: 84 });
  });

  it('records a trace of which sources set each score', () => {
    const { trace } = buildFamilies(sources, { mode: 'min' });
    expect(trace.fam.code.value).toBe(80);
    expect(trace.fam.code.contributors).toEqual([
      { source: 'aa', value: 90 },
      { source: 'arena', value: 80 },
    ]);
  });

  it('keeps the committed baseline for any cell no source covers', () => {
    const partial = [{ source: 'aa', scale: 'index0-100', models: { fam: { code: 90 } } }];
    const base = { fam: { code: 70, analysis: 60, creative: 55, data: 65 } };
    const { families } = buildFamilies(partial, { base });
    // code overridden by the source (min(90)=90); the rest fall back to baseline.
    expect(families.fam).toEqual({ code: 90, analysis: 60, creative: 55, data: 65 });
  });

  it('carries an uncovered baseline family through unchanged', () => {
    const base = { untouched: { code: 74, analysis: 72, creative: 73, data: 70 } };
    const { families } = buildFamilies(sources, { base });
    expect(families.untouched).toEqual(base.untouched);
    expect(families.fam).toBeDefined();
  });

  it('does not emit a family that lacks a full task profile and has no baseline', () => {
    const partial = [{ source: 'aa', scale: 'index0-100', models: { fam: { code: 90 } } }];
    const { families } = buildFamilies(partial, {}); // no base
    expect(families.fam).toBeUndefined();
  });

  it('robust mode ignores one low outlier when three sources cover a cell', () => {
    const three = [
      { source: 'a', scale: 'index0-100', models: { fam: { code: 88, analysis: 88, creative: 88, data: 88 } } },
      { source: 'b', scale: 'index0-100', models: { fam: { code: 40, analysis: 85, creative: 85, data: 85 } } },
      { source: 'c', scale: 'index0-100', models: { fam: { code: 90, analysis: 90, creative: 90, data: 90 } } },
    ];
    const { families } = buildFamilies(three, { mode: 'robust' });
    // code: sorted [40,88,90] → drop 40 → 88 (min would have been 40).
    expect(families.fam.code).toBe(88);
  });

  it('covers every task key in TASK_KEYS', () => {
    expect(TASK_KEYS).toEqual(['code', 'analysis', 'creative', 'data']);
  });
});
