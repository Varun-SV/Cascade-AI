// ─────────────────────────────────────────────
//  Cascade AI — Feedback as a routing prior
// ─────────────────────────────────────────────
//
//  These pin the properties that keep thumbs data from doing more harm than
//  good: it must be bounded, it must shrink toward nothing when the sample is
//  small, and silence must never read as a negative verdict.

import { describe, expect, it } from 'vitest';
import {
  applyFeedback,
  explainFeedback,
  feedbackAdjustment,
  MAX_FEEDBACK_ADJUSTMENT,
} from './feedback-prior.js';

describe('feedbackAdjustment', () => {
  it('is exactly zero with no votes', () => {
    // "Nobody has said anything" and "opinion is evenly split" are different
    // claims; only the second belongs at the midpoint of a shrunk estimate.
    expect(feedbackAdjustment({ good: 0, bad: 0 })).toBe(0);
  });

  it('is zero when opinion is evenly split', () => {
    expect(feedbackAdjustment({ good: 5, bad: 5 })).toBeCloseTo(0, 10);
  });

  it('barely moves on a single vote', () => {
    // One thumbs-up must not reorder routing. This is the whole point of the
    // shrinkage: three votes is not evidence.
    const adj = feedbackAdjustment({ good: 1, bad: 0 });
    expect(adj).toBeGreaterThan(0);
    expect(adj).toBeLessThan(0.01);
  });

  it('grows with agreement but never escapes the cap', () => {
    const few = feedbackAdjustment({ good: 5, bad: 0 });
    const more = feedbackAdjustment({ good: 20, bad: 0 });
    const lots = feedbackAdjustment({ good: 10_000, bad: 0 });
    expect(more).toBeGreaterThan(few);
    expect(lots).toBeGreaterThan(more);
    expect(lots).toBeLessThanOrEqual(MAX_FEEDBACK_ADJUSTMENT);
    // Even unanimous praise at absurd volume cannot overturn a real benchmark
    // gap — the cap is smaller than the typical spread between adjacent models.
    expect(MAX_FEEDBACK_ADJUSTMENT).toBeLessThanOrEqual(0.05);
  });

  it('is symmetric between praise and complaint', () => {
    const up = feedbackAdjustment({ good: 12, bad: 3 });
    const down = feedbackAdjustment({ good: 3, bad: 12 });
    expect(up).toBeCloseTo(-down, 10);
  });

  it('cannot be swung by one annoyed user in an afternoon', () => {
    // Ten consecutive downvotes is a plausible bad day. It should register,
    // and it should still be a nudge rather than a verdict.
    const adj = feedbackAdjustment({ good: 0, bad: 10 });
    expect(adj).toBeLessThan(0);
    expect(Math.abs(adj)).toBeLessThan(MAX_FEEDBACK_ADJUSTMENT * 0.6);
  });

  it('ignores negative or fractional counts rather than trusting them', () => {
    expect(feedbackAdjustment({ good: -5, bad: 0 })).toBe(0);
    expect(feedbackAdjustment({ good: 2.7, bad: 0 })).toBe(feedbackAdjustment({ good: 2, bad: 0 }));
  });
});

describe('applyFeedback', () => {
  it('adjusts a score without replacing it', () => {
    const base = 0.60;
    const boosted = applyFeedback(base, { good: 20, bad: 0 });
    expect(boosted).toBeGreaterThan(base);
    // A weaker model with perfect ratings still loses to a clearly better one.
    expect(boosted).toBeLessThan(0.70);
  });

  it('leaves a score untouched when there is no feedback', () => {
    expect(applyFeedback(0.42, { good: 0, bad: 0 })).toBe(0.42);
  });

  it('clamps at the ends of the range', () => {
    // Enthusiasm must not push a model above a perfect score.
    expect(applyFeedback(1, { good: 500, bad: 0 })).toBe(1);
    expect(applyFeedback(0, { good: 0, bad: 500 })).toBe(0);
  });

  it('cannot flip a clear benchmark gap', () => {
    // The ordering this module is built to preserve: measured capability first,
    // lived experience only as a tiebreak.
    const strongUnrated = applyFeedback(0.80, { good: 0, bad: 0 });
    const weakBeloved = applyFeedback(0.70, { good: 1000, bad: 0 });
    expect(strongUnrated).toBeGreaterThan(weakBeloved);
  });

  it('can break a near-tie, which is the case it exists for', () => {
    const a = applyFeedback(0.700, { good: 30, bad: 2 });
    const b = applyFeedback(0.695, { good: 0, bad: 0 });
    expect(a).toBeGreaterThan(b);
  });
});

describe('explainFeedback', () => {
  it('says nothing when feedback changed nothing', () => {
    expect(explainFeedback({ good: 0, bad: 0 })).toBeNull();
  });

  it('always states the sample size alongside the number', () => {
    // A number without its n invites exactly the over-reading this guards.
    const note = explainFeedback({ good: 9, bad: 1 })!;
    expect(note).toContain('boosted');
    expect(note).toContain('9 up / 1 down');
    expect(note).toContain('10 rated replies');
  });

  it('reports a reduction as such', () => {
    expect(explainFeedback({ good: 1, bad: 9 })!).toContain('reduced');
  });

  it('gets the singular right for one rating', () => {
    expect(explainFeedback({ good: 1, bad: 0 })!).toContain('1 rated reply');
  });
});
