// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — benchmark aggregator (pure engine, no I/O)
// ─────────────────────────────────────────────────────────────────────────────
//
//  Turns several benchmark sources — each rating models in its OWN native scale
//  (SWE-bench %, Artificial Analysis index, LMArena Elo, …) — into one 0–100
//  quality score per model family per task type, by:
//
//    1. NORMALIZE every source onto a common 0–100 quality scale with a fixed,
//       source-appropriate linear band (raw → (raw−min)/(max−min)·100). The band
//       defaults from the source's `scale` (index0-100/percent → 0..100; Elo →
//       1000..1500) and can be overridden PER TASK via `calibration`, because a
//       raw benchmark % is not a quality percentage — SWE-bench Verified tops out
//       near ~75% even for frontier coders, so `code` calibrates against that
//       reference-max rather than 100. The band is FIXED (not within-source
//       min-max) so a model's score doesn't move just because another model was
//       added to a capture.
//    2. AGGREGATE conservatively per family × task: across the sources that cover
//       that cell, take the LOWEST value ("min") — being strict about the
//       quality-to-cost trade-off (SWE-bench 80 + Arena 77 → 77). A "robust"
//       mode drops the single lowest as a possible outlier when ≥3 sources cover
//       the cell (guards against one mis-scraped number tanking a model).
//
//  Pure functions + plain data only — no fs, no network — so the whole engine is
//  unit-testable and the refresh script (scripts/refresh-benchmarks.mjs) and the
//  GitHub Action can run it with zero dependencies.

import { bareMap } from './bare-map.mjs';

export const TASK_KEYS = ['code', 'analysis', 'creative', 'data'];

/**
 * Scores a family MAY carry beyond the four task types. `agentic` is how well
 * a model holds a multi-step tool loop together (Terminal-Bench, SWE-bench,
 * τ²-bench): the router weights it for the tiers that orchestrate (T1 plans,
 * T2 manages) and for workers that call tools. Optional, so a family the
 * agentic boards never ran is still emitted on its four task scores.
 */
export const OPTIONAL_KEYS = ['agentic'];
export const ALL_KEYS = [...TASK_KEYS, ...OPTIONAL_KEYS];

/** Fewest shared models a `fitTo` calibration accepts; below it the task is skipped. */
export const MIN_FIT_PAIRS = 5;

/**
 * Weakest rank agreement a `fitTo` calibration accepts. Below it the two
 * benchmarks do not order models the same way, so a line between them only
 * manufactures numbers — e.g. agentic scores against writing preference
 * (Spearman ≈ 0.2). The task is skipped instead.
 */
export const MIN_FIT_SPEARMAN = 0.6;

/** Measured cells a family needs before its unrated task cells are imputed from them. */
export const MIN_IMPUTE_CELLS = 1;

/** Default Elo→0–100 reference band. 1000 reads as 0, 1500 as 100. */
export const DEFAULT_ELO_FLOOR = 1000;
export const DEFAULT_ELO_CEIL = 1500;

/** Clamp to an integer in [0, 100]; returns null for non-finite input. */
export function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * The default linear band (raw min→0, max→100) implied by a source's `scale`:
 *   index0-100 | percent → 0..100
 *   elo                  → eloFloor..eloCeil (default 1000..1500)
 * A source may override the band PER TASK via `calibration` (see calibrationFor).
 */
export function defaultBand(scale, opts = {}) {
  if (scale === 'elo') {
    const min = Number.isFinite(opts.eloFloor) ? opts.eloFloor : DEFAULT_ELO_FLOOR;
    const max = Number.isFinite(opts.eloCeil) ? opts.eloCeil : DEFAULT_ELO_CEIL;
    return { min, max };
  }
  return { min: 0, max: 100 };
}

/**
 * Resolve the calibration band for one task, letting a source override the
 * scale default. Used so a raw-benchmark source can say `code` maps against a
 * reference-max of ~75 (SWE-bench Verified's frontier ceiling) instead of 100,
 * turning a raw benchmark % into a comparable 0–100 quality score.
 */
export function calibrationFor(source, task) {
  const scale = source?.scale ?? 'percent';
  const base = defaultBand(scale, { eloFloor: source?.eloFloor, eloCeil: source?.eloCeil });
  const override = source?.calibration?.[task];
  if (override && override.fitTo === undefined && Number.isFinite(Number(override.min)) && Number.isFinite(Number(override.max))) {
    return { min: Number(override.min), max: Number(override.max) };
  }
  return base;
}

/**
 * Map one raw metric onto the common 0–100 quality scale via a linear band.
 * Returns null when the value is missing/non-finite or the band is degenerate,
 * so the caller can treat the cell as "not covered by this source".
 */
export function normalizeValue(raw, band) {
  if (raw === undefined || raw === null) return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  const min = Number(band?.min);
  const max = Number(band?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return clampScore(((v - min) / (max - min)) * 100);
}



/**
 * Theil–Sen line through (x, y) pairs: the median of all pairwise slopes, then
 * the median intercept. Robust to a minority of outliers, which matters here —
 * one model run under a broken config should not tilt a whole source's scale.
 */
export function theilSen(pairs) {
  const slopes = [];
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const dx = pairs[j][0] - pairs[i][0];
      if (dx !== 0) slopes.push((pairs[j][1] - pairs[i][1]) / dx);
    }
  }
  if (slopes.length === 0) return null;
  const median = (xs) => {
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const slope = median(slopes);
  const intercept = median(pairs.map(([x, y]) => y - slope * x));
  return { slope, intercept };
}

/** Spearman rank correlation, reported beside every fit so a weak one is visible. */
export function spearman(pairs) {
  const rank = (xs) => {
    const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(xs.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const n = pairs.length;
  if (n < 2) return null;
  const rx = rank(pairs.map((p) => p[0]));
  const ry = rank(pairs.map((p) => p[1]));
  const mean = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mean) * (ry[i] - mean);
    dx += (rx[i] - mean) ** 2;
    dy += (ry[i] - mean) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/**
 * The band each task of `source` normalizes through.
 *
 * A task may say `{ "fitTo": "<anchor source>" }` instead of a fixed band. A
 * raw % from a harder benchmark is not on the same scale as an easier one
 * (Terminal-Bench 4.0 puts Gemini 3.8 Flash at 20%, 2.1 at 81%), so taking the
 * lowest across them would only measure which benchmark is harder. Fitting
 * maps this source's raw numbers onto the anchor's raw numbers over the models
 * BOTH rate, then uses the anchor's band — after which "the lowest of the two"
 * compares like with like. The fit is a straight line, so it is expressed as
 * an ordinary band and nothing downstream changes.
 *
 * Returns { bands, fits }; a task whose fit cannot be made (anchor missing,
 * anchored itself, or fewer than MIN_FIT_PAIRS shared models) is left out of
 * `bands`, so that task is simply not covered by this source.
 */
export function resolveBands(source, byName = {}) {
  const bands = bareMap();
  const fits = bareMap();
  for (const task of ALL_KEYS) {
    const spec = source?.calibration?.[task];
    if (!spec || spec.fitTo === undefined) {
      bands[task] = calibrationFor(source, task);
      continue;
    }
    const anchor = byName[spec.fitTo];
    const anchorSpec = anchor?.calibration?.[task];
    if (!anchor || anchorSpec?.fitTo !== undefined) {
      console.warn(`benchmark source ${source?.source}: cannot fit ${task} to "${spec.fitTo}" (missing or itself fitted) — task skipped.`);
      continue;
    }
    const pairs = [];
    for (const [family, profile] of Object.entries(source.models ?? {})) {
      const x = Number(profile?.[task]);
      const y = Number(anchor.models?.[family]?.[task]);
      if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
    }
    const line = pairs.length >= MIN_FIT_PAIRS ? theilSen(pairs) : null;
    const rho = spearman(pairs);
    if (!line || !(line.slope > 0) || !(rho >= MIN_FIT_SPEARMAN)) {
      console.warn(
        `benchmark source ${source?.source}: ${task} fit to "${spec.fitTo}" needs ≥${MIN_FIT_PAIRS} shared models, ` +
        `a positive slope and Spearman ≥ ${MIN_FIT_SPEARMAN} (have n=${pairs.length}, ρ=${rho == null ? 'n/a' : rho.toFixed(2)}) — task skipped.`,
      );
      continue;
    }
    const target = calibrationFor(anchor, task);
    // y = slope·x + intercept, normalized through the anchor's band, is the
    // same as normalizing x through this band:
    bands[task] = {
      min: (target.min - line.intercept) / line.slope,
      max: (target.max - line.intercept) / line.slope,
    };
    fits[task] = { fitTo: spec.fitTo, n: pairs.length, slope: line.slope, intercept: line.intercept, spearman: rho };
  }
  return { bands, fits };
}

/**
 * Normalize one source into { family: { task: 0–100 } }, keeping only the cells
 * the source actually rates. `source` shape:
 *   { source, scale, eloFloor?, eloCeil?, calibration?, role?, models: { family: {…} } }
 * `byName` maps source ids to raw sources, for `fitTo` calibrations.
 */
export function normalizeSource(source, byName = {}, resolved = resolveBands(source, byName)) {
  const { bands } = resolved;
  const out = bareMap();
  const models = source?.models ?? {};
  for (const [family, profile] of Object.entries(models)) {
    if (!profile || typeof profile !== 'object') continue;
    const clean = bareMap();
    for (const task of ALL_KEYS) {
      if (!bands[task]) continue;
      const norm = normalizeValue(profile[task], bands[task]);
      if (norm !== null) clean[task] = norm;
    }
    if (Object.keys(clean).length > 0) out[family] = clean;
  }
  return out;
}

/**
 * Conservative aggregate of several covering values for one cell.
 *   mode 'min'    → the single lowest (default; strict quality-to-cost).
 *   mode 'robust' → with ≥3 values, drop the single lowest (possible outlier)
 *                   then take the lowest of the rest; otherwise the lowest.
 */
export function conservativeAggregate(values, mode = 'min') {
  const nums = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (nums.length === 0) return null;
  if (mode === 'robust' && nums.length >= 3) return nums[1];
  return nums[0];
}

/**
 * Build the aggregated families map from normalized sources.
 *
 * @param sources  array of raw source objects (native scales)
 * @param opts.mode 'min' | 'robust'                (default 'min')
 * @param opts.base current families map, used as a fallback for any cell no
 *                  source covers, so partial coverage never blanks a score.
 * @returns { families, trace, fits } — families is { family: { code,analysis,creative,data[,agentic] } };
 *          trace is { family: { task: { value, mode, contributors:[{source,value}] } } }
 *          for auditability (which source set each score, and every source's take);
 *          fits is { source: { task: fit } } for every `fitTo` calibration made.
 *
 * Precedence per cell: PRIMARY sources (conservative aggregate) → sources with
 * `role: "fallback"` (only when no primary source rates the cell) → IMPUTED,
 * the mean of the family's own measured cells this run (a task type no board
 * has run the model on is assumed to sit at its general level — never above
 * it) → the committed baseline. A fallback or an imputation never moves a
 * cell a real measurement covers; it only stands in where there is none.
 */
export function buildFamilies(sources, opts = {}) {
  const mode = opts.mode === 'robust' ? 'robust' : 'min';
  const base = bareMap(opts.base);
  const byName = bareMap();
  for (const s of sources) if (s?.source) byName[s.source] = s;
  const fits = bareMap();
  const normalized = sources.map((s) => {
    const resolved = resolveBands(s, byName);
    if (Object.keys(resolved.fits).length) fits[s?.source ?? 'unknown'] = resolved.fits;
    return {
      name: s?.source ?? 'unknown',
      fallback: s?.role === 'fallback',
      map: normalizeSource(s, byName, resolved),
    };
  });
  const primary = normalized.filter((n) => !n.fallback);
  const fallback = normalized.filter((n) => n.fallback);

  // Every family mentioned by any source, plus every family already in the base.
  const families = new Set(Object.keys(base));
  for (const { map } of normalized) for (const fam of Object.keys(map)) families.add(fam);

  const collect = (group, fam, task) => {
    const contributors = [];
    for (const { name, map } of group) {
      const v = map[fam]?.[task];
      if (Number.isFinite(v)) contributors.push({ source: name, value: v });
    }
    return contributors;
  };

  const outFamilies = bareMap();
  const trace = bareMap();
  for (const fam of [...families].sort()) {
    const profile = bareMap();
    const famTrace = bareMap();
    for (const task of ALL_KEYS) {
      let contributors = collect(primary, fam, task);
      let cellMode = mode;
      if (contributors.length === 0) {
        contributors = collect(fallback, fam, task);
        cellMode = 'fallback';
      }
      const agg = conservativeAggregate(contributors.map((c) => c.value), mode);
      if (agg !== null) {
        profile[task] = agg;
        famTrace[task] = { value: agg, mode: cellMode, contributors };
      }
    }
    // Impute task cells no source rates from what WAS measured for this family.
    const measured = Object.entries(famTrace).map(([, cell]) => cell.value);
    for (const task of TASK_KEYS) {
      if (Number.isFinite(profile[task])) continue;
      if (measured.length >= MIN_IMPUTE_CELLS) {
        const value = Math.round(measured.reduce((a, b) => a + b, 0) / measured.length);
        profile[task] = value;
        famTrace[task] = { value, mode: 'imputed', contributors: [] };
      } else if (Number.isFinite(base[fam]?.[task])) {
        // Nothing measured — keep the committed baseline unchanged.
        profile[task] = base[fam][task];
        famTrace[task] = { value: base[fam][task], mode: 'baseline', contributors: [] };
      }
    }
    // Only emit a family once it has a value for every task (routing reads all
    // four); otherwise fall back to whatever the base already had for it.
    if (TASK_KEYS.every((t) => Number.isFinite(profile[t]))) {
      outFamilies[fam] = profile;
      trace[fam] = famTrace;
    } else if (base[fam] && TASK_KEYS.every((t) => Number.isFinite(base[fam][t]))) {
      outFamilies[fam] = { ...base[fam] };
      trace[fam] = famTrace;
    }
  }
  return { families: outFamilies, trace, fits };
}
