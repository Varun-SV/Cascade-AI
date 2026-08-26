// ─────────────────────────────────────────────
//  Cascade AI — Beta posteriors for routing evidence
// ─────────────────────────────────────────────
//
//  Routing has exactly one quantity it estimates from this user's own data:
//  how often a model succeeds at a task type. Everything else in the score —
//  the public benchmark, the price, the specialization match — is a lookup.
//
//  That one estimate was a raw success rate, and a raw rate is indefensible at
//  small n. One failure read as 0%, which multiplied straight into the score
//  and, with nothing ever exploring, meant the model was never tried again to
//  find out otherwise. A model could be written off on a single bad network
//  moment and stay written off for the life of the stats file.
//
//  A Beta posterior fixes the estimate and the exploration together, because
//  they are the same object: the mean is what we believe, the spread is how
//  little we know, and a draw from it is a principled way to occasionally
//  prefer a model we are merely UNSURE about over one we are sure is mediocre.
//  Confidence then comes from evidence rather than being asserted, which is
//  what "the count is confidence, not the score" has to mean mechanically.

/** Beta(α, β). α counts success-weight, β failure-weight, both incl. the prior. */
export interface BetaPosterior {
  alpha: number;
  beta: number;
}

/**
 * Pseudo-observations held at 50/50 before any evidence arrives.
 *
 * Four — so α = β = 2 — is deliberately weaker than feedback-prior's ten. That
 * one guards a channel that is tiny, self-selected and gameable; this one reads
 * automatic outcomes, which are plentiful and directly about the thing being
 * predicted. It should move faster.
 *
 * What it buys, against the raw rate it replaces:
 *
 *   no data      → 0.50   (unchanged — a model nobody has tried is neutral)
 *   1 failure    → 0.40   (was 0.05: a 10x penalty for one bad moment)
 *   1 success    → 0.60   (was 1.00: one lucky call was proof of nothing)
 *   10 failures  → 0.14
 *   10 successes → 0.86
 *
 * A number to revisit with real data, not a constant of nature.
 */
export const PERF_PRIOR_STRENGTH = 4;

/**
 * Posterior from weighted evidence.
 *
 * Weighted, not counted: an explicit thumbs-up is worth more than "the HTTP
 * call did not error", and expressing that by recording the same observation
 * several times would corrupt the sample count that everything else reads as
 * confidence.
 */
export function betaPosterior(
  successWeight: number,
  failureWeight: number,
  priorStrength: number = PERF_PRIOR_STRENGTH,
): BetaPosterior {
  const half = Math.max(0, priorStrength) / 2;
  return {
    alpha: half + Math.max(0, successWeight),
    beta: half + Math.max(0, failureWeight),
  };
}

/**
 * Posterior from weighted evidence over a known number of observations.
 *
 * The weights say WHERE the posterior sits; the observation count says HOW
 * TIGHT it is. Those are different questions and folding them together is the
 * mistake this exists to avoid: passing weight straight into α/β makes one
 * thumbs-up worth 3 evidence units arithmetically indistinguishable from three
 * successful runs — same mean, and, more damagingly, the same narrowness. A
 * single click would then shut down exploration as hard as three independent
 * observations, and this codebase already treats explicit feedback as the
 * channel least able to bear that: feedback-prior.ts guards it with a prior
 * more than twice this one's strength precisely because it is tiny,
 * self-selected and gameable.
 *
 * So the weight is spent where a weight belongs — on the mean, relative to the
 * evidence it competes with — and concentration tracks real observations:
 *
 *   1 thumbs-up alone           → 0.60   (as one success: one look is one look)
 *   1 thumbs-up + 1 failure     → 0.58   (vs 0.50 unweighted — the thumb wins)
 *   1 thumbs-up + 3 failures    → 0.50   (vs 0.38 unweighted)
 *
 * With unweighted evidence every observation weighs 1, so `successWeight +
 * failureWeight === observations` and this is exactly `betaPosterior` — which
 * is also what makes a stats file written by an older build read correctly.
 */
export function weightedPosterior(
  successWeight: number,
  failureWeight: number,
  observations: number,
  priorStrength: number = PERF_PRIOR_STRENGTH,
): BetaPosterior {
  const success = Math.max(0, successWeight);
  const failure = Math.max(0, failureWeight);
  const evidence = success + failure;
  const n = Math.max(0, observations);
  if (evidence <= 0 || n <= 0) return betaPosterior(0, 0, priorStrength);
  const mean = success / evidence;
  const half = Math.max(0, priorStrength) / 2;
  return { alpha: half + mean * n, beta: half + (1 - mean) * n };
}

/** What we currently believe the success rate is. */
export function posteriorMean(p: BetaPosterior): number {
  const total = p.alpha + p.beta;
  return total > 0 ? p.alpha / total : 0.5;
}

/**
 * How unsure we are, as the posterior's standard deviation.
 *
 * Exposed for explanation rather than arithmetic: an exploratory pick is only
 * defensible to a user if we can say how little was known about the model that
 * won.
 */
export function posteriorStdDev(p: BetaPosterior): number {
  const n = p.alpha + p.beta;
  if (n <= 1) return 0.5;
  return Math.sqrt((p.alpha * p.beta) / (n * n * (n + 1)));
}

/** Uniform source in [0,1). Injected so every test here is deterministic. */
export type Rng = () => number;

/**
 * One Gamma(shape, 1) draw, Marsaglia–Tsang.
 *
 * The squeeze step is the published one and is kept verbatim rather than
 * simplified: it is what makes the acceptance rate high enough that this does
 * not loop, and it is easy to "tidy" into something subtly wrong.
 *
 * Shapes below 1 use the standard boost — draw at shape+1 and scale by
 * u^(1/shape) — because the bare algorithm is only valid at shape ≥ 1, and a
 * prior strength under 2 puts us there.
 */
function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    const boosted = sampleGamma(shape + 1, rng);
    const u = Math.max(rng(), Number.MIN_VALUE);
    return boosted * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // ONE bound over BOTH rejection kinds — the `v <= 0` redraw and the
  // acceptance test. Published presentations nest the redraw in its own
  // unbounded `do…while`, and that inner loop is the one that actually hangs:
  // a stream alternating 0 and 0.5 makes Box–Muller return the same large
  // negative x forever, so v is never positive and the outer bound is never
  // reached. Acceptance is ~95% per iteration, so exhausting this means the
  // RNG is degenerate, not that we were unlucky.
  for (let i = 0; i < 1000; i++) {
    const x = gaussian(rng);
    const root = 1 + c * x;
    if (root <= 0) continue;
    const v = root * root * root;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // degenerate RNG — fall back to the distribution's mode.
}

/** Box–Muller, one of the pair. */
function gaussian(rng: Rng): number {
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * A draw from the posterior — Thompson sampling's whole mechanism.
 *
 * Beta(α,β) as the ratio of two Gammas. Preferring a draw to the mean is what
 * makes exploration self-limiting: a model with little evidence has a wide
 * posterior and will sometimes draw high enough to win a turn, while a model
 * with a lot of evidence draws close to its mean every time. No schedule to
 * tune and no bonus to decay — the decay is the posterior narrowing.
 */
export function sampleBeta(p: BetaPosterior, rng: Rng): number {
  const x = sampleGamma(p.alpha, rng);
  const y = sampleGamma(p.beta, rng);
  const total = x + y;
  if (!Number.isFinite(total) || total <= 0) return posteriorMean(p);
  return x / total;
}
