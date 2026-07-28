import { describe, it, expect } from 'vitest';
import {
  allPricingEntries,
  blendedCostPer1k,
  findPricing,
  isLocalEndpoint,
  isLoopbackOrPrivateHost,
  isPricingUnknown,
  normalizeForPricing,
  reconcilePrice,
  resolvePricing,
  tierFor,
  tokenRatesPer1k,
  withResolvedPricing,
  BLENDED_COST_CEILING,
} from './pricing.js';
import { rankModels } from './model-ranker.js';
import { ModelPerformanceTracker } from './model-performance-tracker.js';
import type { ModelInfo } from '../../types.js';

const cloud = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: 'x',
  name: 'x',
  provider: 'openai',
  contextWindow: 200_000,
  isVisionCapable: false,
  inputCostPer1kTokens: 0,
  outputCostPer1kTokens: 0,
  maxOutputTokens: 4_000,
  supportsStreaming: true,
  isLocal: false,
  ...over,
});

// ─────────────────────────────────────────────
//  The dataset itself
// ─────────────────────────────────────────────

describe('pricing dataset integrity', () => {
  it('never records a $0 price — a missing price must be absent, not zero', () => {
    for (const e of allPricingEntries()) {
      for (const t of e.tiers ?? []) {
        expect(t.inputPer1m, `${e.provider}/${e.model}`).toBeGreaterThan(0);
        if (e.modality === 'text') expect(t.outputPer1m, `${e.provider}/${e.model}`).toBeGreaterThan(0);
      }
      for (const r of e.rates ?? []) {
        expect(r.amount, `${e.provider}/${e.model}`).toBeGreaterThan(0);
      }
    }
  });

  it('carries currency, asOf, source and provenance on every entry', () => {
    for (const e of allPricingEntries()) {
      expect(e.currency, e.model).toBeTruthy();
      expect(e.asOf, e.model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.source, e.model).toMatch(/^https?:\/\//);
      expect(['vendor-pricing-page', 'litellm-catalog', 'seed-approximation']).toContain(e.provenance);
    }
  });

  it('orders context tiers so the unbounded band comes last', () => {
    for (const e of allPricingEntries()) {
      const tiers = e.tiers ?? [];
      tiers.forEach((t, i) => {
        const isLast = i === tiers.length - 1;
        if (!isLast) expect(t.maxInputTokens, `${e.model} tier ${i}`).toBeGreaterThan(0);
        else expect(t.maxInputTokens, `${e.model} last tier`).toBeUndefined();
      });
    }
  });

  it('covers the non-token modalities Cascade is expanding into', () => {
    const modalities = new Set(allPricingEntries().map((e) => e.modality));
    for (const m of ['text', 'embedding', 'image', 'video', 'speech', 'transcription']) {
      expect(modalities).toContain(m);
    }
    const units = new Set(allPricingEntries().flatMap((e) => (e.rates ?? []).map((r) => r.unit)));
    expect(units).toEqual(new Set(['per_image', 'per_second', 'per_character', 'per_audio_minute']));
  });
});

// ─────────────────────────────────────────────
//  Context tiers — a flat input/output pair is not enough
// ─────────────────────────────────────────────

describe('context-tier price selection', () => {
  // https://cloud.google.com/vertex-ai/generative-ai/pricing — Gemini 3.1 Pro is
  // $2/$12 per 1M up to 200K prompt tokens and $4/$18 above it. A single flat
  // pair is wrong on one side of that boundary no matter which one it stores.
  const geminiPro = findPricing('gemini-3.1-pro-preview', 'gemini');

  it('resolves the Gemini preview id onto the canonical entry', () => {
    expect(geminiPro).not.toBeNull();
    expect(geminiPro!.entry.tiers).toHaveLength(2);
  });

  it('charges the cheap band at and below the 200K boundary', () => {
    const t = tierFor(geminiPro!.entry, 200_000)!;
    expect(t.inputPer1m).toBe(2);
    expect(t.outputPer1m).toBe(12);
  });

  it('steps up to the long-context band one token past the boundary', () => {
    const t = tierFor(geminiPro!.entry, 200_001)!;
    expect(t.inputPer1m).toBe(4);
    expect(t.outputPer1m).toBe(18);
  });

  it('doubles the effective per-1k input rate across the boundary', () => {
    const below = tokenRatesPer1k(geminiPro!.entry, { inputTokens: 199_000 })!;
    const above = tokenRatesPer1k(geminiPro!.entry, { inputTokens: 500_000 })!;
    expect(below.input).toBeCloseTo(0.002, 9);
    expect(above.input).toBeCloseTo(0.004, 9);
    expect(above.output / below.output).toBeCloseTo(1.5, 9);
  });

  it('prices cached input far below fresh input (multi-turn economics)', () => {
    const rates = tokenRatesPer1k(geminiPro!.entry, { inputTokens: 1_000 })!;
    expect(rates.cachedInput).toBeCloseTo(0.0002, 9);
    expect(rates.cachedInput! * 10).toBeCloseTo(rates.input, 9);
  });

  it('bills reasoning tokens at the output rate rather than dropping them', () => {
    const rates = tokenRatesPer1k(geminiPro!.entry, { inputTokens: 1_000 })!;
    expect(rates.reasoningOutput).toBe(rates.output);
  });

  it('applies the batch discount when asked for it', () => {
    const std = tokenRatesPer1k(geminiPro!.entry, { inputTokens: 1_000 })!;
    const batch = tokenRatesPer1k(geminiPro!.entry, { inputTokens: 1_000, batch: true })!;
    expect(batch.input).toBeCloseTo(std.input * 0.5, 9);
    expect(batch.output).toBeCloseTo(std.output * 0.5, 9);
  });

  it('handles OpenAI\'s 272K boundary too — the tiering is not Gemini-specific', () => {
    const gpt = findPricing('gpt-5.5', 'openai')!;
    expect(tierFor(gpt.entry, 272_000)!.inputPer1m).toBe(5);
    expect(tierFor(gpt.entry, 272_001)!.inputPer1m).toBe(10);
    expect(tierFor(gpt.entry, 272_001)!.outputPer1m).toBe(45);
  });
});

// ─────────────────────────────────────────────
//  Model x provider — the same weights, different money
// ─────────────────────────────────────────────

describe('per-provider price divergence for the same model', () => {
  it('prices gpt-4o-mini higher on Azure than on OpenAI', () => {
    const openai = tokenRatesPer1k(findPricing('gpt-4o-mini', 'openai')!.entry)!;
    const azure = tokenRatesPer1k(findPricing('gpt-4o-mini', 'azure')!.entry)!;
    expect(openai.input).toBeCloseTo(0.00015, 9);
    expect(azure.input).toBeCloseTo(0.000165, 9);
    expect(azure.output).toBeGreaterThan(openai.output);
  });

  it('varies Azure pricing by region for the same deployment', () => {
    const global = tokenRatesPer1k(findPricing('gpt-5.4', 'azure', { region: 'global' })!.entry)!;
    const eu = tokenRatesPer1k(findPricing('gpt-5.4', 'azure', { region: 'eu' })!.entry)!;
    expect(global.input).toBeCloseTo(0.0025, 9);
    expect(eu.input).toBeCloseTo(0.00275, 9);
    expect(eu.output).toBeGreaterThan(global.output);
  });

  it('prices gemini-2.0-flash differently on Vertex than on the Gemini API', () => {
    const dev = tokenRatesPer1k(findPricing('gemini-2.0-flash', 'gemini')!.entry)!;
    const vertex = tokenRatesPer1k(findPricing('gemini-2.0-flash', 'vertex')!.entry)!;
    expect(dev.input).toBeCloseTo(0.0001, 9);
    expect(vertex.input).toBeCloseTo(0.00015, 9);
  });

  it('resolves an Azure deployment name through baseModelId', () => {
    const p = resolvePricing(
      { id: 'prod-fast-eastus', provider: 'azure', isLocal: false, baseModelId: 'gpt-5.4' },
      { region: 'eu' },
    );
    expect(p.unknown).toBe(false);
    expect(p.input).toBeCloseTo(0.00275, 9);
  });

  it('does not silently answer an Azure lookup with the OpenAI sheet without saying so', () => {
    // gpt-4.1-mini has an OpenAI entry but no Azure one — the fallback answers,
    // and flags that the number is an estimate from another provider.
    const p = resolvePricing({ id: 'gpt-4.1-mini', provider: 'azure', isLocal: false });
    expect(p.unknown).toBe(false);
    expect(p.estimatedFromProvider).toBe('openai');
  });
});

// ─────────────────────────────────────────────
//  Unknown vs genuinely free — the zero-cost sentinel bug
// ─────────────────────────────────────────────

describe('unknown price is not a free price', () => {
  it('marks an unpriced cloud model unknown rather than $0', () => {
    const m = withResolvedPricing(cloud({ id: 'gemini-3-pro-flash', provider: 'gemini' }));
    expect(m.pricingUnknown).toBe(true);
    expect(isPricingUnknown(m)).toBe(true);
  });

  it('prices a model the dataset knows about', () => {
    const m = withResolvedPricing(cloud({ id: 'gpt-5.4', provider: 'openai' }));
    expect(m.pricingUnknown).toBe(false);
    expect(m.inputCostPer1kTokens).toBeCloseTo(0.0025, 9);
    expect(m.outputCostPer1kTokens).toBeCloseTo(0.015, 9);
  });

  it('keeps a genuinely local model at exactly $0 and NOT unknown', () => {
    const m = withResolvedPricing(cloud({ id: 'llama3:70b', provider: 'ollama', isLocal: true }));
    expect(m.inputCostPer1kTokens).toBe(0);
    expect(m.outputCostPer1kTokens).toBe(0);
    expect(m.pricingUnknown).toBe(false);
    expect(isPricingUnknown(m)).toBe(false);
  });

  it('scores an unknown-priced model as expensive, not as free, for value routing', () => {
    const unknown = withResolvedPricing(cloud({ id: 'mystery-preview', provider: 'openai' }));
    const local = withResolvedPricing(cloud({ id: 'llama3:70b', provider: 'ollama', isLocal: true }));
    expect(blendedCostPer1k(unknown)).toBe(BLENDED_COST_CEILING);
    expect(blendedCostPer1k(local)).toBe(0);
  });

  it('does not let an unknown-priced model win costEfficiencyScore', () => {
    const tracker = new ModelPerformanceTracker();
    const unknown = withResolvedPricing(cloud({ id: 'mystery-preview', provider: 'openai' }));
    const local = withResolvedPricing(cloud({ id: 'llama3:70b', provider: 'ollama', isLocal: true }));
    const cheap = withResolvedPricing(cloud({ id: 'gpt-5-nano', provider: 'openai' }));
    expect(tracker.costEfficiencyScore(unknown, 1)).toBeLessThan(tracker.costEfficiencyScore(cheap, 1));
    expect(tracker.costEfficiencyScore(unknown, 1)).toBeLessThan(tracker.costEfficiencyScore(local, 1));
    expect(tracker.costEfficiencyScore(local, 1)).toBe(1);
  });

  it('ranks a known-cheap model above an unknown-priced one at T3', () => {
    const specs = ['code'];
    const unknown = withResolvedPricing(
      cloud({ id: 'mystery-preview', provider: 'openai', specializations: specs }),
    );
    const cheap = withResolvedPricing(
      cloud({ id: 'gpt-5-nano', provider: 'openai', specializations: specs }),
    );
    const ranked = rankModels([unknown, cheap], {
      taskType: 'code',
      tier: 'T3',
      estimatedTokens: 1_000,
    });
    expect(ranked[0]!.id).toBe('gpt-5-nano');
  });

  it('ranks a genuinely-local model above an unknown-priced one at T3', () => {
    const specs = ['code'];
    const unknown = withResolvedPricing(
      cloud({ id: 'mystery-preview', provider: 'openai', specializations: specs }),
    );
    const local = withResolvedPricing(
      cloud({ id: 'llama3:70b', provider: 'ollama', isLocal: true, specializations: specs }),
    );
    const ranked = rankModels([unknown, local], {
      taskType: 'code',
      tier: 'T3',
      estimatedTokens: 1_000,
    });
    expect(ranked[0]!.id).toBe('llama3:70b');
  });
});

// ─────────────────────────────────────────────
//  Local-vs-hosted toggle
// ─────────────────────────────────────────────

describe('local vs hosted endpoint toggle', () => {
  it('treats ollama as local by default', () => {
    expect(isLocalEndpoint({ type: 'ollama' })).toBe(true);
    expect(isLocalEndpoint({ type: 'ollama', baseUrl: 'http://localhost:11434' })).toBe(true);
  });

  it('lets the user declare a rented ollama box as hosted', () => {
    expect(isLocalEndpoint({ type: 'ollama', baseUrl: 'https://ollama.example.com', local: false })).toBe(false);
  });

  it('defaults openai-compatible to local only for a loopback/LAN baseUrl', () => {
    expect(isLocalEndpoint({ type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' })).toBe(true);
    expect(isLocalEndpoint({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' })).toBe(true);
    expect(isLocalEndpoint({ type: 'openai-compatible', baseUrl: 'http://192.168.1.40:8000/v1' })).toBe(true);
    expect(isLocalEndpoint({ type: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1' })).toBe(false);
    expect(isLocalEndpoint({ type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' })).toBe(false);
  });

  it('lets an explicit setting override the baseUrl inference in both directions', () => {
    expect(isLocalEndpoint({ type: 'openai-compatible', baseUrl: 'https://gpu.mycorp.internal/v1', local: true })).toBe(true);
    expect(isLocalEndpoint({ type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', local: false })).toBe(false);
  });

  it('never treats a cloud provider as local', () => {
    expect(isLocalEndpoint({ type: 'openai' })).toBe(false);
    expect(isLocalEndpoint({ type: 'anthropic' })).toBe(false);
    expect(isLocalEndpoint({ type: 'gemini' })).toBe(false);
    expect(isLocalEndpoint({ type: 'azure' })).toBe(false);
  });

  it('recognises loopback and private hosts, and nothing else', () => {
    expect(isLoopbackOrPrivateHost('http://[::1]:8080')).toBe(true);
    expect(isLoopbackOrPrivateHost('http://gpu.local:8080')).toBe(true);
    expect(isLoopbackOrPrivateHost('http://172.16.5.1:8080')).toBe(true);
    expect(isLoopbackOrPrivateHost('http://172.32.5.1:8080')).toBe(false);
    expect(isLoopbackOrPrivateHost('not a url')).toBe(false);
    expect(isLoopbackOrPrivateHost(undefined)).toBe(false);
  });

  it('a hosted endpoint with no known price is unknown, not free', () => {
    const hosted = withResolvedPricing(
      cloud({ id: 'some-oss-70b', provider: 'openai-compatible', isLocal: false }),
    );
    expect(hosted.pricingUnknown).toBe(true);
    expect(isPricingUnknown(hosted)).toBe(true);

    const selfHosted = withResolvedPricing(
      cloud({ id: 'some-oss-70b', provider: 'openai-compatible', isLocal: true }),
    );
    expect(selfHosted.pricingUnknown).toBe(false);
    expect(selfHosted.inputCostPer1kTokens).toBe(0);
  });
});

// ─────────────────────────────────────────────
//  Reconciliation with the live source
// ─────────────────────────────────────────────

describe('dataset vs live reconciliation', () => {
  const gpt54 = cloud({ id: 'gpt-5.4', provider: 'openai' });

  it('prefers the live quote when it disagrees, and reports the disagreement', () => {
    const r = reconcilePrice(gpt54, { input: 0.003, output: 0.018 });
    expect(r.accepted).toBe(true);
    expect(r.input).toBe(0.003);
    expect(r.disagreement).toBeDefined();
    expect(r.disagreement!.dataset.input).toBeCloseTo(0.0025, 9);
    expect(r.disagreement!.ratio).toBeGreaterThan(1);
    expect(r.disagreement!.datasetSource).toMatch(/^https?:\/\//);
  });

  it('stays quiet when live and dataset agree', () => {
    const r = reconcilePrice(gpt54, { input: 0.0025, output: 0.015 });
    expect(r.accepted).toBe(true);
    expect(r.disagreement).toBeUndefined();
  });

  it('rejects a live $0 quote for a paid model rather than zeroing it out', () => {
    const r = reconcilePrice(gpt54, { input: 0, output: 0 });
    expect(r.accepted).toBe(false);
    expect(r.input).toBeCloseTo(0.0025, 9);
  });

  it('accepts a live quote for a model the dataset has never heard of', () => {
    const r = reconcilePrice(cloud({ id: 'brand-new-model', provider: 'openai' }), {
      input: 0.001,
      output: 0.004,
    });
    expect(r.accepted).toBe(true);
    expect(r.input).toBe(0.001);
    expect(r.disagreement).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
//  Id normalisation
// ─────────────────────────────────────────────

describe('model id normalisation', () => {
  it.each([
    ['models/gemini-3.1-pro-preview', 'gemini-3.1-pro'],
    ['google/gemini-3.6-flash', 'gemini-3.6-flash'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['gpt-4o-mini-2024-07-18', 'gpt-4o-mini'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['llama3.2:3b', 'llama3.2'],
    ['GPT-5.4', 'gpt-5.4'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeForPricing(input)).toBe(expected);
  });

  it('strips a tag suffix in linear time, even on a pathological id', () => {
    // The tag strip used to be /[:@].*$/, which backtracks quadratically when
    // the id holds a newline: `.` can't cross it, `$` can't match, so the
    // engine retries from every later ':'. Model ids come off a provider's
    // /models response, so the shape isn't ours to guarantee.
    const nasty = `${':'.repeat(60_000)}\n`;
    const started = Date.now();
    expect(normalizeForPricing(nasty)).toBe('');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('has no entry for gemini-3-pro-flash, which is not a real model', () => {
    // Pricing a model id that does not exist is exactly how the zero-cost path
    // fired: no catalogue hit, no live hit, $0 recorded, reported as free.
    expect(findPricing('gemini-3-pro-flash', 'gemini')).toBeNull();
    expect(resolvePricing(cloud({ id: 'gemini-3-pro-flash', provider: 'gemini' })).unknown).toBe(true);
  });
});
