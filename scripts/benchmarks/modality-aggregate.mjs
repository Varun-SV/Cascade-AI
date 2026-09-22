// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — non-text modality benchmark aggregator (pure engine, no I/O)
// ─────────────────────────────────────────────────────────────────────────────
//
//  Cascade's routing scope is expanding beyond text/chat to every kind of model
//  on the market: vision, image generation, video generation, speech-to-text,
//  text-to-speech, music generation, embeddings/reranking, ... Each of those
//  modalities is benchmarked by a *different* site with a *different* metric
//  (an Elo from a pairwise arena, a raw accuracy %, a Word Error Rate where
//  LOWER is better, an nDCG@10 retrieval score, ...), and those metrics are
//  never comparable to each other even within the same modality (LMArena Elo
//  ranges 1000-1500-ish; a WER is a small percentage; an nDCG is 0-1).
//
//  So unlike the text pipeline (aggregate.mjs), which normalizes each source
//  onto a common 0-100 scale via a fixed, source-appropriate band, this engine
//  normalizes each source via its OWN **percentile rank**: every model's score
//  is expressed purely as "how this model compares to the other models THIS
//  SAME SOURCE also rated," with no cross-source scale to get wrong. That is
//  the whole point of the redesign — never compare raw numbers across sources.
//
//  Percentile rank uses the standard mid-rank formula so ties split the
//  difference: rank(v) = (countBelow(v) + 0.5 * countEqual(v)) / n * 100. A
//  source with a single model normalizes to a neutral 50 (no comparison is
//  possible), rather than clamping straight to 100.
//
//  Once every source is in percentile terms, aggregation across sources is the
//  same conservative policy as the text pipeline (imported, not duplicated):
//  take the lowest per family, or drop one low outlier in 'robust' mode when
//  >= 3 sources cover a cell.

import { clampScore, conservativeAggregate } from './aggregate.mjs';
import { bareMap } from './bare-map.mjs';

export { clampScore, conservativeAggregate };

/**
 * Percentile-normalize one modality source's raw values against that source's
 * OWN population — never against any other source or a fixed band.
 * `source.lowerIsBetter` (e.g. Word Error Rate) flips the ranking direction.
 * Returns { family: 0-100 } for every family the source rates a finite number
 * for; models with a non-finite value are dropped from the comparison set.
 */
export function percentileNormalizeSource(source) {
  const lowerIsBetter = !!source?.lowerIsBetter;
  const models = source?.models ?? {};
  const entries = Object.entries(models).filter(([, v]) => Number.isFinite(Number(v)));
  const n = entries.length;
  if (n === 0) return {};
  const values = entries.map(([, v]) => Number(v));

  const out = bareMap();
  for (const [family, rawVal] of entries) {
    const v = Number(rawVal);
    let below = 0;
    let equal = 0;
    for (const other of values) {
      const better = lowerIsBetter ? other < v : other > v;
      const worse = lowerIsBetter ? other > v : other < v;
      if (worse) below++;
      else if (!better) equal++; // other === v (includes comparing v to itself)
    }
    out[family] = clampScore(((below + 0.5 * equal) / n) * 100);
  }
  return out;
}

/**
 * Group raw source objects by their declared `modality`, skipping any source
 * that doesn't declare one (i.e. the legacy text pipeline's sources, which
 * aggregate.mjs/buildFamilies already handles).
 */
/**
 * How far a modality's sources actually overlap.
 *
 * Percentile rank is a rank WITHIN a source's own model set, which removes the
 * unit problem and creates a population one: being top of five open-weights
 * models and being top of a forty-model blended arena both come out near 100,
 * and nothing in the number says which happened. Two sources can only be read
 * on one axis if they share enough models to anchor one to the other.
 *
 * So the overlap is computed and reported rather than assumed. `shared` counts
 * families more than one source scores — the anchors calibration would need.
 * `disjoint` is the case that has no honest single axis at all: sources that
 * name entirely different models, where every score is a rank in a population
 * no other score shares.
 *
 * This does not correct the scores; nothing here can, because with disjoint
 * cohorts there is no measurement linking them. It makes the limitation
 * machine-visible, so a consumer that needs comparable values can refuse
 * rather than quietly assume it has them.
 *
 * `shared` and `components` answer different questions and a consumer wants
 * both. `components === 1` says the sources form ONE population — necessary,
 * and not sufficient: the committed `embeddings` pair is connected by exactly
 * ONE shared model across sixteen, which is a bridge in the graph sense and
 * nowhere near enough to calibrate against. A gate that cares about accuracy
 * requires `components === 1` AND enough of `shared` to mean it.
 */
export function cohortOverlap(sources) {
  const perSource = (sources ?? []).map((s) => new Set(Object.keys(s?.models ?? {})));
  const counts = new Map();
  for (const set of perSource) {
    for (const fam of set) counts.set(fam, (counts.get(fam) ?? 0) + 1);
  }
  let shared = 0;
  for (const n of counts.values()) if (n > 1) shared++;

  // Connectivity, not "did any model appear twice". Counting shared models
  // says A and B are linked; it says nothing about C, which can share nothing
  // with either and still be waved through by a `shared > 0` test. Sources
  // form one axis only when the overlap graph is CONNECTED, so the graph is
  // what gets measured: union sources that share a model, then count the
  // components left over.
  const parent = perSource.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < perSource.length; i++) {
    for (let j = i + 1; j < perSource.length; j++) {
      for (const fam of perSource[i]) {
        if (perSource[j].has(fam)) { union(i, j); break; }
      }
    }
  }
  const roots = new Set(perSource.map((_, i) => find(i)));
  const components = roots.size;

  return {
    sources: perSource.length,
    families: counts.size,
    shared,
    components,
    // Cells kept from the previous snapshot because no source covered them
    // this run. Zero unless `buildModalityFamilies` fills it in.
    carriedFamilies: 0,
    // More than one island means at least one source's ranks are measured
    // against a population nothing else touches.
    disjoint: components > 1,
  };
}

export function groupByModality(sources) {
  // Prototype-free: a source whose `modality` is `toString` or `__proto__`
  // used to abort the entire refresh here rather than being skipped, because
  // `groups[modality]` answered with an inherited value and `??=` left it in
  // place. See `bareMap`.
  const groups = bareMap();
  for (const s of sources ?? []) {
    const modality = s?.modality;
    if (typeof modality !== 'string' || !modality.trim()) continue;
    (groups[modality] ??= []).push(s);
  }
  return groups;
}

/**
 * Build the aggregated { family: 0-100 } map for ONE modality from the
 * sources that cover it.
 *
 * @param sources  array of raw source objects, all sharing one `modality`
 * @param opts.mode 'min' | 'robust' (default 'min')
 * @param opts.base current { family: score } map for this modality, used as a
 *                  fallback for any family no source in this run covers, so a
 *                  quiet week (or a source going temporarily unreachable)
 *                  never blanks a family's score.
 * @returns { families, trace } — trace mirrors aggregate.mjs's shape:
 *          { family: { value, mode, contributors: [{source, value}] } }
 */
export function buildModalityFamilies(sources, opts = {}) {
  const mode = opts.mode === 'robust' ? 'robust' : 'min';
  const base = bareMap(opts.base);
  const normalized = (sources ?? []).map((s) => ({
    name: s?.source ?? 'unknown',
    map: percentileNormalizeSource(s),
  }));

  const families = new Set(Object.keys(base));
  for (const { map } of normalized) for (const fam of Object.keys(map)) families.add(fam);

  const outFamilies = bareMap();
  const trace = bareMap();
  let carried = 0;
  for (const fam of [...families].sort()) {
    const contributors = [];
    for (const { name, map } of normalized) {
      const v = map[fam];
      if (Number.isFinite(v)) contributors.push({ source: name, value: v });
    }
    const agg = conservativeAggregate(contributors.map((c) => c.value), mode);
    if (agg !== null) {
      outFamilies[fam] = agg;
      trace[fam] = { value: agg, mode, contributors };
    } else if (Number.isFinite(base[fam])) {
      outFamilies[fam] = base[fam];
      trace[fam] = { value: base[fam], mode: 'baseline', contributors: [] };
      carried++;
    }
  }

  // Comparability has to describe the SCORES, not the sources that happened to
  // run. A carried-over cell was measured against a population that is not
  // here — if one of the two disjoint text-to-speech sources goes missing or
  // is skipped as malformed, its scores stay in the snapshot while a naive
  // recount reports one source, one component and `disjoint: false`, which is
  // the documented gate saying yes to exactly the values it exists to refuse.
  //
  // So a run that carries anything forward cannot claim the cohorts are
  // connected. `carriedFamilies` says how many cells came from the baseline,
  // and their absent source counts as its own component.
  const comparability = cohortOverlap(sources ?? []);
  comparability.carriedFamilies = carried;
  if (carried > 0) {
    comparability.components += 1;
    comparability.disjoint = comparability.components > 1;
  }
  return { families: outFamilies, trace, comparability };
}

/**
 * Build every modality's family map in one pass from a flat list of raw
 * sources (a mix of modalities is fine — they're grouped first).
 *
 * @param opts.base current { modality: { family: score } } map (the
 *                  committed `modalities` section of benchmark-data.json).
 * @returns { modalities, traces } — a modality present in `base` but with no
 *          covering source this run is carried through unchanged, mirroring
 *          the "uncovered cell keeps the baseline" rule of the text pipeline.
 */
export function buildAllModalities(sources, opts = {}) {
  const mode = opts.mode === 'robust' ? 'robust' : 'min';
  const base = bareMap(opts.base);
  // The committed snapshot's `modalityComparability`, so a modality carried
  // wholesale keeps what is known about how its scores were made.
  const baseComparability = bareMap(opts.baseComparability);
  const groups = groupByModality(sources);

  const modalities = bareMap();
  const traces = bareMap();
  const comparabilities = bareMap();
  for (const modality of Object.keys(groups).sort()) {
    const { families, trace, comparability } = buildModalityFamilies(groups[modality], {
      mode,
      base: base[modality],
    });
    if (Object.keys(families).length > 0) {
      modalities[modality] = families;
      traces[modality] = trace;
      comparabilities[modality] = comparability;
    }
  }
  for (const modality of Object.keys(base).sort()) {
    if (modalities[modality]) continue;
    if (base[modality] && Object.keys(base[modality]).length > 0) {
      const carried = Object.keys(base[modality]).length;
      modalities[modality] = base[modality];
      // This branch carries a whole modality forward when every one of its
      // sources is absent or malformed — and it bypasses `buildModalityFamilies`
      // entirely, so without this the scores would reappear in the next snapshot
      // with NO comparability entry at all: the machine-visible warning deleted
      // by the very run that made it most necessary.
      //
      // Nothing measured anything this time, so nothing vouches for these
      // ranks. Previous metadata is preserved where it exists, because it still
      // describes how these numbers were made — but `sources: 0` and
      // `disjoint: true` overwrite whatever it said, since a run that measured
      // nothing cannot inherit a claim that the cohorts were comparable.
      comparabilities[modality] = {
        ...(baseComparability[modality] ?? { families: carried, shared: 0, components: 0 }),
        sources: 0,
        carriedFamilies: carried,
        disjoint: true,
      };
    }
  }
  return { modalities, traces, comparabilities };
}
