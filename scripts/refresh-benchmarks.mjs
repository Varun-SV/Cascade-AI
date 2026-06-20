#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — benchmark snapshot refresher
// ─────────────────────────────────────────────────────────────────────────────
//
//  Maintains src/core/router/benchmark-data.json — the curated 0–100 quality
//  scores (per model family, per task type) that Cascade Auto routes on and that
//  LiveDataProvider.fetchSnapshot() pulls live from GitHub raw at runtime.
//
//  Invoked by .github/workflows/refresh-benchmarks.yml (weekly + on demand).
//  Contract that workflow relies on: this script writes the file ONLY when the
//  family scores actually change, so a no-op run produces no git diff and the
//  workflow opens no PR.
//
//    • BENCHMARK_SOURCE_URL set → fetch it, validate, clamp 0–100, merge over the
//      current families (per task-type override).
//    • unset → families are left untouched (the committed snapshot stays the
//      offline baseline) → no write → no PR.
//
//  Pure Node built-ins (global fetch on Node 18+); no dependencies.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TASK_KEYS = ['code', 'analysis', 'creative', 'data'];
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

async function main() {
  const current = JSON.parse(await readFile(dataFile, 'utf-8'));
  const currentFamilies = current.families ?? {};

  const sourceUrl = process.env.BENCHMARK_SOURCE_URL?.trim();
  let nextFamilies = { ...currentFamilies };

  if (sourceUrl) {
    console.log(`Fetching external benchmark source: ${sourceUrl}`);
    const fetched = await fetchExternal(sourceUrl);
    if (fetched) {
      // Override task scores per family; keep families the source omits.
      for (const [family, profile] of Object.entries(fetched)) {
        nextFamilies[family] = { ...nextFamilies[family], ...profile };
      }
    }
  } else {
    console.log('BENCHMARK_SOURCE_URL not set — keeping the committed snapshot as-is.');
  }

  if (canonicalFamilies(nextFamilies) === canonicalFamilies(currentFamilies)) {
    console.log('No snapshot changes — nothing to write.');
    return;
  }

  const next = {
    ...current,
    generatedAt: new Date().toISOString(),
    source: sourceUrl ? 'external' : current.source,
    families: nextFamilies,
  };
  await writeFile(dataFile, serialize(next), 'utf-8');
  console.log('Snapshot updated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
