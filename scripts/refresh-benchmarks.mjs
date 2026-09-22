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
import { buildAllModalities } from './benchmarks/modality-aggregate.mjs';
import { loadModalitySources } from './benchmarks/modality-sources.mjs';

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
 * minimal and reviewable (only changed scores move). `modalities` (when
 * present) is a second, backwards-compatible section: { modality: { family:
 * score } }, one family per line, sorted — consumers that only know about
 * `families` (the text task-type table) simply never look at it.
 */
function serialize(snapshot) {
  const lines = ['{'];
  for (const key of Object.keys(snapshot)) {
    if (key === 'families' || key === 'modalities') continue;
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(snapshot[key])},`);
  }
  const hasModalities = snapshot.modalities && Object.keys(snapshot.modalities).length > 0;
  lines.push('  "families": {');
  const families = Object.entries(snapshot.families);
  families.forEach(([family, profile], i) => {
    const inner = TASK_KEYS.map((k) => `"${k}": ${profile[k]}`).join(', ');
    lines.push(`    ${JSON.stringify(family)}: { ${inner} }${i < families.length - 1 ? ',' : ''}`);
  });
  lines.push(hasModalities ? '  },' : '  }');
  if (hasModalities) {
    lines.push('  "modalities": {');
    const modalityEntries = Object.entries(snapshot.modalities);
    modalityEntries.forEach(([modality, famScores], mi) => {
      lines.push(`    ${JSON.stringify(modality)}: {`);
      const rows = Object.entries(famScores);
      rows.forEach(([family, score], i) => {
        lines.push(`      ${JSON.stringify(family)}: ${score}${i < rows.length - 1 ? ',' : ''}`);
      });
      lines.push(`    }${mi < modalityEntries.length - 1 ? ',' : ''}`);
    });
    lines.push('  }');
  }
  lines.push('}');
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

/** Stable, key-sorted serialization of { modality: { family: score } } for comparison. */
function canonicalModalities(modalities) {
  const sorted = {};
  for (const modality of Object.keys(modalities ?? {}).sort()) {
    const fam = modalities[modality] ?? {};
    const sortedFam = {};
    for (const family of Object.keys(fam).sort()) sortedFam[family] = fam[family];
    sorted[modality] = sortedFam;
  }
  return JSON.stringify(sorted);
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

/** Print the per-modality, per-family provenance trace. */
function printModalityTrace(traces) {
  for (const modality of Object.keys(traces).sort()) {
    console.log(`\n[${modality}]`);
    const famTrace = traces[modality];
    for (const family of Object.keys(famTrace).sort()) {
      const cell = famTrace[family];
      const from = cell.contributors.length
        ? cell.contributors.map((c) => `${c.source}=${c.value}`).join(', ')
        : cell.mode;
      console.log(`  ${family.padEnd(28)} ${String(cell.value).padStart(3)}  [${cell.mode}]  ${from}`);
    }
  }
}

async function main() {
  const explain = process.argv.includes('--explain') || process.env.BENCHMARK_EXPLAIN === '1';
  const current = JSON.parse(await readFile(dataFile, 'utf-8'));
  const currentFamilies = current.families ?? {};
  const currentModalities = current.modalities ?? {};

  let nextFamilies = { ...currentFamilies };
  let nextModalities = { ...currentModalities };
  let nextComparability = null;
  let usedAggregator = false;

  // 1. Aggregator over the committed per-source files (unless disabled). Text
  //    sources (scale/calibration) and modality sources (percentile rank) are
  //    both read from scripts/benchmarks/sources/ and aggregated in parallel —
  //    a source file declares which pipeline it belongs to via `modality`.
  if (process.env.BENCHMARK_AGG !== 'off') {
    const [sources, modalitySources] = await Promise.all([loadSources(), loadModalitySources()]);
    if (sources.length > 0) {
      // Default 'robust' (drop one low outlier when ≥3 sources cover a cell) so a
      // single mis-captured number can't tank a model; BENCHMARK_AGG_MODE=min
      // forces the stricter pure-lowest.
      const mode = process.env.BENCHMARK_AGG_MODE === 'min' ? 'min' : 'robust';
      const { families, trace } = buildFamilies(sources, { mode, base: currentFamilies });
      nextFamilies = families;
      usedAggregator = true;
      console.log(
        `Aggregated ${sources.length} text source(s) [${sources.map((s) => s.source).join(', ')}] ` +
        `in '${mode}' mode → ${Object.keys(families).length} families.`,
      );
      if (explain) printTrace(trace);
    } else {
      console.log('No text benchmark sources found — keeping the committed snapshot as the baseline.');
    }

    if (modalitySources.length > 0) {
      const mode = process.env.BENCHMARK_AGG_MODE === 'min' ? 'min' : 'robust';
      const { modalities, traces, comparabilities } = buildAllModalities(modalitySources, { mode, base: currentModalities });
      nextModalities = modalities;
      // Carried into the snapshot, not just printed. The scores are percentile
      // ranks inside each source's own model set, so two of them are only
      // comparable when their sources share models. Dropping that fact here —
      // which is what happened when only `modalities` and `traces` were taken —
      // hands a future routing consumer a page of plain 0-100 numbers with
      // nothing to tell it which ones may be read against each other.
      nextComparability = comparabilities;
      usedAggregator = true;
      const incomparable = Object.entries(comparabilities)
        .filter(([, c]) => c.disjoint)
        .map(([m]) => m);
      if (incomparable.length > 0) {
        console.log(
          `  ${incomparable.length} modality/ies have DISJOINT sources and are not yet comparable: ` +
          `${incomparable.join(', ')}. See "What percentile rank does NOT give you" in ` +
          'docs/benchmark-aggregation.md.',
        );
      }
      console.log(
        `Aggregated ${modalitySources.length} modality source(s) [${modalitySources.map((s) => s.source).join(', ')}] ` +
        `→ ${Object.keys(modalities).length} modalities.`,
      );
      if (explain) printModalityTrace(traces);
    } else {
      console.log('No modality benchmark sources found — keeping the committed modality snapshot as the baseline.');
    }
  } else {
    console.log('BENCHMARK_AGG=off — skipping the source aggregator.');
  }

  // 2. Optional external pre-normalised feed, merged over the aggregate (text
  //    families only — the modality section has no equivalent override today).
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

  const familiesChanged = canonicalFamilies(nextFamilies) !== canonicalFamilies(currentFamilies);
  const modalitiesChanged = canonicalModalities(nextModalities) !== canonicalModalities(currentModalities);
  // A modality whose sources stopped (or started) overlapping is a change even
  // when every score lands the same, because it changes what the scores MEAN.
  const nextComparabilities = nextComparability ?? current.modalityComparability ?? null;
  const comparabilityChanged =
    JSON.stringify(nextComparabilities) !== JSON.stringify(current.modalityComparability ?? null);
  if (!familiesChanged && !modalitiesChanged && !comparabilityChanged) {
    console.log('No snapshot changes — nothing to write.');
    return;
  }

  const next = {
    ...current,
    generatedAt: new Date().toISOString(),
    source: sourceUrl ? 'external+aggregate' : (usedAggregator ? 'aggregate' : current.source),
    families: nextFamilies,
    ...(Object.keys(nextModalities).length > 0 ? { modalities: nextModalities } : {}),
    // Ships WITH the scores it qualifies. A consumer reading `modalities` can
    // read this in the same file and refuse a modality whose sources share no
    // models, instead of discovering the caveat in a doc it never opened.
    ...(nextComparabilities ? { modalityComparability: nextComparabilities } : {}),
  };
  await writeFile(dataFile, serialize(next), 'utf-8');
  console.log('Snapshot updated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
