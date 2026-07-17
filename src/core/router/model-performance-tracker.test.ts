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
