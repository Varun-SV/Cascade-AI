// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — benchmark source loader
// ─────────────────────────────────────────────────────────────────────────────
//
//  Reads scripts/benchmarks/sources/*.json — one file per benchmarking website /
//  leaderboard — and hands validated source objects to the aggregator. Each file:
//
//    {
//      "source":     "suite-leaderboards",           // stable id (shown in traces)
//      "label":      "SWE-bench Verified, MMLU, …",   // human description
//      "url":        "https://…",                     // where the numbers come from
//      "capturedAt": "2026-07-21",                    // when this snapshot was taken
//      "provenance": "captured" | "seed-approximation",
//      "scale":      "percent" | "index0-100" | "elo",
//      "eloFloor":   1000, "eloCeil": 1500,           // only for scale:"elo"
//      "models": { "<family>": { "code": 72, "analysis": 88, … } }
//    }
//
//  A source may cover only some families and only some task types; the aggregator
//  simply uses whatever cells are present. Malformed files are skipped with a
//  warning rather than aborting the whole refresh.

import { readdir, readFile } from 'node:fs/promises';
import { bareMap } from './bare-map.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TASK_KEYS } from './aggregate.mjs';

const VALID_SCALES = new Set(['percent', 'index0-100', 'elo']);

export const SOURCES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'sources',
);

/** Shallow-validate one parsed source file. Returns the object or null. */
export function validateSource(raw, filename = '<inline>') {
  if (!raw || typeof raw !== 'object') {
    console.warn(`benchmark source ${filename}: not an object — skipping.`);
    return null;
  }
  // A modality-tagged file (vision, image-generation, ...) belongs to the
  // separate modality-sources.mjs/modality-aggregate.mjs pipeline, which
  // percentile-normalizes within its own source rather than using TASK_KEYS
  // + a fixed band. Not this loader's concern, and not a malformed file.
  if (typeof raw.modality === 'string' && raw.modality.trim()) return null;
  if (typeof raw.source !== 'string' || !raw.source.trim()) {
    console.warn(`benchmark source ${filename}: missing "source" id — skipping.`);
    return null;
  }
  const scale = raw.scale ?? 'percent';
  if (!VALID_SCALES.has(scale)) {
    console.warn(`benchmark source ${raw.source}: unknown scale "${scale}" — skipping.`);
    return null;
  }
  // `typeof [] === 'object'`, so an array walked straight through the old
  // check and `Object.entries` below then read its INDICES as model-family
  // names. A file saying `"models": [10, 20]` did not get skipped as this
  // function promises — it published scores for families called "0" and "1"
  // into the committed snapshot, where nothing downstream has any way to tell
  // them from a real family. A map is an object that is not an array, and the
  // guard has to say the second half out loud.
  if (!raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models)) {
    console.warn(`benchmark source ${raw.source}: "models" is not an object map — skipping.`);
    return null;
  }
  // Keep only well-formed model rows (an object with at least one task number).
  // Prototype-free, like every other map keyed by a name out of a source file.
  // A family called `__proto__` assigned into a plain object runs the inherited
  // setter and stores nothing, so a perfectly valid measurement disappears here
  // — and if it were the only row, the source is then rejected as empty. The
  // aggregator's own maps are already bare; they never get the chance to be if
  // the data is lost on the way in.
  const models = bareMap();
  for (const [family, profile] of Object.entries(raw.models)) {
    if (!profile || typeof profile !== 'object') continue;
    const hasAnyTask = TASK_KEYS.some((t) => Number.isFinite(Number(profile[t])));
    if (hasAnyTask) models[family] = profile;
  }
  if (Object.keys(models).length === 0) {
    console.warn(`benchmark source ${raw.source}: no valid model rows — skipping.`);
    return null;
  }
  return { ...raw, scale, models };
}

/** Load and validate every source JSON in `dir` (default: sources/). */
export async function loadSources(dir = SOURCES_DIR) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith('.json')).sort();
  const sources = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, file), 'utf-8'));
      const valid = validateSource(raw, file);
      if (valid) sources.push(valid);
    } catch (err) {
      console.warn(`benchmark source ${file}: ${err?.message ?? err} — skipping.`);
    }
  }
  return sources;
}
