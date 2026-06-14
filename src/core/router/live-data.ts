// ─────────────────────────────────────────────
//  Cascade AI — Live benchmark + pricing data
// ─────────────────────────────────────────────
//
//  Hybrid data source for Cascade Auto: fetches *current* public data and
//  degrades gracefully when offline.
//
//    quality scores : live GitHub-raw snapshot → disk cache → bundled table
//    per-token price : live OpenRouter (free, no key) → disk cache → catalog
//
//  All network work is best-effort and time-boxed; any failure silently keeps
//  the last-known-good data. Refresh is meant to run in the background (see
//  CascadeRouter.refreshLiveData) so it never blocks a task.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ModelInfo } from '../../types.js';
import type { BenchmarkProfile } from './benchmarks.js';
import { GLOBAL_CONFIG_DIR } from '../../constants.js';
import { withTimeout } from '../../utils/retry.js';

/** Shape of the committed/refreshable quality snapshot (benchmark-data.json). */
export interface BenchmarkSnapshot {
  generatedAt: string;
  source: string;
  families: Record<string, BenchmarkProfile>;
}

export type DataSource = 'live' | 'cache' | 'bundled';

interface PriceEntry { input: number; output: number }

interface DiskCache {
  fetchedAt: number;
  snapshot?: BenchmarkSnapshot;
  prices?: Record<string, PriceEntry>;
}

export interface LiveDataOptions {
  /** Master switch for live quality fetch. Default: true. */
  live?: boolean;
  /** Master switch for live OpenRouter pricing. Default: true. */
  pricingLive?: boolean;
  /** Hours a fetched snapshot stays fresh before re-fetching. Default: 24. */
  refreshHours?: number;
  /** Override the quality snapshot URL. */
  sourceUrl?: string;
  /** Override the on-disk cache path (tests). */
  cacheFile?: string;
}

// Maintained snapshot, served straight from the repo. Updated by the
// scheduled refresh workflow; fetched live so users get the latest without a
// package upgrade.
const DEFAULT_SNAPSHOT_URL =
  'https://raw.githubusercontent.com/Varun-SV/Cascade-AI/main/src/core/router/benchmark-data.json';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_FILE = path.join(os.homedir(), GLOBAL_CONFIG_DIR, 'benchmarks-cache.json');

/**
 * Normalises a model id for cross-source matching: drops a `vendor/` prefix
 * (OpenRouter style) and trailing date / preview suffixes, lower-cased.
 *   "google/gemini-2.5-flash"            → "gemini-2.5-flash"
 *   "claude-haiku-4-5-20251001"          → "claude-haiku-4-5"
 *   "gemini-2.5-flash-preview-04-17"     → "gemini-2.5-flash"
 */
export function normalizeModelId(id: string): string {
  let s = id.toLowerCase();
  const slash = s.lastIndexOf('/');
  if (slash !== -1) s = s.slice(slash + 1);
  s = s.replace(/-preview(?:-\d{2}-\d{2})?$/, '');
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(/[:@].*$/, '');
  return s;
}

export class LiveDataProvider {
  private snapshot: BenchmarkSnapshot | null = null;
  private prices = new Map<string, PriceEntry>();
  private source: DataSource = 'bundled';
  private fetchedAt = 0;
  private loaded = false;
  private refreshing: Promise<void> | null = null;
  private readonly opts: Required<Omit<LiveDataOptions, 'sourceUrl'>> & { sourceUrl?: string };

  constructor(opts: LiveDataOptions = {}) {
    this.opts = {
      live: opts.live ?? true,
      pricingLive: opts.pricingLive ?? true,
      refreshHours: opts.refreshHours ?? 24,
      cacheFile: opts.cacheFile ?? DEFAULT_CACHE_FILE,
      sourceUrl: opts.sourceUrl,
    };
  }

  /** Load cached data from disk (cheap, no network). Safe to call repeatedly. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.opts.cacheFile, 'utf-8');
      const cache = JSON.parse(raw) as DiskCache;
      if (cache.snapshot?.families) {
        this.snapshot = cache.snapshot;
        this.source = 'cache';
      }
      if (cache.prices) {
        for (const [id, p] of Object.entries(cache.prices)) this.prices.set(id, p);
      }
      this.fetchedAt = cache.fetchedAt ?? 0;
    } catch {
      // No cache yet — bundled fallbacks remain in effect.
    }
  }

  /**
   * Refresh from the network if the cache is older than the TTL. Coalesces
   * concurrent callers and never throws — failures keep last-known-good data.
   */
  async refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh(force).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(force: boolean): Promise<void> {
    await this.load();
    const ttlMs = this.opts.refreshHours * 3_600_000;
    const fresh = ttlMs > 0 && Date.now() - this.fetchedAt < ttlMs;
    if (!force && fresh && this.source !== 'bundled') return;

    const [snap, prices] = await Promise.all([
      this.opts.live ? this.fetchSnapshot() : Promise.resolve(null),
      this.opts.pricingLive ? this.fetchPrices() : Promise.resolve(null),
    ]);

    let changed = false;
    if (snap) { this.snapshot = snap; this.source = 'live'; changed = true; }
    if (prices && prices.size > 0) { this.prices = prices; changed = true; }
    if (changed) {
      this.fetchedAt = Date.now();
      await this.saveCache();
    }
  }

  private async fetchSnapshot(): Promise<BenchmarkSnapshot | null> {
    const url = this.opts.sourceUrl ?? DEFAULT_SNAPSHOT_URL;
    try {
      const resp = await withTimeout(fetch(url), FETCH_TIMEOUT_MS, 'benchmark fetch timed out');
      if (!resp.ok) return null;
      const data = await resp.json() as BenchmarkSnapshot;
      if (!data || typeof data !== 'object' || !data.families || typeof data.families !== 'object') {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  private async fetchPrices(): Promise<Map<string, PriceEntry> | null> {
    try {
      const resp = await withTimeout(fetch(OPENROUTER_MODELS_URL), FETCH_TIMEOUT_MS, 'pricing fetch timed out');
      if (!resp.ok) return null;
      const data = await resp.json() as {
        data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>;
      };
      if (!Array.isArray(data?.data)) return null;
      const out = new Map<string, PriceEntry>();
      for (const m of data.data) {
        if (!m?.id || !m.pricing) continue;
        // OpenRouter prices are per-token USD strings; convert to per-1k.
        const input = Number(m.pricing.prompt) * 1000;
        const output = Number(m.pricing.completion) * 1000;
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
        out.set(normalizeModelId(m.id), { input, output });
      }
      return out;
    } catch {
      return null;
    }
  }

  private async saveCache(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.opts.cacheFile), { recursive: true });
      const cache: DiskCache = {
        fetchedAt: this.fetchedAt,
        snapshot: this.snapshot ?? undefined,
        prices: Object.fromEntries(this.prices),
      };
      await fs.writeFile(this.opts.cacheFile, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {
      // Non-critical — in-memory data is still used this session.
    }
  }

  /** Quality profile for a model family, or null when we have no live/cached data. */
  getQualityProfile(family: string): BenchmarkProfile | null {
    return this.snapshot?.families?.[family] ?? null;
  }

  /** Current per-1k price for a model id, or null when unknown. */
  getLivePrice(modelId: string): PriceEntry | null {
    return this.prices.get(normalizeModelId(modelId)) ?? null;
  }

  /**
   * Returns a price-corrected copy of each model when live pricing is known,
   * leaving the original untouched (so the shared catalog is never mutated).
   */
  applyLivePricing(models: ModelInfo[]): ModelInfo[] {
    return models.map((m) => {
      const p = this.getLivePrice(m.id);
      if (!p) return m;
      return { ...m, inputCostPer1kTokens: p.input, outputCostPer1kTokens: p.output };
    });
  }

  /** Where the active quality data came from — for /why and `cascade models`. */
  getDataSource(): DataSource { return this.source; }
  getGeneratedAt(): string | null { return this.snapshot?.generatedAt ?? null; }
  hasLivePricing(): boolean { return this.prices.size > 0; }
}
