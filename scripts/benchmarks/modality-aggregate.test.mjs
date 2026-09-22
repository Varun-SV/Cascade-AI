// Tests for the non-text modality aggregator (scripts/benchmarks/modality-aggregate.mjs).
// Run by vitest via the `scripts/**/*.test.mjs` include in vitest.config.ts.

import { describe, it, expect } from 'vitest';
import {
  percentileNormalizeSource,
  groupByModality,
  buildModalityFamilies,
  buildAllModalities,
  cohortOverlap,
} from './modality-aggregate.mjs';

describe('percentileNormalizeSource', () => {
  it('ranks higher-is-better values by percentile within the source', () => {
    // 3 models: worst, middle, best -> mid-rank percentile formula.
    const src = { source: 's', models: { worst: 10, mid: 20, best: 30 } };
    const out = percentileNormalizeSource(src);
    expect(out.worst).toBe(17); // (0 + 0.5)/3*100 = 16.67 -> 17
    expect(out.mid).toBe(50); // (1 + 0.5)/3*100 = 50
    expect(out.best).toBe(83); // (2 + 0.5)/3*100 = 83.33 -> 83
  });

  it('flips ranking direction for lowerIsBetter metrics (e.g. WER)', () => {
    const src = { source: 's', lowerIsBetter: true, models: { worst: 30, mid: 20, best: 10 } };
    const out = percentileNormalizeSource(src);
    expect(out.best).toBe(83);
    expect(out.mid).toBe(50);
    expect(out.worst).toBe(17);
  });

  it('splits ties evenly', () => {
    const src = { source: 's', models: { a: 10, b: 10 } };
    const out = percentileNormalizeSource(src);
    expect(out.a).toBe(50);
    expect(out.b).toBe(50);
  });

  it('normalizes a single-model source to a neutral 50 (no comparison possible)', () => {
    const src = { source: 's', models: { solo: 42 } };
    expect(percentileNormalizeSource(src)).toEqual({ solo: 50 });
  });

  it('drops non-finite values from the comparison set', () => {
    const src = { source: 's', models: { a: 10, b: NaN, c: 'x', d: 20 } };
    const out = percentileNormalizeSource(src);
    expect(Object.keys(out).sort()).toEqual(['a', 'd']);
  });

  it('returns {} for an empty or missing models map', () => {
    expect(percentileNormalizeSource({ source: 's', models: {} })).toEqual({});
    expect(percentileNormalizeSource({ source: 's' })).toEqual({});
  });
});

describe('groupByModality', () => {
  it('groups sources by their declared modality, dropping untagged ones', () => {
    const sources = [
      { source: 'a', modality: 'vision', models: { m: 1 } },
      { source: 'b', modality: 'image-generation', models: { m: 1 } },
      { source: 'c', modality: 'vision', models: { m: 1 } },
      { source: 'd', models: { code: 90 } }, // legacy text source, no modality
    ];
    const groups = groupByModality(sources);
    expect(Object.keys(groups).sort()).toEqual(['image-generation', 'vision']);
    expect(groups.vision.map((s) => s.source)).toEqual(['a', 'c']);
  });
});

describe('buildModalityFamilies', () => {
  it('takes the conservative min per family across covering sources', () => {
    const sources = [
      { source: 'arena', modality: 'vision', models: { fam: 90, other: 50 } },
      { source: 'suite', modality: 'vision', models: { fam: 70, other: 60 } },
    ];
    const { families } = buildModalityFamilies(sources, { mode: 'min' });
    // Each 2-model source percentile-normalizes its own best->75, worst->25.
    // fam is best in both -> 75 each -> min(75,75)=75.
    expect(families.fam).toBe(75);
    expect(families.other).toBe(25);
  });

  it('records a trace of which sources set each score', () => {
    const sources = [{ source: 'arena', modality: 'vision', models: { fam: 90 } }];
    const { trace } = buildModalityFamilies(sources, { mode: 'min' });
    expect(trace.fam.value).toBe(50); // single-model source -> neutral
    expect(trace.fam.contributors).toEqual([{ source: 'arena', value: 50 }]);
  });

  it('keeps the committed baseline for a family no source in this run covers', () => {
    const sources = [{ source: 'arena', modality: 'vision', models: { fam: 90 } }];
    const base = { untouched: 65 };
    const { families } = buildModalityFamilies(sources, { base });
    expect(families.untouched).toBe(65);
    expect(families.fam).toBe(50);
  });

  it('robust mode drops one low outlier when >= 3 sources cover a family', () => {
    const sources = [
      { source: 'a', modality: 'vision', models: { fam: 10, x: 90 } }, // fam worst -> 25
      { source: 'b', modality: 'vision', models: { fam: 90, x: 10 } }, // fam best -> 75
      { source: 'c', modality: 'vision', models: { fam: 90, x: 10 } }, // fam best -> 75
    ];
    const { families } = buildModalityFamilies(sources, { mode: 'robust' });
    // sorted [25, 75, 75] -> drop the single lowest (25) -> 75.
    expect(families.fam).toBe(75);
  });
});

describe('buildAllModalities', () => {
  it('builds every modality present in the source list', () => {
    const sources = [
      { source: 'a', modality: 'vision', models: { fam: 90, other: 10 } },
      { source: 'b', modality: 'image-generation', models: { gpt: 100, flux: 50 } },
      { source: 'c', modality: 'speech-to-text', lowerIsBetter: true, models: { whisper: 5, canary: 10 } },
    ];
    const { modalities } = buildAllModalities(sources);
    expect(Object.keys(modalities).sort()).toEqual([
      'image-generation',
      'speech-to-text',
      'vision',
    ]);
    expect(modalities.vision.fam).toBe(75);
    expect(modalities['speech-to-text'].whisper).toBe(75); // lower WER wins
  });

  it('carries a baseline modality through unchanged when no source covers it this run', () => {
    const sources = [{ source: 'a', modality: 'vision', models: { fam: 90 } }];
    const base = { 'video-generation': { sora: 77 } };
    const { modalities } = buildAllModalities(sources, { base });
    expect(modalities['video-generation']).toEqual({ sora: 77 });
    expect(modalities.vision).toBeDefined();
  });

  it('returns no modalities for an empty source list and empty base', () => {
    expect(buildAllModalities([]).modalities).toEqual({});
  });
});


// Percentile rank removes the unit problem (an Elo, a WER, an nDCG@10 have no
// common scale) and introduces a population one in its place. These pin that
// failure mode so it cannot be mistaken for a calibrated score.
describe('cohorts that do not overlap', () => {
  // Deliberately extreme: every model in `weak` is worse than every model in
  // `strong`, and the two name entirely different models — which is exactly
  // the shape of the committed text-to-speech pair (a blended arena of 8 and
  // an open-weights-only leaderboard of 5, sharing nothing).
  const strong = {
    source: 'blended-arena', modality: 'demo',
    models: { 'frontier-a': 1500, 'frontier-b': 1480, 'frontier-c': 1460, 'frontier-d': 1440 },
  };
  const weak = {
    source: 'open-weights-only', modality: 'demo',
    models: { 'small-a': 900, 'small-b': 880, 'small-c': 860, 'small-d': 840 },
  };

  it('gives the best of a weak field the same score as the best of a strong one', () => {
    const { families } = buildModalityFamilies([strong, weak]);
    // This is the bug, asserted rather than described. `small-a` is the worst
    // model in the union by a wide margin and scores identically to
    // `frontier-a`, because each is top of its own cohort.
    expect(families['small-a']).toBe(families['frontier-a']);
    expect(families['small-a']).toBeGreaterThan(families['frontier-d']);
  });

  it('reports the cohorts as disjoint, so a consumer can refuse them', () => {
    const { comparability } = buildModalityFamilies([strong, weak]);
    expect(comparability).toEqual({ sources: 2, families: 8, shared: 0, disjoint: true });
  });

  it('does not call a single source disjoint — there is nothing to compare it to', () => {
    expect(cohortOverlap([strong])).toEqual({ sources: 1, families: 4, shared: 0, disjoint: false });
  });

  it('counts the anchors when sources do share models', () => {
    const overlapping = {
      source: 'second-arena', modality: 'demo',
      models: { 'frontier-a': 91, 'frontier-b': 88, 'newcomer': 80 },
    };
    const o = cohortOverlap([strong, overlapping]);
    expect(o.shared, 'frontier-a and frontier-b appear in both').toBe(2);
    expect(o.disjoint).toBe(false);
  });

  it('surfaces comparability per modality from the top-level build', () => {
    const { comparabilities } = buildAllModalities([strong, weak]);
    expect(comparabilities['demo'].disjoint).toBe(true);
  });
});

// The committed data, checked as data: if a future refresh adds a source that
// bridges these two cohorts, this test is the thing that notices.
describe('the committed text-to-speech sources', () => {
  it('are disjoint today, which is why their scores are not yet comparable', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const read = (n) => JSON.parse(readFileSync(
      fileURLToPath(new URL(`./sources/${n}`, import.meta.url)), 'utf8',
    ));
    const o = cohortOverlap([
      read('text-to-speech-aa-arena.json'),
      read('text-to-speech-aa-open-weights.json'),
    ]);
    expect(o.sources).toBe(2);
    expect(o.shared, 'no model appears in both leaderboards').toBe(0);
    expect(o.disjoint).toBe(true);
  });
});
