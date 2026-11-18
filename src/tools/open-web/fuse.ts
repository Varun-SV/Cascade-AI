// ─────────────────────────────────────────────
//  Cascade AI — Open Web: one list from many sources
// ─────────────────────────────────────────────
//
//  Reciprocal rank fusion: each source's ranking counts by its position and the
//  source's weight for this query, and a page more than one source found rises.
//  The same page under two addresses (tracking parameters, `www.`, a trailing
//  slash) is one result.

import type { WebSearchResult } from '../web-search.js';

export interface FusedResult extends WebSearchResult {
  /** Every source that found it, best first. */
  engines: string[];
  score: number;
}

const TRACKING = /^(?:utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_[a-z]+|ref_src|igshid|si|spm|_hsenc|_hsmi|yclid)$/i;

/** The address a page is known by, for telling duplicates apart. Exported for tests. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

export function hostOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, ''); } catch { return ''; }
}

/** The sources' lists, merged and ranked; at most `perHost` from one site. */
export function fuse(lists: Array<{ engine: string; weight: number; results: WebSearchResult[] }>, max: number, perHost = 2): FusedResult[] {
  const K = 60;
  const byUrl = new Map<string, FusedResult>();
  for (const { engine, weight, results } of lists) {
    results.forEach((r, rank) => {
      if (!/^https?:\/\//i.test(r.url)) return;
      const key = canonicalUrl(r.url);
      const add = weight / (K + rank + 1);
      const seen = byUrl.get(key);
      if (!seen) {
        byUrl.set(key, { ...r, engine, engines: [engine], score: add });
        return;
      }
      seen.score += add;
      if (!seen.engines.includes(engine)) seen.engines.push(engine);
      // The fuller description wins; the title a general engine gave is kept.
      if (r.snippet.length > seen.snippet.length) seen.snippet = r.snippet;
    });
  }
  // Found by several sources: a small lift beyond the summed ranks.
  for (const r of byUrl.values()) r.score *= 1 + 0.1 * (r.engines.length - 1);
  const ranked = [...byUrl.values()].sort((a, b) => b.score - a.score);
  const out: FusedResult[] = [];
  const perSite = new Map<string, number>();
  const held: FusedResult[] = [];
  for (const r of ranked) {
    const host = hostOf(r.url);
    const n = perSite.get(host) ?? 0;
    if (n >= perHost) { held.push(r); continue; }
    perSite.set(host, n + 1);
    out.push(r);
    if (out.length >= max) return out;
  }
  // Too few distinct sites: fill up from the ones held back, in order.
  for (const r of held) { if (out.length >= max) break; out.push(r); }
  return out;
}
