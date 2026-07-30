#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  Cascade AI — model pricing dataset refresher
// ─────────────────────────────────────────────────────────────────────────────
//
//  Regenerates src/core/router/pricing-data.json — the authoritative offline
//  baseline that core/router/pricing.ts reads. Run it whenever prices move
//  (which is often: Gemini 3.6 Flash landed 2026-07-21 and cut output pricing
//  ~17% overnight), and any time `cascade models` reports a dataset/live
//  disagreement.
//
//    node scripts/refresh-pricing.mjs
//
//  Two kinds of number live in here, and they are labelled as such in the
//  emitted `provenance` field:
//
//    vendor-pricing-page — read off the vendor's own published pricing page.
//      These are typed out below because the vendor pages are not machine
//      readable (and several refuse automated fetches outright). When you
//      change one, re-read the page and update `AS_OF`.
//
//    litellm-catalog — pulled live from BerriAI/litellm's
//      model_prices_and_context_window.json, which tracks vendor pricing pages
//      and cites the upstream URL per entry. Used for OpenAI and Azure, whose
//      own pricing pages return HTTP 403 to automated fetches.
//
//  There is deliberately no third kind. The script REFUSES to emit an entry
//  with a $0 or missing price — a model we cannot price must have no entry at
//  all, so that pricing.ts reports it as "unknown" rather than free. That
//  distinction is the entire point of the dataset; see the header of
//  src/core/router/pricing.ts.
//
//  Pure Node built-ins (global fetch on Node 18+); no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FETCH_TIMEOUT_MS = 30_000;

const OUT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'core',
  'router',
  'pricing-data.json',
);

async function loadLiteLLM() {
  // A local copy short-circuits the network (offline runs, CI replay).
  const override = process.env.LITELLM_CATALOG_FILE;
  if (override) return JSON.parse(fs.readFileSync(override, 'utf8'));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(LITELLM_URL, { signal: ac.signal });
    if (!resp.ok) throw new Error(`litellm catalog fetch returned HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

const L = await loadLiteLLM();

const AS_OF = '2026-07-27';
const M = 1_000_000;
const r = (n) => (n == null ? undefined : Math.round(n * M * 1e6) / 1e6); // per-token -> per-1M, 6dp

const LITELLM_SRC = LITELLM_URL;

/** Build a token-priced entry straight out of the litellm catalog. */
function fromLiteLLM(key, { model, provider, region, aliases, tierBoundary, notes, source, modality = 'text' }) {
  const e = L[key];
  if (!e) throw new Error(`litellm key missing: ${key}`);
  const base = {
    inputPer1m: r(e.input_cost_per_token),
    outputPer1m: r(e.output_cost_per_token),
  };
  if (e.cache_read_input_token_cost != null) base.cachedInputPer1m = r(e.cache_read_input_token_cost);
  if (e.cache_creation_input_token_cost != null) base.cacheWritePer1m = r(e.cache_creation_input_token_cost);
  if (e.output_cost_per_reasoning_token != null) base.reasoningOutputPer1m = r(e.output_cost_per_reasoning_token);

  const tiers = [];
  const hiIn = e[`input_cost_per_token_above_${tierBoundary}k_tokens`];
  if (tierBoundary && hiIn != null) {
    const hi = {
      inputPer1m: r(hiIn),
      outputPer1m: r(e[`output_cost_per_token_above_${tierBoundary}k_tokens`]),
    };
    const hiCache = e[`cache_read_input_token_cost_above_${tierBoundary}k_tokens`];
    if (hiCache != null) hi.cachedInputPer1m = r(hiCache);
    const hiWrite = e[`cache_creation_input_token_cost_above_${tierBoundary}k_tokens`];
    if (hiWrite != null) hi.cacheWritePer1m = r(hiWrite);
    if (base.reasoningOutputPer1m != null) hi.reasoningOutputPer1m = hi.outputPer1m;
    tiers.push({ maxInputTokens: tierBoundary * 1000, ...base }, hi);
  } else {
    tiers.push(base);
  }

  const out = {
    model,
    provider,
    ...(region ? { region } : {}),
    ...(aliases ? { aliases } : {}),
    modality,
    currency: 'USD',
    asOf: AS_OF,
    source: source ?? e.source ?? LITELLM_SRC,
    provenance: 'litellm-catalog',
    tiers,
  };
  if (e.input_cost_per_token_batches != null && e.input_cost_per_token > 0) {
    out.batchMultiplier =
      Math.round((e.input_cost_per_token_batches / e.input_cost_per_token) * 1000) / 1000;
  }
  if (e.max_input_tokens) out.contextWindow = e.max_input_tokens;
  if (notes) out.notes = notes;
  return out;
}

/** Build an entry from a vendor pricing page that was fetched directly. */
function vendor({ model, provider, region, aliases, source, tiers, batchMultiplier, notes, contextWindow, modality = 'text', rates }) {
  return {
    model,
    provider,
    ...(region ? { region } : {}),
    ...(aliases ? { aliases } : {}),
    modality,
    currency: 'USD',
    asOf: AS_OF,
    source,
    provenance: 'vendor-pricing-page',
    ...(tiers ? { tiers } : {}),
    ...(rates ? { rates } : {}),
    ...(batchMultiplier != null ? { batchMultiplier } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** Non-token (per image / second / character / audio minute) entry from litellm. */
function media(key, { model, provider, modality, rates, notes, source }) {
  const e = L[key];
  if (!e) throw new Error(`litellm key missing: ${key}`);
  return {
    model,
    provider,
    modality,
    currency: 'USD',
    asOf: AS_OF,
    source: source ?? e.source ?? LITELLM_SRC,
    provenance: 'litellm-catalog',
    rates,
    ...(notes ? { notes } : {}),
  };
}

const ANTHROPIC_SRC = 'https://platform.claude.com/docs/en/about-claude/pricing';
const VERTEX_SRC = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';

/** Anthropic: cache read = 0.1x input, 5-minute cache write = 1.25x input, batch = 0.5x. */
function anthropic(model, input, output, { aliases, notes, contextWindow, tiers } = {}) {
  return vendor({
    model,
    provider: 'anthropic',
    aliases,
    source: ANTHROPIC_SRC,
    contextWindow,
    tiers: tiers ?? [
      {
        inputPer1m: input,
        outputPer1m: output,
        cachedInputPer1m: Math.round(input * 0.1 * 1e6) / 1e6,
        cacheWritePer1m: Math.round(input * 1.25 * 1e6) / 1e6,
        reasoningOutputPer1m: output,
      },
    ],
    batchMultiplier: 0.5,
    notes,
  });
}

const entries = [
  // ── Anthropic (first-party Claude API) ───────────────────────────────────
  anthropic('claude-opus-5', 5, 25, { contextWindow: 1_000_000 }),
  anthropic('claude-opus-4-8', 5, 25, { contextWindow: 1_000_000 }),
  anthropic('claude-opus-4-7', 5, 25, { contextWindow: 1_000_000 }),
  anthropic('claude-opus-4-6', 5, 25, { contextWindow: 1_000_000 }),
  anthropic('claude-opus-4-5', 5, 25, { contextWindow: 200_000 }),
  anthropic('claude-opus-4-1', 15, 75, {
    contextWindow: 200_000,
    notes: 'Deprecated by Anthropic; priced for historical/cost-reporting accuracy.',
  }),
  anthropic('claude-opus-4', 15, 75, {
    contextWindow: 200_000,
    notes: 'Retired except on Google Cloud; priced for historical/cost-reporting accuracy.',
  }),
  anthropic('claude-sonnet-5', 2, 10, {
    contextWindow: 1_000_000,
    notes:
      'Introductory pricing through 2026-08-31. Standard pricing of $3/$15 per 1M takes effect 2026-09-01 — re-check this entry then.',
  }),
  anthropic('claude-sonnet-4-6', 3, 15, { contextWindow: 1_000_000 }),
  anthropic('claude-sonnet-4-5', 3, 15, {
    contextWindow: 200_000,
    tiers: [
      { maxInputTokens: 200_000, inputPer1m: 3, outputPer1m: 15, cachedInputPer1m: 0.3, cacheWritePer1m: 3.75, reasoningOutputPer1m: 15 },
      { inputPer1m: 6, outputPer1m: 22.5, cachedInputPer1m: 0.6, cacheWritePer1m: 7.5, reasoningOutputPer1m: 22.5 },
    ],
    notes:
      'Long-context (>200K) premium applies to the 1M-context beta. Base rates from the Anthropic pricing page; the >200K tier from the litellm catalog (Anthropic does not tabulate it on the pricing page).',
  }),
  anthropic('claude-sonnet-4', 3, 15, { contextWindow: 200_000 }),
  anthropic('claude-haiku-4-5', 1, 5, { contextWindow: 200_000 }),
  anthropic('claude-haiku-3-5', 0.8, 4, { contextWindow: 200_000 }),

  // ── OpenAI ───────────────────────────────────────────────────────────────
  // openai.com/api/pricing and platform.openai.com return HTTP 403 to this
  // agent, so every OpenAI row is sourced from the litellm catalog instead.
  fromLiteLLM('gpt-5.6-sol', { model: 'gpt-5.6-sol', provider: 'openai', aliases: ['gpt-5.6'], tierBoundary: 272 }),
  fromLiteLLM('gpt-5.6-terra', { model: 'gpt-5.6-terra', provider: 'openai', tierBoundary: 272 }),
  fromLiteLLM('gpt-5.6-luna', { model: 'gpt-5.6-luna', provider: 'openai', tierBoundary: 272 }),
  fromLiteLLM('gpt-5.5', { model: 'gpt-5.5', provider: 'openai', tierBoundary: 272 }),
  fromLiteLLM('gpt-5.4', { model: 'gpt-5.4', provider: 'openai', tierBoundary: 272 }),
  fromLiteLLM('gpt-5.4-mini', { model: 'gpt-5.4-mini', provider: 'openai' }),
  fromLiteLLM('gpt-5', { model: 'gpt-5', provider: 'openai' }),
  fromLiteLLM('gpt-5-mini', { model: 'gpt-5-mini', provider: 'openai' }),
  fromLiteLLM('gpt-5-nano', { model: 'gpt-5-nano', provider: 'openai' }),
  fromLiteLLM('gpt-4.1', { model: 'gpt-4.1', provider: 'openai' }),
  fromLiteLLM('gpt-4.1-mini', { model: 'gpt-4.1-mini', provider: 'openai' }),
  fromLiteLLM('gpt-4.1-nano', { model: 'gpt-4.1-nano', provider: 'openai' }),
  fromLiteLLM('gpt-4o', { model: 'gpt-4o', provider: 'openai' }),
  fromLiteLLM('gpt-4o-mini', { model: 'gpt-4o-mini', provider: 'openai' }),

  // ── Azure OpenAI — same models, different money, and it varies by region ──
  fromLiteLLM('azure/gpt-5.5', { model: 'gpt-5.5', provider: 'azure', region: 'global', tierBoundary: 272 }),
  fromLiteLLM('azure/us/gpt-5.5', { model: 'gpt-5.5', provider: 'azure', region: 'us', tierBoundary: 272 }),
  fromLiteLLM('azure/eu/gpt-5.5', { model: 'gpt-5.5', provider: 'azure', region: 'eu', tierBoundary: 272 }),
  fromLiteLLM('azure/gpt-5.4', { model: 'gpt-5.4', provider: 'azure', region: 'global', tierBoundary: 272 }),
  fromLiteLLM('azure/us/gpt-5.4', { model: 'gpt-5.4', provider: 'azure', region: 'us' }),
  fromLiteLLM('azure/eu/gpt-5.4', { model: 'gpt-5.4', provider: 'azure', region: 'eu' }),
  fromLiteLLM('azure/gpt-5.6-terra', { model: 'gpt-5.6-terra', provider: 'azure', region: 'global', tierBoundary: 272 }),
  fromLiteLLM('azure/eu/gpt-5.6-terra', { model: 'gpt-5.6-terra', provider: 'azure', region: 'eu', tierBoundary: 272 }),
  fromLiteLLM('azure/gpt-5', { model: 'gpt-5', provider: 'azure', region: 'global' }),
  fromLiteLLM('azure/gpt-5-mini', { model: 'gpt-5-mini', provider: 'azure', region: 'global' }),
  fromLiteLLM('azure/gpt-5-nano', { model: 'gpt-5-nano', provider: 'azure', region: 'global' }),
  fromLiteLLM('azure/gpt-4.1', { model: 'gpt-4.1', provider: 'azure', region: 'global' }),
  fromLiteLLM('azure/gpt-4o', { model: 'gpt-4o', provider: 'azure', region: 'global' }),
  fromLiteLLM('azure/gpt-4o-mini', {
    model: 'gpt-4o-mini',
    provider: 'azure',
    region: 'global',
    notes: 'Azure charges $0.165/$0.66 per 1M for gpt-4o-mini vs $0.15/$0.60 on OpenAI — same model, different price.',
  }),

  // ── Google Gemini (Gemini Developer API) ─────────────────────────────────
  vendor({
    model: 'gemini-3.1-pro',
    provider: 'gemini',
    aliases: ['gemini-3.1-pro-preview'],
    source: VERTEX_SRC,
    contextWindow: 1_048_576,
    tiers: [
      { maxInputTokens: 200_000, inputPer1m: 2, outputPer1m: 12, cachedInputPer1m: 0.2, reasoningOutputPer1m: 12 },
      { inputPer1m: 4, outputPer1m: 18, cachedInputPer1m: 0.4, reasoningOutputPer1m: 18 },
    ],
    batchMultiplier: 0.5,
    notes: 'Long-context tier: $2/$12 per 1M up to 200K prompt tokens, $4/$18 above it.',
  }),
  vendor({
    model: 'gemini-3-pro',
    provider: 'gemini',
    aliases: ['gemini-3-pro-preview'],
    source: VERTEX_SRC,
    contextWindow: 1_048_576,
    tiers: [
      { maxInputTokens: 200_000, inputPer1m: 2, outputPer1m: 12, cachedInputPer1m: 0.2, reasoningOutputPer1m: 12 },
      { inputPer1m: 4, outputPer1m: 18, cachedInputPer1m: 0.4, reasoningOutputPer1m: 18 },
    ],
    batchMultiplier: 0.5,
  }),
  vendor({
    model: 'gemini-3.6-flash',
    provider: 'gemini',
    source: VERTEX_SRC,
    contextWindow: 1_048_576,
    tiers: [{ inputPer1m: 1.5, outputPer1m: 7.5, cachedInputPer1m: 0.15, reasoningOutputPer1m: 7.5 }],
    batchMultiplier: 0.5,
    notes: 'Released 2026-07-21. Output pricing dropped ~17% from Gemini 3.5 Flash ($9.00 -> $7.50 per 1M); input unchanged.',
  }),
  vendor({
    model: 'gemini-3.5-flash',
    provider: 'gemini',
    source: VERTEX_SRC,
    contextWindow: 1_048_576,
    tiers: [{ inputPer1m: 1.5, outputPer1m: 9, cachedInputPer1m: 0.15, reasoningOutputPer1m: 9 }],
    batchMultiplier: 0.5,
  }),
  fromLiteLLM('gemini/gemini-3.5-flash-lite', { model: 'gemini-3.5-flash-lite', provider: 'gemini' }),
  fromLiteLLM('gemini/gemini-3.1-flash-lite', { model: 'gemini-3.1-flash-lite', provider: 'gemini' }),
  fromLiteLLM('gemini/gemini-3-flash-preview', { model: 'gemini-3-flash', provider: 'gemini', aliases: ['gemini-3-flash-preview'] }),
  fromLiteLLM('gemini/gemini-2.5-pro', { model: 'gemini-2.5-pro', provider: 'gemini', tierBoundary: 200 }),
  fromLiteLLM('gemini/gemini-2.5-flash', { model: 'gemini-2.5-flash', provider: 'gemini' }),
  fromLiteLLM('gemini/gemini-2.5-flash-lite', { model: 'gemini-2.5-flash-lite', provider: 'gemini' }),
  fromLiteLLM('gemini/gemini-2.0-flash', {
    model: 'gemini-2.0-flash',
    provider: 'gemini',
    notes: 'Gemini Developer API price. Vertex AI lists $0.15/$0.60 per 1M for the same model — see the vertex entry.',
  }),
  fromLiteLLM('gemini/gemini-2.0-flash-lite', { model: 'gemini-2.0-flash-lite', provider: 'gemini' }),

  // ── Google Gemini on Vertex AI — same models, different price sheet ──────
  vendor({
    model: 'gemini-2.0-flash',
    provider: 'vertex',
    source: VERTEX_SRC,
    tiers: [{ inputPer1m: 0.15, outputPer1m: 0.6 }],
    batchMultiplier: 0.5,
    notes: 'Vertex AI lists $0.15/$0.60 per 1M; the Gemini Developer API lists $0.10/$0.40 for the same model.',
  }),
  vendor({
    model: 'gemini-3.1-pro',
    provider: 'vertex',
    aliases: ['gemini-3.1-pro-preview'],
    source: VERTEX_SRC,
    contextWindow: 1_048_576,
    tiers: [
      { maxInputTokens: 200_000, inputPer1m: 2, outputPer1m: 12, cachedInputPer1m: 0.2, reasoningOutputPer1m: 12 },
      { inputPer1m: 4, outputPer1m: 18, cachedInputPer1m: 0.4, reasoningOutputPer1m: 18 },
    ],
    batchMultiplier: 0.5,
  }),
  vendor({
    model: 'gemini-3.6-flash',
    provider: 'vertex',
    source: VERTEX_SRC,
    contextWindow: 1_048_576,
    tiers: [{ inputPer1m: 1.5, outputPer1m: 7.5, cachedInputPer1m: 0.15, reasoningOutputPer1m: 7.5 }],
    batchMultiplier: 0.5,
  }),
  vendor({
    model: 'gemini-2.5-pro',
    provider: 'vertex',
    source: VERTEX_SRC,
    contextWindow: 1_048_576,
    tiers: [
      { maxInputTokens: 200_000, inputPer1m: 1.25, outputPer1m: 10, cachedInputPer1m: 0.13 },
      { inputPer1m: 2.5, outputPer1m: 15, cachedInputPer1m: 0.25 },
    ],
    batchMultiplier: 0.5,
  }),
  vendor({
    model: 'gemini-2.5-flash',
    provider: 'vertex',
    source: VERTEX_SRC,
    contextWindow: 1_048_576,
    tiers: [{ inputPer1m: 0.3, outputPer1m: 2.5, cachedInputPer1m: 0.03, reasoningOutputPer1m: 2.5 }],
    batchMultiplier: 0.5,
  }),

  // ── OpenRouter — a third price for the same weights ──────────────────────
  fromLiteLLM('openrouter/anthropic/claude-sonnet-4.6', { model: 'claude-sonnet-4-6', provider: 'openrouter', tierBoundary: 200 }),
  fromLiteLLM('openrouter/anthropic/claude-haiku-4.5', { model: 'claude-haiku-4-5', provider: 'openrouter' }),
  fromLiteLLM('openrouter/openai/gpt-5', { model: 'gpt-5', provider: 'openrouter' }),
  fromLiteLLM('openrouter/openai/gpt-5-mini', { model: 'gpt-5-mini', provider: 'openrouter' }),
  fromLiteLLM('openrouter/google/gemini-3.1-pro-preview', { model: 'gemini-3.1-pro', provider: 'openrouter', aliases: ['gemini-3.1-pro-preview'], tierBoundary: 200 }),

  // ── Embeddings (token-billed, input only) ───────────────────────────────
  fromLiteLLM('text-embedding-3-small', { model: 'text-embedding-3-small', provider: 'openai', modality: 'embedding' }),
  fromLiteLLM('text-embedding-3-large', { model: 'text-embedding-3-large', provider: 'openai', modality: 'embedding' }),
  fromLiteLLM('gemini/gemini-embedding-001', { model: 'gemini-embedding-001', provider: 'gemini', modality: 'embedding' }),

  // ── Non-token modalities ────────────────────────────────────────────────
  media('dall-e-3', {
    model: 'dall-e-3',
    provider: 'openai',
    modality: 'image',
    rates: [{ unit: 'per_image', amount: 0.04, variant: '1024x1024 standard' }],
  }),
  media('gemini/gemini-3-pro-image-preview', {
    model: 'gemini-3-pro-image',
    provider: 'gemini',
    modality: 'image',
    rates: [{ unit: 'per_image', amount: 0.134, variant: 'default output resolution' }],
    notes:
      'Google bills image output per output-token ($120 per 1M image output tokens); $0.134/image is that rate applied to one default-resolution image. Cost per image therefore varies with resolution.',
  }),
  media('gemini/gemini-2.5-flash-image', {
    model: 'gemini-2.5-flash-image',
    provider: 'gemini',
    modality: 'image',
    rates: [{ unit: 'per_image', amount: 0.039, variant: 'default 1024px output' }],
    notes:
      'Google bills image output per output-token ($30 per 1M image output tokens); a default 1024px image is 1290 output tokens, i.e. $0.039. Cost per image therefore varies with resolution.',
  }),
  media('vertex_ai/imagen-4.0-generate-001', {
    model: 'imagen-4.0-generate-001',
    provider: 'vertex',
    modality: 'image',
    rates: [{ unit: 'per_image', amount: 0.04 }],
  }),
  media('gemini/veo-3.1-generate-preview', {
    // `veo-3.1-generate-001` (no "-preview") is Vertex AI's id, not the Gemini
    // Developer API's — this entry feeds `registry.ts`'s gemini-provider
    // capability, which calls generativelanguage.googleapis.com and 404s on
    // the Vertex id. See src/core/multimodal/registry.ts.
    model: 'veo-3.1-generate-preview',
    provider: 'gemini',
    modality: 'video',
    rates: [{ unit: 'per_second', amount: 0.4 }],
  }),
  media('vertex_ai/veo-3.1-generate-001', {
    model: 'veo-3.1-generate-001',
    provider: 'vertex',
    modality: 'video',
    rates: [{ unit: 'per_second', amount: 0.4 }],
  }),
  media('tts-1', {
    model: 'tts-1',
    provider: 'openai',
    modality: 'speech',
    rates: [{ unit: 'per_character', amount: 0.000015 }],
    notes: '$15 per 1M characters.',
  }),
  media('tts-1-hd', {
    model: 'tts-1-hd',
    provider: 'openai',
    modality: 'speech',
    rates: [{ unit: 'per_character', amount: 0.00003 }],
    notes: '$30 per 1M characters.',
  }),
  {
    model: 'whisper-1',
    provider: 'openai',
    modality: 'transcription',
    currency: 'USD',
    asOf: AS_OF,
    source: LITELLM_SRC,
    provenance: 'litellm-catalog',
    rates: [{ unit: 'per_audio_minute', amount: 0.006 }],
    notes: 'litellm records $0.0001 per audio second; $0.006/minute is that rate x 60.',
  },
];

// Sanity: no entry may claim a $0 token price (that is exactly the bug this
// dataset exists to kill) and every entry must carry currency/asOf/source.
for (const e of entries) {
  if (!e.currency || !e.asOf || !e.source || !e.provenance) throw new Error(`incomplete provenance: ${e.model}`);
  for (const t of e.tiers ?? []) {
    if (!(t.inputPer1m > 0)) throw new Error(`zero input price: ${e.provider}/${e.model}`);
    if (e.modality === 'text' && !(t.outputPer1m > 0)) throw new Error(`zero output price: ${e.provider}/${e.model}`);
  }
  for (const rate of e.rates ?? []) {
    if (!(rate.amount > 0)) throw new Error(`zero rate: ${e.provider}/${e.model}`);
  }
}

const doc = {
  schemaVersion: 1,
  generatedAt: AS_OF,
  defaultCurrency: 'USD',
  note:
    'Authoritative offline baseline for model pricing, keyed by model x provider (x region). ' +
    'All token rates are per 1,000,000 tokens in the entry currency. A live source (see live-data.ts) ' +
    'may override an entry when it is fresher; disagreements are recorded rather than silently accepted. ' +
    'Every entry must carry currency, asOf, source and provenance — a model with NO entry is priced ' +
    '"unknown", never $0. Regenerate with scripts/refresh-pricing.mjs.',
  provenanceLegend: {
    'vendor-pricing-page': 'Read directly from the vendor\'s own published pricing page (see `source`).',
    'litellm-catalog':
      'From BerriAI/litellm model_prices_and_context_window.json, which cites the vendor page per entry. Used where the vendor page refused automated access.',
    'seed-approximation':
      'NOT sourced — an approximation. No entry in this file currently uses this value; it exists so an approximation can never masquerade as a measured price.',
  },
  entries,
};

fs.writeFileSync(OUT_FILE, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${entries.length} pricing entries to ${path.relative(process.cwd(), OUT_FILE)}`);
