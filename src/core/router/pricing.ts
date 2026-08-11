// ─────────────────────────────────────────────
//  Cascade AI — Data-driven model pricing
// ─────────────────────────────────────────────
//
//  A flat `input/output per 1k tokens` pair cannot describe how models are
//  actually billed, and pretending otherwise is how an unpriced model ends up
//  looking free. Real pricing needs, at minimum:
//
//    · per-1M input + output rates (vendors publish per-million, not per-1k)
//    · cached input        — commonly 5–10× cheaper; dominates multi-turn cost
//    · reasoning/thinking  — billed as output but invisible in the response
//    · long-context tiers  — Gemini 3.1 Pro is $2/$12 per 1M up to 200K prompt
//                            tokens and $4/$18 above it; GPT-5.4/5.5 step at
//                            272K. One flat pair is wrong on both sides of that
//                            boundary.
//    · batch discount      — ~50% where offered
//    · non-token units     — image (per image), video (per second), TTS (per
//                            character), STT (per audio minute), embeddings
//                            (per token, input only)
//    · currency / asOf / source — prices move fast (Gemini 3.6 Flash landed
//                            2026-07-21 and cut output pricing ~17%)
//
//  Entries are keyed by MODEL × PROVIDER (× region), never by model alone: the
//  same weights cost different amounts on OpenAI vs Azure vs Vertex vs
//  OpenRouter, and Azure additionally varies by region. `baseModelId` (already
//  used for Azure deployments) generalises to any provider whose callable id
//  isn't the canonical model name.
//
//  The bundled dataset is the AUTHORITATIVE OFFLINE BASELINE. A live source may
//  override it when it is fresher (see live-data.ts) — but a disagreement is
//  recorded rather than silently swallowed, because a mismatch is the best
//  available signal that the dataset has gone stale.
//
//  The one thing this module will never do is invent a price. A model with no
//  entry is `unknown`, not $0 — see resolvePricing().

import type { ModelInfo, ProviderConfig, ProviderType } from '../../types.js';
import pricingData from './pricing-data.json' with { type: 'json' };

// ── Schema ────────────────────────────────────

/**
 * Providers a price can be attached to. A superset of Cascade's own
 * ProviderType: `vertex`, `bedrock` and `openrouter` are marketplaces that
 * resell the same models at their own rates, and are needed as *reference*
 * prices even where Cascade doesn't call them directly.
 */
export type PricingProvider =
  | ProviderType
  | 'vertex'
  | 'bedrock'
  | 'openrouter';

/** Billing unit for a non-token-metered modality. */
export type NonTokenUnit =
  | 'per_image'
  | 'per_second'
  | 'per_character'
  | 'per_audio_minute';

export type PricedModality =
  | 'text'
  | 'embedding'
  | 'image'
  | 'video'
  | 'speech'
  | 'transcription';

/** Where a number came from. Never fabricate — omit, or mark it. */
export type Provenance = 'vendor-pricing-page' | 'litellm-catalog' | 'seed-approximation';

/**
 * One context-length band. Bands are ordered cheapest-boundary-first; the last
 * band omits `maxInputTokens` and is unbounded. A single-band entry is a model
 * whose price does not vary with prompt length.
 */
export interface ContextTier {
  /** Inclusive upper bound, in PROMPT tokens, for which this band applies. */
  maxInputTokens?: number;
  inputPer1m: number;
  outputPer1m: number;
  /** Cache-hit read price. Absent ⇒ the vendor doesn't price cache reads separately. */
  cachedInputPer1m?: number;
  /** Cache-write price (Anthropic 5-minute writes, OpenAI explicit writes). */
  cacheWritePer1m?: number;
  /**
   * Reasoning / thinking tokens. Vendors bill these as output today, so this
   * normally equals `outputPer1m` — it is modelled separately because these
   * tokens never appear in the response text, which makes them the single
   * easiest line item to under-budget.
   */
  reasoningOutputPer1m?: number;
}

export interface NonTokenRate {
  unit: NonTokenUnit;
  amount: number;
  /** Which variant this rate covers, e.g. "1024x1024 standard". */
  variant?: string;
}

export interface ModelPricingEntry {
  model: string;
  provider: PricingProvider;
  /** Azure/Vertex region ('global' | 'us' | 'eu' | …). Absent ⇒ region-independent. */
  region?: string;
  aliases?: string[];
  modality: PricedModality;
  currency: string;
  /** ISO date the price was read from `source`. */
  asOf: string;
  source: string;
  provenance: Provenance;
  /** Token rates. Present for text/embedding entries. */
  tiers?: ContextTier[];
  /** Non-token rates. Present for image/video/speech/transcription entries. */
  rates?: NonTokenRate[];
  /** Multiplier applied to token rates in batch mode (0.5 = 50% off). */
  batchMultiplier?: number;
  contextWindow?: number;
  notes?: string;
}

export interface PricingDataset {
  schemaVersion: number;
  generatedAt: string;
  defaultCurrency: string;
  note: string;
  provenanceLegend: Record<string, string>;
  entries: ModelPricingEntry[];
}

const DATASET = pricingData as unknown as PricingDataset;

// ── Id normalisation ──────────────────────────

/**
 * Fold a callable model id onto the canonical key used in the dataset.
 *   "models/gemini-3.1-pro-preview"    → "gemini-3.1-pro"
 *   "google/gemini-3.6-flash"          → "gemini-3.6-flash"
 *   "claude-haiku-4-5-20251001"        → "claude-haiku-4-5"
 *   "gpt-4o-mini-2024-07-18"           → "gpt-4o-mini"
 *   "llama3.2:3b"                      → "llama3.2"
 */
export function normalizeForPricing(id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/^models\//, '');
  const slash = s.lastIndexOf('/');
  if (slash !== -1) s = s.slice(slash + 1);
  // Drop an Ollama tag or an "@version" suffix ("llama3.2:3b" → "llama3.2").
  // A scan, not `/[:@].*$/`: that pattern backtracks quadratically on an id
  // containing a newline, because `.` can't cross it and `$` can't match, so
  // the engine retries from every later ':'. Model ids are short enough that
  // this was never a live DoS, but a linear scan is both safe and clearer.
  const tag = s.search(/[:@]/);
  if (tag !== -1) s = s.slice(0, tag);
  s = s.replace(/-latest$/, '');
  s = s.replace(/-preview(?:-\d{2}-\d{2})?$/, '');
  s = s.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(/-preview$/, '');
  return s;
}

// ── Index ─────────────────────────────────────

function indexKey(model: string, provider: string, region?: string): string {
  return `${provider}|${normalizeForPricing(model)}|${region ?? ''}`;
}

const INDEX = new Map<string, ModelPricingEntry>();
for (const entry of DATASET.entries) {
  for (const name of [entry.model, ...(entry.aliases ?? [])]) {
    const withRegion = indexKey(name, entry.provider, entry.region);
    if (!INDEX.has(withRegion)) INDEX.set(withRegion, entry);
    // Also index region-less so a lookup without a region still resolves,
    // preferring the entry explicitly marked `global` where one exists.
    const bare = indexKey(name, entry.provider);
    const existing = INDEX.get(bare);
    if (!existing || (existing.region && existing.region !== 'global' && entry.region === 'global')) {
      INDEX.set(bare, entry);
    }
  }
}

export interface PricingLookupOptions {
  region?: string;
  /**
   * Canonical model this id stands for, when `id` isn't itself canonical
   * (Azure deployment names, custom aliases). Tried after the literal id.
   */
  baseModelId?: string;
  /**
   * Providers to fall back to when the requested provider has no entry, in
   * order. The match reports which provider actually answered, so callers can
   * label a cross-provider price as an estimate rather than a quote.
   */
  fallbackProviders?: PricingProvider[];
}

export interface PricingMatch {
  entry: ModelPricingEntry;
  /** The provider whose price sheet answered — may differ from the one asked for. */
  matchedProvider: PricingProvider;
  /** True when `matchedProvider` is not the provider that was requested. */
  viaFallback: boolean;
}

/** Look up the price sheet for a model on a specific provider. */
export function findPricing(
  modelId: string,
  provider: PricingProvider,
  opts: PricingLookupOptions = {},
): PricingMatch | null {
  const ids = [modelId, opts.baseModelId].filter((x): x is string => !!x);
  const providers: PricingProvider[] = [provider, ...(opts.fallbackProviders ?? [])];

  for (const p of providers) {
    for (const id of ids) {
      const hit =
        (opts.region ? INDEX.get(indexKey(id, p, opts.region)) : undefined) ??
        INDEX.get(indexKey(id, p));
      if (hit) return { entry: hit, matchedProvider: p, viaFallback: p !== provider };
    }
  }
  return null;
}

/**
 * True when this model's price depends on how large the input is.
 *
 * The stamped `inputCostPer1kTokens` on a ModelInfo is only ever the CHEAPEST
 * band — both the bundled catalogue and `withResolvedPricing` below resolve it
 * without an input size — so for a banded model that field cannot answer "what
 * will this call cost". Callers that know the size ask this first and go to the
 * dataset when it says yes.
 */
export function hasContextBands(
  model: Pick<ModelInfo, 'id' | 'provider' | 'isLocal' | 'baseModelId'>,
): boolean {
  if (model.isLocal) return false;
  const fallbackProviders: PricingProvider[] =
    model.provider === 'azure' ? ['openai'] : model.provider === 'gemini' ? ['vertex'] : [];
  const match = findPricing(model.id, model.provider as PricingProvider, {
    baseModelId: model.baseModelId,
    fallbackProviders,
  });
  return (match?.entry.tiers?.length ?? 0) > 1;
}

/** Every entry in the dataset — for `cascade models`, docs and tests. */
export function allPricingEntries(): readonly ModelPricingEntry[] {
  return DATASET.entries;
}

export function pricingDatasetMeta(): Pick<PricingDataset, 'schemaVersion' | 'generatedAt' | 'defaultCurrency'> {
  const { schemaVersion, generatedAt, defaultCurrency } = DATASET;
  return { schemaVersion, generatedAt, defaultCurrency };
}

// ── Tier selection ────────────────────────────

/**
 * Pick the context band that applies to a prompt of `inputTokens`. Bands are
 * evaluated in order, so the Gemini 200K boundary resolves as: 200_000 → the
 * $2/$12 band (inclusive), 200_001 → the $4/$18 band.
 */
export function tierFor(entry: ModelPricingEntry, inputTokens = 0): ContextTier | null {
  const tiers = entry.tiers;
  if (!tiers?.length) return null;
  for (const t of tiers) {
    if (t.maxInputTokens === undefined || inputTokens <= t.maxInputTokens) return t;
  }
  return tiers[tiers.length - 1] ?? null;
}

export interface TokenRatesPer1k {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  reasoningOutput?: number;
}

const PER_1M_TO_PER_1K = 1 / 1000;

/**
 * Convert a matched entry to the per-1k rates the rest of Cascade speaks,
 * picking the context band for `inputTokens` and applying the batch discount
 * when the call is a batch call.
 */
export function tokenRatesPer1k(
  entry: ModelPricingEntry,
  opts: { inputTokens?: number; batch?: boolean } = {},
): TokenRatesPer1k | null {
  const tier = tierFor(entry, opts.inputTokens ?? 0);
  if (!tier) return null;
  const mult = (opts.batch ? entry.batchMultiplier ?? 1 : 1) * PER_1M_TO_PER_1K;
  const out: TokenRatesPer1k = {
    input: tier.inputPer1m * mult,
    output: tier.outputPer1m * mult,
  };
  if (tier.cachedInputPer1m !== undefined) out.cachedInput = tier.cachedInputPer1m * mult;
  if (tier.cacheWritePer1m !== undefined) out.cacheWrite = tier.cacheWritePer1m * mult;
  if (tier.reasoningOutputPer1m !== undefined) out.reasoningOutput = tier.reasoningOutputPer1m * mult;
  return out;
}

// ── Local vs hosted ───────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** True when a URL points at this machine or a private/LAN address. */
export function isLoopbackOrPrivateHost(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(`[${host}]`)) return true;
    if (host.endsWith('.local')) return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve the local-vs-hosted toggle for a provider endpoint.
 *
 *   ollama            → local unless the user says otherwise (it is a local
 *                       runtime by definition, but it can be pointed at a
 *                       hosted box).
 *   openai-compatible → local when the baseUrl host is loopback/LAN
 *                       (llama.cpp, LM Studio, vLLM on your own machine),
 *                       hosted otherwise (Together, Groq, Fireworks, …).
 *   everything else   → hosted.
 *
 * An explicit `local` in the provider config always wins. "Local" means, and
 * only means, that inference genuinely costs $0 — it is what separates a real
 * zero from a missing price.
 */
export function isLocalEndpoint(cfg: Pick<ProviderConfig, 'type' | 'baseUrl' | 'local'>): boolean {
  if (typeof cfg.local === 'boolean') return cfg.local;
  if (cfg.type === 'ollama') return true;
  if (cfg.type === 'openai-compatible') return isLoopbackOrPrivateHost(cfg.baseUrl);
  return false;
}

// ── Resolution for a ModelInfo ────────────────

export interface ResolvedModelPricing {
  /** USD per 1k input tokens. 0 when the model is genuinely free OR unknown. */
  input: number;
  /** USD per 1k output tokens. */
  output: number;
  /**
   * True when we have NO price for this model. Callers must not read the 0s
   * above as "free" — report "cost not tracked" instead.
   */
  unknown: boolean;
  /** True when the model genuinely costs nothing (local / self-hosted). */
  free: boolean;
  entry?: ModelPricingEntry;
  /** Set when the price came from a different provider's sheet (an estimate). */
  estimatedFromProvider?: PricingProvider;
}

const UNKNOWN: ResolvedModelPricing = { input: 0, output: 0, unknown: true, free: false };
const FREE: ResolvedModelPricing = { input: 0, output: 0, unknown: false, free: true };

/**
 * Resolve per-1k pricing for a model from the dataset alone (no catalogue
 * fallback — utils/cost.ts layers that on). Local models are FREE; everything
 * else with no entry is UNKNOWN.
 */
export function resolvePricing(
  model: Pick<ModelInfo, 'id' | 'provider' | 'isLocal' | 'baseModelId'>,
  opts: { inputTokens?: number; region?: string; batch?: boolean } = {},
): ResolvedModelPricing {
  if (model.isLocal) return FREE;

  const fallbackProviders: PricingProvider[] =
    model.provider === 'azure' ? ['openai'] : model.provider === 'gemini' ? ['vertex'] : [];

  const match = findPricing(model.id, model.provider, {
    region: opts.region,
    baseModelId: model.baseModelId,
    fallbackProviders,
  });
  if (!match) return UNKNOWN;

  const rates = tokenRatesPer1k(match.entry, { inputTokens: opts.inputTokens, batch: opts.batch });
  if (!rates) return UNKNOWN;

  return {
    input: rates.input,
    output: rates.output,
    unknown: false,
    free: false,
    entry: match.entry,
    ...(match.viaFallback ? { estimatedFromProvider: match.matchedProvider } : {}),
  };
}

/**
 * Stamp resolved pricing onto a freshly-synthesised ModelInfo. This is the one
 * call every provider's `listModels()` must make for a model it discovered but
 * doesn't have hardcoded — it replaces the old `inputCostPer1kTokens: 0,
 * outputCostPer1kTokens: 0` stub that made unknown-priced models indistinguishable
 * from free ones.
 */
export function withResolvedPricing<T extends ModelInfo>(model: T, opts: { region?: string } = {}): T {
  const p = resolvePricing(model, opts);
  return {
    ...model,
    inputCostPer1kTokens: p.input,
    outputCostPer1kTokens: p.output,
    ...(p.unknown ? { pricingUnknown: true as const } : { pricingUnknown: false as const }),
  };
}

/**
 * The question every cost-sensitive code path actually wants answered: is this
 * model's $0 a real $0, or a missing number? Local models are genuinely free;
 * an unpriced cloud model is not.
 */
export function isPricingUnknown(model: Pick<ModelInfo, 'isLocal' | 'pricingUnknown'>): boolean {
  return model.pricingUnknown === true && !model.isLocal;
}

/**
 * Blended per-1k cost used by the value-based rankers: output tokens are the
 * expensive half, so they count double. An unknown-priced model returns the
 * "expensive" ceiling rather than 0 — otherwise a model with no price wins
 * every cost-efficiency comparison outright.
 */
export const BLENDED_COST_CEILING = 0.05;

export function blendedCostPer1k(model: ModelInfo): number {
  if (isPricingUnknown(model)) return BLENDED_COST_CEILING;
  return model.inputCostPer1kTokens + model.outputCostPer1kTokens * 2;
}

// ── Reconciliation with a live source ─────────

export interface PriceDisagreement {
  modelId: string;
  provider: string;
  /** Per-1k rates the bundled dataset asserts. */
  dataset: { input: number; output: number };
  /** Per-1k rates the live source asserts. */
  live: { input: number; output: number };
  /** live/dataset ratio on the blended rate; >1 means live is more expensive. */
  ratio: number;
  datasetAsOf: string;
  datasetSource: string;
}

/** Relative difference above which dataset vs live is worth surfacing. */
const DISAGREEMENT_THRESHOLD = 0.02;

/**
 * Reconcile the bundled baseline against a live quote for the same model.
 *
 * Policy: the live number WINS (it is fresher by construction), but a material
 * disagreement is returned so it can be logged. Neither source is trusted
 * blindly — a live quote of $0 for a non-local model is rejected outright,
 * because "free" is precisely the failure mode this whole change exists to
 * prevent, and a marketplace's free-tier alias must not silently zero out the
 * price of the paid model Cascade is actually calling.
 */
export function reconcilePrice(
  model: Pick<ModelInfo, 'id' | 'provider' | 'isLocal' | 'baseModelId'>,
  live: { input: number; output: number },
): { input: number; output: number; accepted: boolean; disagreement?: PriceDisagreement } {
  const baseline = resolvePricing(model);

  const liveIsZero = !(live.input > 0) && !(live.output > 0);
  if (liveIsZero && !model.isLocal) {
    return { input: baseline.input, output: baseline.output, accepted: false };
  }

  if (baseline.unknown || !baseline.entry) {
    return { input: live.input, output: live.output, accepted: true };
  }

  const dsBlend = baseline.input + baseline.output * 2;
  const liveBlend = live.input + live.output * 2;
  const ratio = dsBlend > 0 ? liveBlend / dsBlend : Number.POSITIVE_INFINITY;
  const material = dsBlend > 0 && Math.abs(ratio - 1) > DISAGREEMENT_THRESHOLD;

  return {
    input: live.input,
    output: live.output,
    accepted: true,
    ...(material
      ? {
          disagreement: {
            modelId: model.id,
            provider: model.provider,
            dataset: { input: baseline.input, output: baseline.output },
            live: { input: live.input, output: live.output },
            ratio: Math.round(ratio * 1000) / 1000,
            datasetAsOf: baseline.entry.asOf,
            datasetSource: baseline.entry.source,
          },
        }
      : {}),
  };
}
