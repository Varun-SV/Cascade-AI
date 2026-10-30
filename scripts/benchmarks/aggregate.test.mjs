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
  resolveBands,
  theilSen,
  spearman,
  MIN_FIT_SPEARMAN,
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

  it('imputes a cell no source covers from the family\'s measured cells, ahead of the baseline', () => {
    // A hand-typed baseline is exactly what outlived the data before: GPT-4o
    // kept code 85 from a seed long after every agentic board put it near 50.
    const partial = [{ source: 'aa', scale: 'index0-100', models: { fam: { code: 90, analysis: 70 } } }];
    const base = { fam: { code: 70, analysis: 60, creative: 55, data: 65 } };
    const { families, trace } = buildFamilies(partial, { base });
    expect(families.fam).toEqual({ code: 90, analysis: 70, creative: 80, data: 80 });
    expect(trace.fam.creative.mode).toBe('imputed');
  });

  it('keeps the committed baseline for a family nothing measures at all', () => {
    const base = { fam: { code: 70, analysis: 60, creative: 55, data: 65 } };
    const { families, trace } = buildFamilies([], { base });
    expect(families.fam).toEqual(base.fam);
    expect(trace.fam.code.mode).toBe('baseline');
  });

  it('carries an uncovered baseline family through unchanged', () => {
    const base = { untouched: { code: 74, analysis: 72, creative: 73, data: 70 } };
    const { families } = buildFamilies(sources, { base });
    expect(families.untouched).toEqual(base.untouched);
    expect(families.fam).toBeDefined();
  });

  it('emits a family measured on one task, imputing the rest from it', () => {
    const partial = [{ source: 'aa', scale: 'index0-100', models: { fam: { code: 90 } } }];
    const { families } = buildFamilies(partial, {}); // no base
    expect(families.fam).toEqual({ code: 90, analysis: 90, creative: 90, data: 90 });
  });

  it('carries an optional agentic score without requiring it', () => {
    const src = [
      { source: 'a', scale: 'percent', models: { both: { code: 80, analysis: 80, creative: 80, data: 80, agentic: 60 }, taskOnly: { code: 70, analysis: 70, creative: 70, data: 70 } } },
    ];
    const { families } = buildFamilies(src, {});
    expect(families.both.agentic).toBe(60);
    expect(families.taskOnly).toEqual({ code: 70, analysis: 70, creative: 70, data: 70 });
    // agentic is not imputed: an unmeasured tool loop is not assumed to hold.
    expect(families.taskOnly.agentic).toBeUndefined();
  });

  it('uses a fallback source only where no primary source rates the cell', () => {
    const src = [
      { source: 'primary', scale: 'percent', models: { a: { code: 60, analysis: 60, creative: 60, data: 60 }, b: { code: 50 } } },
      { source: 'fb', role: 'fallback', scale: 'percent', models: { a: { analysis: 99 }, b: { analysis: 40, data: 40 } } },
    ];
    const { families, trace } = buildFamilies(src, {});
    expect(families.a.analysis).toBe(60); // a measurement is never overridden by a fallback
    expect(families.b.analysis).toBe(40);
    expect(trace.b.analysis.mode).toBe('fallback');
    expect(trace.a.analysis.contributors.map((c) => c.source)).toEqual(['primary']);
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

describe('fitTo calibration', () => {
  const anchor = {
    source: 'anchor', scale: 'percent', calibration: { code: { min: 0, max: 90 } },
    models: { m1: { code: 50 }, m2: { code: 60 }, m3: { code: 70 }, m4: { code: 80 }, m5: { code: 90 } },
  };
  // A harder benchmark: same order, raw numbers 40 points lower.
  const hard = {
    source: 'hard', scale: 'percent', calibration: { code: { fitTo: 'anchor' } },
    models: { m1: { code: 10 }, m2: { code: 20 }, m3: { code: 30 }, m4: { code: 40 }, m5: { code: 50 }, newer: { code: 45 } },
  };

  it('theilSen recovers a straight line and ignores one outlier', () => {
    const line = theilSen([[0, 1], [1, 3], [2, 5], [3, 7], [4, 100]]);
    expect(line.slope).toBeCloseTo(2);
    expect(line.intercept).toBeCloseTo(1);
  });

  it('spearman is 1 for the same order and -1 for the reverse', () => {
    expect(spearman([[1, 10], [2, 20], [3, 30]])).toBeCloseTo(1);
    expect(spearman([[1, 30], [2, 20], [3, 10]])).toBeCloseTo(-1);
  });

  it('maps a harder benchmark onto the anchor scale over shared models', () => {
    const { bands, fits } = resolveBands(hard, { anchor });
    expect(bands.code.min).toBeCloseTo(-40);
    expect(bands.code.max).toBeCloseTo(50);
    expect(fits.code).toMatchObject({ fitTo: 'anchor', n: 5 });
    // So "lowest across sources" compares like with like: m5 is 100 on both.
    const { families } = buildFamilies([anchor, hard], {});
    expect(families.m5.code).toBe(100);
    // And a model only the harder board rated lands where the anchor would put it.
    expect(families.newer.code).toBe(94); // 45 + 40 = 85 on the anchor; 85/90
  });

  it('skips a task whose fit is too weak to trust', () => {
    const scrambled = {
      source: 'noise', scale: 'percent', calibration: { code: { fitTo: 'anchor' } },
      models: { m1: { code: 50 }, m2: { code: 10 }, m3: { code: 40 }, m4: { code: 20 }, m5: { code: 30 } },
    };
    expect(spearman([[50, 50], [10, 60], [40, 70], [20, 80], [30, 90]])).toBeLessThan(MIN_FIT_SPEARMAN);
    const { bands } = resolveBands(scrambled, { anchor });
    expect(bands.code).toBeUndefined();
  });

  it('skips a task when too few models are shared', () => {
    const few = { ...hard, models: { m1: { code: 10 }, m2: { code: 20 }, x: { code: 5 } } };
    expect(resolveBands(few, { anchor }).bands.code).toBeUndefined();
  });
});

describe('committed text sources', () => {
  it('every fitTo calibration in the repo clears the gate', async () => {
    const { loadSources } = await import('./sources.mjs');
    const sources = await loadSources();
    const byName = Object.fromEntries(sources.map((s) => [s.source, s]));
    for (const s of sources) {
      for (const [task, spec] of Object.entries(s.calibration ?? {})) {
        if (spec.fitTo === undefined) continue;
        const { bands, fits } = resolveBands(s, byName);
        expect(bands[task], `${s.source}.${task}`).toBeDefined();
        expect(fits[task].spearman, `${s.source}.${task}`).toBeGreaterThanOrEqual(MIN_FIT_SPEARMAN);
      }
    }
  });

  it('ships no seed-approximation text sources', async () => {
    const { loadSources } = await import('./sources.mjs');
    const sources = await loadSources();
    expect(sources.filter((s) => s.provenance === 'seed-approximation').map((s) => s.source)).toEqual([]);
  });
});
