// ─────────────────────────────────────────────
//  Cascade AI — Beta posterior tests
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  betaPosterior,
  posteriorMean,
  posteriorStdDev,
  sampleBeta,
  PERF_PRIOR_STRENGTH,
  type Rng,
} from './bayes.js';

/**
 * Deterministic uniform stream.
 *
 * mulberry32, NOT xorshift32. xorshift32 seeded with a small integer opens
 * with badly biased output — seed 1 gives 0.0001, 0.0157, … — which is
 * invisible in a long-run mean but wrecks any test that reseeds and takes a
 * handful of draws. That cost an afternoon; it is not worth re-learning.
 */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('betaPosterior — what one observation is allowed to prove', () => {
  it('is neutral with no evidence at all', () => {
    expect(posteriorMean(betaPosterior(0, 0))).toBe(0.5);
  });

  it('does not write a model off for a single failure', () => {
    // The behaviour this replaces: successCount/sampleCount put one failure at
    // 0, floored to 0.05 — a 10x penalty against a benchmark range spanning
    // about 1.5x, so one bad moment outweighed every measured quality
    // difference in the catalogue. And since nothing explored, the model was
    // never tried again to find out otherwise.
    const afterOneFailure = posteriorMean(betaPosterior(0, 1));
    expect(afterOneFailure).toBeCloseTo(0.4, 5);
    expect(afterOneFailure).toBeGreaterThan(0.05 * 4);
  });

  it('does not crown a model for a single success either', () => {
    expect(posteriorMean(betaPosterior(1, 0))).toBeCloseTo(0.6, 5);
  });

  it('moves further as evidence accumulates', () => {
    const one = posteriorMean(betaPosterior(1, 0));
    const ten = posteriorMean(betaPosterior(10, 0));
    const hundred = posteriorMean(betaPosterior(100, 0));
    expect(ten).toBeGreaterThan(one);
    expect(hundred).toBeGreaterThan(ten);
    expect(hundred).toBeLessThan(1);
  });

  it('treats success and failure symmetrically', () => {
    expect(posteriorMean(betaPosterior(3, 7))).toBeCloseTo(1 - posteriorMean(betaPosterior(7, 3)), 10);
  });

  it('ignores negative weight rather than inverting the evidence', () => {
    expect(posteriorMean(betaPosterior(-5, 0))).toBe(0.5);
  });
});

describe('posteriorStdDev — how little we know', () => {
  it('narrows as evidence accumulates', () => {
    const sparse = posteriorStdDev(betaPosterior(1, 1));
    const rich = posteriorStdDev(betaPosterior(50, 50));
    expect(rich).toBeLessThan(sparse);
  });

  it('is widest when nothing is known', () => {
    // Load-bearing for exploration: a model with no history has to be able to
    // draw high enough to earn a turn.
    expect(posteriorStdDev(betaPosterior(0, 0)))
      .toBeGreaterThan(posteriorStdDev(betaPosterior(20, 20)));
  });
});

describe('sampleBeta — Thompson sampling', () => {
  it('stays inside [0,1]', () => {
    const rng = seeded(12345);
    for (let i = 0; i < 500; i++) {
      const v = sampleBeta(betaPosterior(3, 7), rng);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('centres on the posterior mean over many draws', () => {
    const rng = seeded(99);
    const p = betaPosterior(30, 10); // mean 0.727…
    let total = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) total += sampleBeta(p, rng);
    expect(total / n).toBeCloseTo(posteriorMean(p), 1);
  });

  it('varies widely when evidence is thin and barely at all when it is thick', () => {
    // This IS the decay. No schedule, no bonus to tune: an unknown model draws
    // all over the place and sometimes wins; a well-measured one draws its own
    // mean every time and stops being explored.
    const spread = (p: { alpha: number; beta: number }) => {
      const rng = seeded(7);
      let min = 1;
      let max = 0;
      for (let i = 0; i < 800; i++) {
        const v = sampleBeta(p, rng);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      return max - min;
    };
    expect(spread(betaPosterior(0, 0))).toBeGreaterThan(spread(betaPosterior(200, 200)));
  });

  it('lets a barely-tried model out-draw a well-measured mediocre one sometimes', () => {
    // The absorbing state, gone. A model on one failure has to be able to win
    // a turn back from a model that is reliably 60%.
    const rng = seeded(2024);
    const unsure = betaPosterior(0, 1);       // mean 0.40, wide
    const known = betaPosterior(60, 40);      // mean 0.60, narrow
    let unsureWins = 0;
    for (let i = 0; i < 1000; i++) {
      if (sampleBeta(unsure, rng) > sampleBeta(known, rng)) unsureWins++;
    }
    expect(unsureWins).toBeGreaterThan(0);
    // …but it must not win MOST of them, or this is not exploration, it is
    // ignoring the evidence.
    expect(unsureWins).toBeLessThan(500);
  });

  it('does not hang or return junk on a degenerate RNG', () => {
    // A stub returning a constant is a realistic test-double mistake, and a
    // rejection sampler is exactly where that turns into a hung routing call.
    const constant: Rng = () => 0.5;
    const v = sampleBeta(betaPosterior(5, 5), constant);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('handles a prior weaker than the algorithm’s own validity bound', () => {
    // shape < 1 needs the boost step; without it the sampler is silently wrong
    // rather than loud.
    const rng = seeded(555);
    const p = betaPosterior(0, 0, 1); // α = β = 0.5
    let total = 0;
    for (let i = 0; i < 2000; i++) total += sampleBeta(p, rng);
    expect(total / 2000).toBeCloseTo(0.5, 1);
  });

  it('uses the documented default prior strength', () => {
    expect(PERF_PRIOR_STRENGTH).toBe(4);
    expect(posteriorMean(betaPosterior(0, 1, PERF_PRIOR_STRENGTH))).toBeCloseTo(0.4, 5);
  });
});
