import { describe, it, expect } from 'vitest';
import { ModelPerformanceTracker } from './model-performance-tracker.js';

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

  it('still lets that one rating outweigh a single automatic outcome', () => {
    const rated = mem();
    rated.recordExplicit('m1', 'code', 'good');
    const auto = mem();
    auto.record('m1', 'code', 'success');
    expect(rated.performanceScore('m1', 'code')).toBeGreaterThan(auto.performanceScore('m1', 'code'));
  });

  it('weights a thumbs-down the same way, in the other direction', () => {
    const rated = mem();
    rated.recordExplicit('m1', 'code', 'bad');
    const auto = mem();
    auto.record('m1', 'code', 'failure');
    expect(rated.performanceScore('m1', 'code')).toBeLessThan(auto.performanceScore('m1', 'code'));
  });

  it('an explicit weight moves belief without moving the observation count', () => {
    const t = mem();
    t.record('m1', 'code', 'success', 0, 0, 0, 5);
    expect(t.sampleCountFor('m1', 'code')).toBe(1);
    // …but five automatic successes' worth of evidence.
    const many = mem();
    for (let i = 0; i < 5; i++) many.record('m1', 'code', 'success');
    expect(t.performanceScore('m1', 'code')).toBeCloseTo(many.performanceScore('m1', 'code'), 5);
    expect(many.sampleCountFor('m1', 'code')).toBe(5);
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
