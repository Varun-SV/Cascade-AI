#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — benchmark snapshot refresher
// ─────────────────────────────────────────────────────────────────────────────
//
//  Maintains src/core/router/benchmark-data.json — the curated 0–100 quality
//  scores (per model family, per task type) that Cascade Auto routes on and that
//  LiveDataProvider.fetchSnapshot() pulls live from GitHub raw at runtime.
//
//  Two ways it can update the families, applied in this order:
//
//    1. AGGREGATOR (default): read scripts/benchmarks/sources/*.json — one file
//       per benchmarking site (Artificial Analysis, LMArena, suite leaderboards)
//       in that site's native scale — normalise each onto a common 0–100 quality
//       scale, then take the CONSERVATIVE (lowest) value per family × task across
//       the sources that cover it (strict quality-to-cost). See scripts/benchmarks/.
//       Any cell no source covers keeps its committed baseline. Mode is 'min'
//       (default) or 'robust' (drop one low outlier when ≥3 sources); set via
//       BENCHMARK_AGG_MODE. Disable entirely with BENCHMARK_AGG=off.
//
//    2. BENCHMARK_SOURCE_URL (optional override): fetch a pre-normalised families
//       map / snapshot and merge it over the aggregated result (per task-type
//       override). Lets an external pre-computed feed win for specific families.
//
//  Invoked by .github/workflows/refresh-benchmarks.yml (weekly + on demand).
//  Contract the workflow relies on: this script writes the file ONLY when the
//  family scores actually change, so a no-op run produces no git diff and the
//  workflow opens no PR.
//
//  Pure Node built-ins (global fetch on Node 18+); no dependencies.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TASK_KEYS, buildFamilies } from './benchmarks/aggregate.mjs';
import { loadSources } from './benchmarks/sources.mjs';

const FETCH_TIMEOUT_MS = 8_000;

const dataFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src/core/router/benchmark-data.json',
);

/** Clamp to an integer in [0, 100]; returns null for non-finite input. */
function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Validate + normalise a families map: { fam: { code, analysis, creative, data } }. */
function sanitizeFamilies(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [family, profile] of Object.entries(raw)) {
    if (!profile || typeof profile !== 'object') continue;
    const clean = {};
    let ok = true;
    for (const key of TASK_KEYS) {
      const score = clampScore(profile[key]);
      if (score === null) { ok = false; break; }
      clean[key] = score;
    }
    if (ok) out[family] = clean;
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function fetchExternal(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      console.error(`Source fetch failed: HTTP ${resp.status} ${resp.statusText}`);
      return null;
    }
    const json = await resp.json();
    // Accept either a bare families map or a full snapshot object.
    const families = sanitizeFamilies(json?.families ?? json);
    if (!families) {
      console.error('Source payload had no valid families — ignoring.');
      return null;
    }
    return families;
  } catch (err) {
    console.error(`Source fetch error: ${err?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serialize the snapshot in the committed file's style: top-level keys with
 * 2-space indent, each family profile inline on one line. Keeps refresh diffs
 * minimal and reviewable (only changed scores move).
 */
function serialize(snapshot) {
  const lines = ['{'];
  for (const key of Object.keys(snapshot)) {
    if (key === 'families') continue;
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(snapshot[key])},`);
  }
  lines.push('  "families": {');
  const families = Object.entries(snapshot.families);
  families.forEach(([family, profile], i) => {
    const inner = TASK_KEYS.map((k) => `"${k}": ${profile[k]}`).join(', ');
    lines.push(`    ${JSON.stringify(family)}: { ${inner} }${i < families.length - 1 ? ',' : ''}`);
  });
  lines.push('  }', '}');
  return `${lines.join('\n')}\n`;
}

/** Stable, key-sorted serialization for order-independent comparison. */
function canonicalFamilies(families) {
  const sortedFamilies = {};
  for (const family of Object.keys(families).sort()) {
    const profile = families[family];
    const sortedProfile = {};
    for (const key of TASK_KEYS) sortedProfile[key] = profile[key];
    sortedFamilies[family] = sortedProfile;
  }
  return JSON.stringify(sortedFamilies);
}

/** Print the per-cell provenance trace (which source set each score). */
function printTrace(trace) {
  for (const family of Object.keys(trace).sort()) {
    console.log(`\n${family}`);
    for (const task of TASK_KEYS) {
      const cell = trace[family][task];
      if (!cell) continue;
      const from = cell.contributors.length
        ? cell.contributors.map((c) => `${c.source}=${c.value}`).join(', ')
        : cell.mode;
      console.log(`  ${task.padEnd(9)} ${String(cell.value).padStart(3)}  [${cell.mode}]  ${from}`);
    }
  }
}

async function main() {
  const explain = process.argv.includes('--explain') || process.env.BENCHMARK_EXPLAIN === '1';
  const current = JSON.parse(await readFile(dataFile, 'utf-8'));
  const currentFamilies = current.families ?? {};

  let nextFamilies = { ...currentFamilies };
  let usedAggregator = false;

  // 1. Aggregator over the committed per-source files (unless disabled).
  if (process.env.BENCHMARK_AGG !== 'off') {
    const sources = await loadSources();
    if (sources.length > 0) {
      // Default 'robust' (drop one low outlier when ≥3 sources cover a cell) so a
      // single mis-captured number can't tank a model; BENCHMARK_AGG_MODE=min
      // forces the stricter pure-lowest.
      const mode = process.env.BENCHMARK_AGG_MODE === 'min' ? 'min' : 'robust';
      const { families, trace } = buildFamilies(sources, { mode, base: currentFamilies });
      nextFamilies = families;
      usedAggregator = true;
      console.log(
        `Aggregated ${sources.length} source(s) [${sources.map((s) => s.source).join(', ')}] ` +
        `in '${mode}' mode → ${Object.keys(families).length} families.`,
      );
      if (explain) printTrace(trace);
    } else {
      console.log('No benchmark sources found — keeping the committed snapshot as the baseline.');
    }
  } else {
    console.log('BENCHMARK_AGG=off — skipping the source aggregator.');
  }

  // 2. Optional external pre-normalised feed, merged over the aggregate.
  const sourceUrl = process.env.BENCHMARK_SOURCE_URL?.trim();
  if (sourceUrl) {
    console.log(`Fetching external benchmark source: ${sourceUrl}`);
    const fetched = await fetchExternal(sourceUrl);
    if (fetched) {
      for (const [family, profile] of Object.entries(fetched)) {
        nextFamilies[family] = { ...nextFamilies[family], ...profile };
      }
    }
  }

  if (canonicalFamilies(nextFamilies) === canonicalFamilies(currentFamilies)) {
    console.log('No snapshot changes — nothing to write.');
    return;
  }

  const next = {
    ...current,
    generatedAt: new Date().toISOString(),
    source: sourceUrl ? 'external+aggregate' : (usedAggregator ? 'aggregate' : current.source),
    families: nextFamilies,
  };
  await writeFile(dataFile, serialize(next), 'utf-8');
  console.log('Snapshot updated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
