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
  // Bounded rather than `while (true)`: acceptance is ~95% per iteration, so a
  // thousand rejections means the RNG is degenerate (a stub returning a
  // constant, say) and looping forever would hang a routing decision.
  for (let i = 0; i < 1000; i++) {
    let x: number;
    let v: number;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
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
