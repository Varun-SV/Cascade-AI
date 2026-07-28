// ─────────────────────────────────────────────
//  Cascade AI — Thumbs-up/down as a routing prior
// ─────────────────────────────────────────────
//
//  Ratings are the only signal Cascade has about how a model performs on THIS
//  user's actual work, which public benchmarks cannot know. They are also the
//  worst-quality data in the system, and it is worth being blunt about why:
//
//    · Tiny samples. Three votes is not evidence of anything.
//    · Self-selected. People rate a bad answer far more readily than a good
//      one, so the raw rate is biased downward by the act of collection.
//    · Gameable. One annoyed user can tank a model in an afternoon.
//    · Confounded. A thumbs-down often means the ANSWER was wrong, not that
//      the model was the wrong choice — the plan may have been at fault.
//
//  So this never replaces a benchmark score. It nudges one, by a bounded
//  amount, and only in proportion to how much evidence actually exists. The
//  shape is a Beta-Binomial shrinkage toward "no opinion": with PRIOR_STRENGTH
//  pseudo-observations sitting at neutral, a handful of real votes barely moves
//  the number, and it takes sustained agreement to move it near the cap.
//
//  Concretely, with the defaults below (cap 0.05, strength 10):
//
//    1 good,  0 bad  → +0.005   (a rounding error, correctly)
//    5 good,  0 bad  → +0.017
//   20 good,  0 bad  → +0.033
//   50 good,  5 bad  → +0.031
//    0 good, 20 bad  → -0.033
//
//  A model would need dozens of consistent votes to gain what a couple of
//  points of benchmark separation already gives it. That is the intended
//  ordering: measured capability first, lived experience as the tiebreak.

export interface FeedbackCounts {
  good: number;
  bad: number;
}

/**
 * Largest adjustment any amount of feedback can make to a 0–1 quality score.
 * Deliberately small: benchmark separation between adjacent models is often
 * 0.02–0.10, so this can break a near-tie but cannot overturn a clear gap.
 */
export const MAX_FEEDBACK_ADJUSTMENT = 0.05;

/**
 * Pseudo-observations held at neutral. Higher ⇒ more votes needed before the
 * prior moves. 10 means a unanimous 10-vote record still only reaches half the
 * cap.
 */
export const PRIOR_STRENGTH = 10;

/**
 * Signed adjustment in [-MAX_FEEDBACK_ADJUSTMENT, +MAX_FEEDBACK_ADJUSTMENT].
 *
 * Returns exactly 0 for no votes — "nobody has said anything" and "opinion is
 * evenly split" must not be conflated, and only the second deserves to sit at
 * the midpoint of a shrunk estimate.
 */
export function feedbackAdjustment(counts: FeedbackCounts): number {
  const good = Math.max(0, Math.floor(counts.good));
  const bad = Math.max(0, Math.floor(counts.bad));
  const n = good + bad;
  if (n === 0) return 0;

  // Beta(α, β) posterior mean with α = β = PRIOR_STRENGTH / 2, i.e. a neutral
  // prior worth PRIOR_STRENGTH observations.
  const half = PRIOR_STRENGTH / 2;
  const shrunk = (good + half) / (n + PRIOR_STRENGTH);

  // Map [0, 1] around the 0.5 midpoint onto [-cap, +cap].
  return (shrunk - 0.5) * 2 * MAX_FEEDBACK_ADJUSTMENT;
}

/**
 * Apply feedback to a 0–1 quality score, clamped back into range.
 *
 * Clamping matters at the extremes: a model already at 1.0 must not be pushed
 * above it by praise, or it would sort ahead of a hypothetical perfect model
 * on nothing but enthusiasm.
 */
export function applyFeedback(score01: number, counts: FeedbackCounts): number {
  const adjusted = score01 + feedbackAdjustment(counts);
  return Math.max(0, Math.min(1, adjusted));
}

/**
 * Human-readable note for /why, or null when feedback changed nothing.
 *
 * Always states the sample size. A number without its n invites exactly the
 * over-reading this module exists to prevent.
 */
export function explainFeedback(counts: FeedbackCounts): string | null {
  const adj = feedbackAdjustment(counts);
  if (adj === 0) return null;
  const n = counts.good + counts.bad;
  const dir = adj > 0 ? 'boosted' : 'reduced';
  return `${dir} by ${Math.abs(adj).toFixed(3)} from your ratings ` +
    `(${counts.good} up / ${counts.bad} down over ${n} rated ${n === 1 ? 'reply' : 'replies'})`;
}

/**
 * Lookup of per-model feedback, keyed by model id.
 *
 * Deliberately just counts: no conversation text, no prompts, no timestamps.
 * A routing prior needs to know that a model earned N good and M bad verdicts
 * and nothing else, and storing more would put chat content in a second place
 * with different retention rules for no gain.
 */
export type FeedbackSource = (modelId: string) => FeedbackCounts | undefined;
