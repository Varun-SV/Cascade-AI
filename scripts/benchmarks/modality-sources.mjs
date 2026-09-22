// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — non-text modality benchmark source loader
// ─────────────────────────────────────────────────────────────────────────────
//
//  Reads the same scripts/benchmarks/sources/*.json directory as sources.mjs,
//  but picks out the files that declare a `modality` (vision, image-generation,
//  video-generation, speech-to-text, text-to-speech, music-generation,
//  embeddings, reranking, ...) instead of the legacy text task keys. Shape:
//
//    {
//      "source":     "lmarena-text-to-image",
//      "modality":   "image-generation",
//      "metric":     "LMArena Text-to-Image Arena Elo",  // what the raw number IS
//      "label":      "LMArena — Text-to-Image arena",
//      "url":        "https://lmarena.ai/leaderboard/text-to-image",
//      "capturedAt": "2026-09-21",
//      "provenance": "captured" | "seed-approximation",
//      "lowerIsBetter": false,          // true for e.g. Word Error Rate
//      "models": { "<model-name>": <raw number>, ... }
//    }
//
//  Deliberately NO `scale`/`calibration` here: modality sources are normalized
//  by PERCENTILE RANK within their own model set (see modality-aggregate.mjs),
//  not against a fixed cross-source band, so the raw number's units don't
//  matter as long as `lowerIsBetter` says which direction is "better." A
//  source may rate as few or as many models as it likes; malformed files are
//  skipped with a warning, never aborting the refresh.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SOURCES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'sources',
);

/** Shallow-validate one parsed modality source file. Returns the object or null. */
export function validateModalitySource(raw, filename = '<inline>') {
  if (!raw || typeof raw !== 'object') return null;
  // Not a modality file at all (the legacy text pipeline owns these) — quietly
  // not our concern, no warning.
  if (typeof raw.modality !== 'string' || !raw.modality.trim()) return null;
  if (typeof raw.source !== 'string' || !raw.source.trim()) {
    console.warn(`modality source ${filename}: missing "source" id — skipping.`);
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
    console.warn(`modality source ${raw.source}: "models" is not an object map — skipping.`);
    return null;
  }
  // A real number, not anything JavaScript will coerce into one. `Number(null)`,
  // `Number('')`, `Number(false)` and `Number([])` are all 0 and all finite, so
  // the old check accepted a MISSING measurement and stored it as a score of
  // zero. On a lower-is-better metric — a Word Error Rate, a latency — that
  // silently makes the model nobody measured the best in the field, and because
  // normalization is a percentile within the source, one invented zero shifts
  // every other model's rank in that file.
  //
  // A dropped row is said out loud. Quietly ignoring one is how a source ends
  // up ranking fewer models than anyone thinks it does.
  const models = {};
  for (const [family, value] of Object.entries(raw.models)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      models[family] = value;
    } else {
      console.warn(
        `modality source ${raw.source}: "${family}" is not a finite number `
        + `(${value === null ? 'null' : typeof value}) — dropping that row.`,
      );
    }
  }
  if (Object.keys(models).length === 0) {
    console.warn(`modality source ${raw.source}: no valid model rows — skipping.`);
    return null;
  }
  // An ACTUAL boolean, or absent. `!!raw.lowerIsBetter` turned the string
  // "false" — the single likeliest way for a hand-edited or
  // machine-serialized JSON file to get this wrong — into `true`, silently
  // reversing the ranking direction for every model in the source. ("0" too.)
  // And because these files feed the committed percentile snapshot, one
  // flipped flag inverts every score the source produces while passing
  // validation cleanly.
  //
  // Skipped rather than defaulted. A file that says "false" meant something,
  // and guessing which direction it meant is how the whole source ends up
  // backwards; refusing it loses one source for one run, which is recoverable.
  if (raw.lowerIsBetter !== undefined && typeof raw.lowerIsBetter !== 'boolean') {
    console.warn(
      `modality source ${raw.source}: "lowerIsBetter" is ${typeof raw.lowerIsBetter} `
      + `(${JSON.stringify(raw.lowerIsBetter)}), not a boolean — skipping the whole source, `
      + 'because guessing the ranking direction would invert every score in it.',
    );
    return null;
  }
  return { ...raw, modality: raw.modality.trim(), lowerIsBetter: raw.lowerIsBetter === true, models };
}

/** Load and validate every modality-tagged source JSON in `dir` (default: sources/). */
export async function loadModalitySources(dir = SOURCES_DIR) {
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
      const valid = validateModalitySource(raw, file);
      if (valid) sources.push(valid);
    } catch (err) {
      console.warn(`modality source ${file}: ${err?.message ?? err} — skipping.`);
    }
  }
  return sources;
}
