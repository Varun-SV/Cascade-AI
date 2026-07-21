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
  if (typeof raw.source !== 'string' || !raw.source.trim()) {
    console.warn(`benchmark source ${filename}: missing "source" id — skipping.`);
    return null;
  }
  const scale = raw.scale ?? 'percent';
  if (!VALID_SCALES.has(scale)) {
    console.warn(`benchmark source ${raw.source}: unknown scale "${scale}" — skipping.`);
    return null;
  }
  if (!raw.models || typeof raw.models !== 'object') {
    console.warn(`benchmark source ${raw.source}: no "models" map — skipping.`);
    return null;
  }
  // Keep only well-formed model rows (an object with at least one task number).
  const models = {};
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
