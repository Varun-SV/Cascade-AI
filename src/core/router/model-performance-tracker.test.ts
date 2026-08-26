import { describe, it, expect } from 'vitest';
import { ModelPerformanceTracker } from './model-performance-tracker.js';
import { betaPosterior, posteriorStdDev, PERF_PRIOR_STRENGTH } from './bayes.js';

// A tracker that never touches disk (unique nonexistent path; we never save).
const mem = () => new ModelPerformanceTracker('/nonexistent/model-perf.json');

describe('ModelPerformanceTracker', () => {
  it('records outcomes and lowers the score for failures', () => {
    const t = mem();
    t.record('m1', 'code', 'success', 0, 0.01);
    t.record('m1', 'code', 'success', 0, 0.01);
    const good = t.performanceScore('m1', 'code');
    t.record('m1', 'code', 'failure');
    t.record('m1', 'code', 'failure');
    expect(t.performanceScore('m1', 'code')).toBeLessThan(good);
  });

  it('accumulates context tokens overall and on failures', () => {
    const t = mem();
    t.record('m1', 'analysis', 'success', 0, 0, 1000);
    t.record('m1', 'analysis', 'failure', 0, 0, 5000);
    const stat = t.getAll().get('m1:analysis')!;
    expect(stat.totalContextTokens).toBe(6000);
    expect(stat.failureContextTokens).toBe(5000);
    expect(stat.sampleCount).toBe(2);
  });

  it('readOnly mode reads shared scores but never records or contributes', () => {
    const ro = new ModelPerformanceTracker('/nonexistent/ro.json', { readOnly: true });
    ro.record('m1', 'code', 'failure', 2, 0.5, 9000);
    ro.recordFeatureCost('feat', 0.5);
    // Nothing was recorded — the map stays empty, and the score is the neutral prior.
    expect(ro.getAll().size).toBe(0);
    expect(ro.performanceScore('m1', 'code')).toBe(0.5);
  });

  it('explicit ratings weigh 3× a single auto outcome', () => {
    const good = mem();
    good.record('m1', 'data', 'success');
    const bad = mem();
    bad.recordExplicit('m1', 'data', 'bad');
    // One good sample vs a 3×-weighted bad → the bad model scores lower.
    expect(bad.performanceScore('m1', 'data')).toBeLessThan(good.performanceScore('m1', 'data'));
  });
});

describe('ModelPerformanceTracker — one observation is not proof', () => {
  it('does not write a model off for a single failure', () => {
    // The behaviour this replaces: successCount/sampleCount read one failure
    // as 0%, floored to 0.05. `perf` multiplies straight into every branch of
    // scoreModel, while the benchmark term spans only about 1.5x — so one bad
    // moment outweighed every measured quality difference in the catalogue,
    // and with nothing exploring, the model was never tried again.
    const t = mem();
    t.record('m1', 'code', 'failure');
    expect(t.performanceScore('m1', 'code')).toBeCloseTo(0.4, 5);
  });

  it('does not crown a model for a single success', () => {
    const t = mem();
    t.record('m1', 'code', 'success');
    expect(t.performanceScore('m1', 'code')).toBeCloseTo(0.6, 5);
  });

  it('still reads as neutral before anything has happened', () => {
    expect(mem().performanceScore('never-tried', 'code')).toBe(0.5);
  });

  it('still penalises retries on top of the outcome', () => {
    const clean = mem();
    clean.record('m1', 'code', 'success', 0);
    const retried = mem();
    retried.record('m1', 'code', 'success', 3);
    expect(retried.performanceScore('m1', 'code')).toBeLessThan(clean.performanceScore('m1', 'code'));
  });
});

describe('ModelPerformanceTracker — weight is evidence, sampleCount is confidence', () => {
  it('counts a thumbs-up ONCE, however much it is worth', () => {
    // It used to call record() three times to express 3x weight, which also
    // tripled sampleCount — so one click made the router three times as
    // confident as the evidence warranted, and everything downstream that
    // reads the count as confidence inherited the error.
    const t = mem();
    t.recordExplicit('m1', 'code', 'good');
    expect(t.sampleCountFor('m1', 'code')).toBe(1);
  });

  it('lets a rating win the argument against an automatic outcome that disagrees', () => {
    // What the weight is FOR. A thumbs-up alongside a failed run should not
    // land at "we know nothing" — the user watched the output and the run
    // exit code did not.
    const rated = mem();
    rated.recordExplicit('m1', 'code', 'good');
    rated.record('m1', 'code', 'failure');

    const auto = mem();
    auto.record('m1', 'code', 'success');
    auto.record('m1', 'code', 'failure');

    expect(rated.performanceScore('m1', 'code')).toBeGreaterThan(auto.performanceScore('m1', 'code'));
    expect(auto.performanceScore('m1', 'code')).toBeCloseTo(0.5, 5);
  });

  it('weights a thumbs-down the same way, in the other direction', () => {
    const rated = mem();
    rated.recordExplicit('m1', 'code', 'bad');
    rated.record('m1', 'code', 'success');

    const auto = mem();
    auto.record('m1', 'code', 'failure');
    auto.record('m1', 'code', 'success');

    expect(rated.performanceScore('m1', 'code')).toBeLessThan(auto.performanceScore('m1', 'code'));
  });

  it('does not let one rating buy the confidence of three runs', () => {
    // The trap this whole split exists to avoid. Weight straight into α/β
    // makes a single click arithmetically identical to three observations —
    // same belief AND same narrowness — so one thumbs-up would shut down
    // exploration as hard as three independent runs. Belief is where a weight
    // is allowed to spend itself; certainty has to be earned by observing.
    const rated = mem();
    rated.recordExplicit('m1', 'code', 'good');

    const runs = mem();
    for (let i = 0; i < ModelPerformanceTracker.EXPLICIT_RATING_WEIGHT; i++) {
      runs.record('m1', 'code', 'success');
    }

    expect(posteriorStdDev(rated.posteriorFor('m1', 'code')))
      .toBeGreaterThan(posteriorStdDev(runs.posteriorFor('m1', 'code')));
    // And a lone rating moves belief exactly as far as a lone run: one look at
    // the model is one look at the model, however much the look was worth.
    const oneRun = mem();
    oneRun.record('m1', 'code', 'success');
    expect(rated.performanceScore('m1', 'code'))
      .toBeCloseTo(oneRun.performanceScore('m1', 'code'), 5);
  });

  it('an explicit weight moves belief without moving the observation count', () => {
    const t = mem();
    t.record('m1', 'code', 'success', 0, 0, 0, 5);
    expect(t.sampleCountFor('m1', 'code')).toBe(1);
    expect(t.posteriorFor('m1', 'code').alpha + t.posteriorFor('m1', 'code').beta)
      .toBeCloseTo(PERF_PRIOR_STRENGTH + 1, 5);
  });

  it('never reports a success rate above 100%, however heavy the evidence', () => {
    // `cascade stats` divided by sampleCount. One thumbs-up is 3 units of
    // evidence on 1 observation, so the column read "300%" — and the table
    // sorts on it, so the impossible rates floated to the top.
    const t = mem();
    t.recordExplicit('m1', 'code', 'good');
    expect(t.observedSuccessRate('m1', 'code')).toBeLessThanOrEqual(1);
    expect(t.observedSuccessRate('m1', 'code')).toBe(1);
    expect(t.sampleCountFor('m1', 'code')).toBe(1);
  });

  it('reports the rate the evidence actually supports when it is mixed', () => {
    const t = mem();
    t.recordExplicit('m1', 'code', 'good');   // 3 units of success
    t.record('m1', 'code', 'failure');        // 1 unit of failure
    expect(t.observedSuccessRate('m1', 'code')).toBeCloseTo(0.75, 5);
  });

  it('reports nothing rather than dividing by zero for an unseen model', () => {
    expect(mem().observedSuccessRate('never-run', 'code')).toBe(0);
  });

  it('reads a stats file written before ratings carried weight', () => {
    // Every observation weighed exactly 1 back then, so evidence total and
    // sample count agreed and this has to be the plain unweighted posterior —
    // including the old triplicated rating, which recorded three of each.
    const t = mem();
    for (let i = 0; i < 3; i++) t.record('m1', 'code', 'success');
    t.record('m1', 'code', 'failure');
    const p = t.posteriorFor('m1', 'code');
    expect(p.alpha).toBeCloseTo(betaPosterior(3, 1).alpha, 5);
    expect(p.beta).toBeCloseTo(betaPosterior(3, 1).beta, 5);
  });

  it('exposes the posterior, not just its mean', () => {
    // Ranking needs the mean; deciding whether to explore needs the spread.
    // Collapsing to a scalar in the tracker is what made those inseparable.
    const t = mem();
    t.record('m1', 'code', 'success');
    t.record('m1', 'code', 'failure');
    const p = t.posteriorFor('m1', 'code');
    expect(p.alpha).toBeCloseTo(3, 5);
    expect(p.beta).toBeCloseTo(3, 5);
  });
});
