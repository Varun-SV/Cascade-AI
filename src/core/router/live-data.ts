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

/**
 * Per-model capability facts from the same OpenRouter catalog the pricing fetch
 * already downloads: context window, native tool support, and input modalities.
 * Previously discarded — provider listModels() stubs guessed/hardcoded these.
 */
export interface CapabilityEntry {
  contextWindow?: number;
  supportsTools?: boolean;
  inputModalities?: string[];
}

interface DiskCache {
  fetchedAt: number;
  snapshot?: BenchmarkSnapshot;
  prices?: Record<string, PriceEntry>;
  capabilities?: Record<string, CapabilityEntry>;
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
  private capabilities = new Map<string, CapabilityEntry>();
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
      if (cache.capabilities) {
        for (const [id, c] of Object.entries(cache.capabilities)) this.capabilities.set(id, c);
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

    const [snap, catalog] = await Promise.all([
      this.opts.live ? this.fetchSnapshot() : Promise.resolve(null),
      this.opts.pricingLive ? this.fetchCatalog() : Promise.resolve(null),
    ]);

    let changed = false;
    if (snap) { this.snapshot = snap; this.source = 'live'; changed = true; }
    if (catalog && catalog.prices.size > 0) { this.prices = catalog.prices; changed = true; }
    if (catalog && catalog.capabilities.size > 0) { this.capabilities = catalog.capabilities; changed = true; }
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

  /**
   * One fetch of the OpenRouter catalog yields BOTH pricing and capability
   * facts (context window, native tool support, input modalities) — the
   * capability fields used to be discarded while providers guessed/hardcoded
   * them in their listModels() stubs.
   */
  private async fetchCatalog(): Promise<{ prices: Map<string, PriceEntry>; capabilities: Map<string, CapabilityEntry> } | null> {
    try {
      const resp = await withTimeout(fetch(OPENROUTER_MODELS_URL), FETCH_TIMEOUT_MS, 'pricing fetch timed out');
      if (!resp.ok) return null;
      const data = await resp.json() as {
        data?: Array<{
          id?: string;
          pricing?: { prompt?: string; completion?: string };
          context_length?: number;
          supported_parameters?: string[];
          architecture?: { input_modalities?: string[] };
        }>;
      };
      if (!Array.isArray(data?.data)) return null;
      const prices = new Map<string, PriceEntry>();
      const capabilities = new Map<string, CapabilityEntry>();
      for (const m of data.data) {
        if (!m?.id) continue;
        const key = normalizeModelId(m.id);
        if (m.pricing) {
          // OpenRouter prices are per-token USD strings; convert to per-1k.
          const input = Number(m.pricing.prompt) * 1000;
          const output = Number(m.pricing.completion) * 1000;
          if (Number.isFinite(input) && Number.isFinite(output)) {
            prices.set(key, { input, output });
          }
        }
        const cap: CapabilityEntry = {};
        if (typeof m.context_length === 'number' && m.context_length > 0) {
          cap.contextWindow = m.context_length;
        }
        if (Array.isArray(m.supported_parameters)) {
          cap.supportsTools = m.supported_parameters.includes('tools');
        }
        if (Array.isArray(m.architecture?.input_modalities)) {
          cap.inputModalities = m.architecture.input_modalities;
        }
        if (Object.keys(cap).length > 0) capabilities.set(key, cap);
      }
      return { prices, capabilities };
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
        capabilities: Object.fromEntries(this.capabilities),
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

  /** Current capability facts for a model id, or null when unknown. */
  getCapability(modelId: string): CapabilityEntry | null {
    return this.capabilities.get(normalizeModelId(modelId)) ?? null;
  }

  /**
   * Returns capability-corrected copies of each model (originals untouched):
   * real context windows replace the providers' hardcoded guesses, native
   * tool support replaces the assume-by-provider default, and vision is set
   * from the declared input modalities.
   */
  applyLiveCapabilities(models: ModelInfo[]): ModelInfo[] {
    return models.map((m) => {
      const c = this.getCapability(m.id);
      if (!c) return m;
      const next = { ...m };
      if (c.contextWindow) next.contextWindow = c.contextWindow;
      if (c.supportsTools !== undefined) next.supportsToolUse = c.supportsTools;
      if (c.inputModalities) next.isVisionCapable = c.inputModalities.includes('image');
      return next;
    });
  }

  /** Where the active quality data came from — for /why and `cascade models`. */
  getDataSource(): DataSource { return this.source; }
  getGeneratedAt(): string | null { return this.snapshot?.generatedAt ?? null; }
  hasLivePricing(): boolean { return this.prices.size > 0; }
  hasCapabilities(): boolean { return this.capabilities.size > 0; }
}
