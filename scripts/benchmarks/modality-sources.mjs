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
  if (!raw.models || typeof raw.models !== 'object') {
    console.warn(`modality source ${raw.source}: no "models" map — skipping.`);
    return null;
  }
  const models = {};
  for (const [family, value] of Object.entries(raw.models)) {
    if (Number.isFinite(Number(value))) models[family] = Number(value);
  }
  if (Object.keys(models).length === 0) {
    console.warn(`modality source ${raw.source}: no valid model rows — skipping.`);
    return null;
  }
  return { ...raw, modality: raw.modality.trim(), lowerIsBetter: !!raw.lowerIsBetter, models };
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
