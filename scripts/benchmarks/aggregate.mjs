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

export const TASK_KEYS = ['code', 'analysis', 'creative', 'data'];

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
  if (override && Number.isFinite(Number(override.min)) && Number.isFinite(Number(override.max))) {
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
 * Normalize one source into { family: { task: 0–100 } }, keeping only the cells
 * the source actually rates. `source` shape:
 *   { source, scale, eloFloor?, eloCeil?, calibration?, models: { family: {…} } }
 */
export function normalizeSource(source) {
  const bands = {};
  for (const task of TASK_KEYS) bands[task] = calibrationFor(source, task);
  const out = {};
  const models = source?.models ?? {};
  for (const [family, profile] of Object.entries(models)) {
    if (!profile || typeof profile !== 'object') continue;
    const clean = {};
    for (const task of TASK_KEYS) {
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
 * @returns { families, trace } — families is { family: { code,analysis,creative,data } };
 *          trace is { family: { task: { value, mode, contributors:[{source,value}] } } }
 *          for auditability (which source set each score, and every source's take).
 */
export function buildFamilies(sources, opts = {}) {
  const mode = opts.mode === 'robust' ? 'robust' : 'min';
  const base = opts.base ?? {};
  const normalized = sources.map((s) => ({ name: s?.source ?? 'unknown', map: normalizeSource(s) }));

  // Every family mentioned by any source, plus every family already in the base.
  const families = new Set(Object.keys(base));
  for (const { map } of normalized) for (const fam of Object.keys(map)) families.add(fam);

  const outFamilies = {};
  const trace = {};
  for (const fam of [...families].sort()) {
    const profile = {};
    const famTrace = {};
    for (const task of TASK_KEYS) {
      const contributors = [];
      for (const { name, map } of normalized) {
        const v = map[fam]?.[task];
        if (Number.isFinite(v)) contributors.push({ source: name, value: v });
      }
      const agg = conservativeAggregate(contributors.map((c) => c.value), mode);
      if (agg !== null) {
        profile[task] = agg;
        famTrace[task] = { value: agg, mode, contributors };
      } else if (Number.isFinite(base[fam]?.[task])) {
        // No source covers this cell — keep the committed baseline unchanged.
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
  return { families: outFamilies, trace };
}
