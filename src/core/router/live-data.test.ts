// ─────────────────────────────────────────────
//  Cascade AI — Live data provider + 404 detection
// ─────────────────────────────────────────────

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LiveDataProvider, normalizeModelId } from './live-data.js';
import { isModelNotFoundError } from './index.js';
import { benchmarkScore01, setBenchmarkLiveProvider } from './benchmarks.js';
import { MODELS } from '../../constants.js';

const SNAPSHOT_URL_FRAGMENT = 'benchmark-data.json';
const OPENROUTER_FRAGMENT = 'openrouter.ai';

function snapshotResponse() {
  return {
    ok: true,
    json: async () => ({
      generatedAt: '2099-01-01T00:00:00.000Z',
      source: 'test',
      families: { 'claude-opus': { code: 99, analysis: 99, creative: 99, data: 99 } },
    }),
  };
}

function pricingResponse() {
  return {
    ok: true,
    json: async () => ({
      data: [
        {
          id: 'google/gemini-2.5-flash',
          pricing: { prompt: '0.0000003', completion: '0.0000025' },
          context_length: 1_048_576,
          supported_parameters: ['tools', 'temperature'],
          architecture: { input_modalities: ['text', 'image'] },
        },
        {
          id: 'openai/gpt-4o',
          pricing: { prompt: '0.0000025', completion: '0.00001' },
          context_length: 128_000,
          supported_parameters: ['temperature'], // no "tools" → supportsTools false
        },
      ],
    }),
  };
}

/** A fetch mock that answers by URL so snapshot + pricing are independent. */
function routedFetch(opts: { snapshot?: boolean; pricing?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes(SNAPSHOT_URL_FRAGMENT)) {
      if (opts.snapshot === false) throw new Error('offline');
      return snapshotResponse() as unknown as Response;
    }
    if (u.includes(OPENROUTER_FRAGMENT)) {
      if (opts.pricing === false) throw new Error('offline');
      return pricingResponse() as unknown as Response;
    }
    throw new Error(`unexpected url ${u}`);
  });
}

let cacheFile: string;

beforeEach(async () => {
  cacheFile = path.join(os.tmpdir(), `cascade-livedata-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  setBenchmarkLiveProvider(null);
  await fs.rm(cacheFile, { force: true });
});

describe('normalizeModelId', () => {
  it('strips vendor prefixes and date / preview suffixes', () => {
    expect(normalizeModelId('google/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('gemini-2.5-flash-preview-04-17')).toBe('gemini-2.5-flash');
    expect(normalizeModelId('llama3.2:3b')).toBe('llama3.2');
  });
});

describe('LiveDataProvider — live fetch', () => {
  it('fetches quality + pricing and reports source "live"', async () => {
    vi.stubGlobal('fetch', routedFetch());
    const ld = new LiveDataProvider({ cacheFile, refreshHours: 24 });
    await ld.refresh(true);

    expect(ld.getDataSource()).toBe('live');
    expect(ld.getQualityProfile('claude-opus')?.code).toBe(99);
    expect(ld.hasLivePricing()).toBe(true);

    // OpenRouter per-token strings convert to per-1k.
    const price = ld.getLivePrice('gemini-2.5-flash');
    expect(price?.input).toBeCloseTo(0.0003, 6);
    expect(price?.output).toBeCloseTo(0.0025, 6);
  });

  it('applies live pricing to a copy without mutating the shared catalog', async () => {
    vi.stubGlobal('fetch', routedFetch());
    const ld = new LiveDataProvider({ cacheFile });
    await ld.refresh(true);

    const original = MODELS['gemini-2.5-flash']!;
    const before = original.outputCostPer1kTokens;
    const [updated] = ld.applyLivePricing([original]);
    expect(updated!.outputCostPer1kTokens).toBeCloseTo(0.0025, 6);
    expect(original.outputCostPer1kTokens).toBe(before); // untouched
  });

  it('persists a cache that a fresh provider loads as source "cache"', async () => {
    vi.stubGlobal('fetch', routedFetch());
    await new LiveDataProvider({ cacheFile }).refresh(true);

    const reloaded = new LiveDataProvider({ cacheFile });
    await reloaded.load();
    expect(reloaded.getDataSource()).toBe('cache');
    expect(reloaded.getQualityProfile('claude-opus')?.code).toBe(99);
  });

  it('skips the network when the cache is still fresh', async () => {
    const fetch1 = routedFetch();
    vi.stubGlobal('fetch', fetch1);
    await new LiveDataProvider({ cacheFile, refreshHours: 24 }).refresh(true);
    const callsAfterSeed = fetch1.mock.calls.length;

    const fetch2 = routedFetch();
    vi.stubGlobal('fetch', fetch2);
    const ld = new LiveDataProvider({ cacheFile, refreshHours: 24 });
    await ld.refresh(); // not forced — cache is fresh
    expect(fetch2.mock.calls.length).toBe(0);
    expect(callsAfterSeed).toBeGreaterThan(0);
  });
});

describe('LiveDataProvider — capability facts (v0.15.0)', () => {
  it('captures context window, tool support, and modalities from the same catalog fetch', async () => {
    vi.stubGlobal('fetch', routedFetch());
    const ld = new LiveDataProvider({ cacheFile });
    await ld.refresh(true);

    expect(ld.hasCapabilities()).toBe(true);
    expect(ld.getCapability('gemini-2.5-flash')).toEqual({
      contextWindow: 1_048_576,
      supportsTools: true,
      inputModalities: ['text', 'image'],
    });
    expect(ld.getCapability('gpt-4o')?.supportsTools).toBe(false);
  });

  it('applyLiveCapabilities corrects copies without mutating the shared catalog', async () => {
    vi.stubGlobal('fetch', routedFetch());
    const ld = new LiveDataProvider({ cacheFile });
    await ld.refresh(true);

    const original = MODELS['gemini-2.5-flash']!;
    const beforeCtx = original.contextWindow;
    const [updated] = ld.applyLiveCapabilities([original]);
    expect(updated!.contextWindow).toBe(1_048_576);
    expect(updated!.supportsToolUse).toBe(true);
    expect(updated!.isVisionCapable).toBe(true);
    expect(original.contextWindow).toBe(beforeCtx); // untouched

    // Unknown model passes through as the SAME reference.
    const stranger = { ...original, id: 'totally-unknown-model' };
    expect(ld.applyLiveCapabilities([stranger])[0]).toBe(stranger);
  });

  it('capabilities persist in the disk cache and reload', async () => {
    vi.stubGlobal('fetch', routedFetch());
    await new LiveDataProvider({ cacheFile }).refresh(true);

    const reloaded = new LiveDataProvider({ cacheFile });
    await reloaded.load();
    expect(reloaded.hasCapabilities()).toBe(true);
    expect(reloaded.getCapability('gemini-2.5-flash')?.supportsTools).toBe(true);
  });
});

describe('LiveDataProvider — offline fallback', () => {
  it('keeps bundled source and null profiles when fetch fails', async () => {
    vi.stubGlobal('fetch', routedFetch({ snapshot: false, pricing: false }));
    const ld = new LiveDataProvider({ cacheFile });
    await ld.refresh(true); // must not throw

    expect(ld.getDataSource()).toBe('bundled');
    expect(ld.getQualityProfile('claude-opus')).toBeNull();
    expect(ld.hasLivePricing()).toBe(false);
    const original = MODELS['gpt-4o']!;
    expect(ld.applyLivePricing([original])[0]).toBe(original); // same ref, no price
  });
});

describe('benchmarkScore01 with a live provider', () => {
  it('prefers live scores over the bundled table, and falls back when unknown', async () => {
    vi.stubGlobal('fetch', routedFetch());
    const ld = new LiveDataProvider({ cacheFile });
    await ld.refresh(true);
    setBenchmarkLiveProvider(ld);

    // Live snapshot pushed claude-opus code to 99/100 → 0.99.
    expect(benchmarkScore01(MODELS['claude-opus-4']!, 'code')).toBeCloseTo(0.99, 5);
    // A family absent from the live snapshot falls back to the bundled table.
    expect(benchmarkScore01(MODELS['gpt-4o']!, 'code')).toBeGreaterThan(0.5);
  });
});

describe('isModelNotFoundError', () => {
  it('matches the Gemini 404 the user reported, verbatim', () => {
    const msg = 'models/gemini-2.5-flash-preview-04-17 is not found for API version v1beta, ' +
      'or is not supported for generateContent. Call ModelService.ListModels ... "status": "NOT_FOUND"';
    expect(isModelNotFoundError(msg)).toBe(true);
  });

  it('matches OpenAI / Anthropic equivalents', () => {
    expect(isModelNotFoundError('The model `gpt-foo` does not exist')).toBe(true);
    expect(isModelNotFoundError('404 model_not_found')).toBe(true);
    expect(isModelNotFoundError('unknown model: claude-x')).toBe(true);
  });

  it('does not misfire on ordinary errors', () => {
    expect(isModelNotFoundError('rate limit exceeded')).toBe(false);
    expect(isModelNotFoundError('connection reset by peer')).toBe(false);
  });
});
