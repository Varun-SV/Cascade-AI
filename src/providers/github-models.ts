// ─────────────────────────────────────────────
//  Cascade AI — GitHub Models Provider
// ─────────────────────────────────────────────
//
//  GitHub Models (models.github.ai) is NOT GitHub Copilot the coding agent —
//  it's a separate, publicly documented inference product that serves a
//  multi-vendor catalog (OpenAI, Meta, DeepSeek, Mistral, …) over an
//  OpenAI-compatible chat-completions API, authenticated with the user's own
//  fine-grained PAT carrying the `models: read` scope. Strictly BYOK: quota is
//  tied to the individual's GitHub/Copilot tier (Free ≈10 RPM, Pro ≈20 RPM,
//  low daily caps, ~4K max output tokens), so it is sized for prototyping and
//  a pooled/shared key would be exhausted by one user's afternoon.

import OpenAI from 'openai';
import type { ModelInfo, ProviderConfig } from '../types.js';
import {
  GITHUB_MODELS_API_VERSION,
  GITHUB_MODELS_CATALOG_URL,
  GITHUB_MODELS_INFERENCE_URL,
} from '../constants.js';
import { OpenAIProvider, isReasoningModel } from './openai.js';
import { isChatModel } from './model-filter.js';
import { nodeHttpFetch } from '../utils/net.js';

/**
 * GitHub caps a single response far below what the underlying weights allow —
 * a `gpt-4o` served here will not return the 16K tokens it would on OpenAI.
 * Every discovered model therefore reports GitHub's cap, not the base model's,
 * which keeps `maxOutputTokens` honest for callers AND makes the router's
 * TPM reservation (see DEFAULT_PROVIDER_TPM in core/router/tpm-limiter.ts,
 * which budgets off exactly this number) reflect the real per-call ceiling.
 */
const GITHUB_MODELS_MAX_OUTPUT_TOKENS = 4_000;

/** Context window assumed when the catalog entry doesn't state one. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Catalog ids are owner-prefixed (`openai/gpt-4o`, `meta/Llama-3.3-70B-Instruct`,
 * `deepseek/DeepSeek-R1`). Returns just the model part — used ONLY for name-shape
 * heuristics like reasoning-family detection, never for anything that goes on the
 * wire: the catalog and the inference endpoint both address the full form.
 */
export function stripModelOwnerPrefix(id: string): string {
  const slash = (id || '').indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

/** First usable string among the given keys of an arbitrary catalog record. */
function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** First positive number among the given keys, following one level of nesting. */
function pickNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = k.includes('.')
      ? (o[k.split('.')[0]!] as Record<string, unknown> | undefined)?.[k.split('.')[1]!]
      : o[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/** True when the entry advertises image input under any of the plausible field names. */
function looksVisionCapable(o: Record<string, unknown>): boolean {
  for (const k of ['supported_input_modalities', 'input_modalities', 'modalities', 'capabilities']) {
    const v = o[k];
    if (Array.isArray(v) && v.some((x) => typeof x === 'string' && /image|vision/i.test(x))) return true;
  }
  return false;
}

export class GitHubModelsProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    // The `openai` SDK throws inside its own constructor when apiKey is
    // undefined and OPENAI_API_KEY isn't set — that would abort super() before
    // this body runs, and the message it raises names the wrong env var
    // entirely for this provider. Pass an empty string so construction always
    // completes and the real, self-explanatory 401 from GitHub surfaces at
    // request time instead. Empty (not undefined) also stops the SDK silently
    // adopting a stray OPENAI_API_KEY and sending an OpenAI key to GitHub.
    super({ ...config, apiKey: config.apiKey ?? '' }, model);

    // OpenAIProvider's constructor already ran `isReasoningModel(model.id)` —
    // but that regex is anchored to the start of the string (`^o[1345]`), and
    // the catalog's owner prefix pushes the family name off position 0, so
    // `openai/o3-mini` does not match and the model is treated as a classic
    // one. Redo the decision against the bare model name. Without this, the
    // first o-series call goes out with `max_tokens`, is rejected, and only
    // self-corrects through generateStream()'s retry-on-param-shape-error
    // path — one wasted request per process, out of a ~10 RPM budget.
    this.useMaxCompletionTokens = isReasoningModel(stripModelOwnerPrefix(model.id));

    // Fixed endpoint — `config.baseUrl` is intentionally unused (and stays
    // undefined) for this provider, unlike azure/openai-compatible where the
    // endpoint IS the thing the user configures. `nodeHttpFetch` is likewise
    // not wired in here: it exists for Electron's main process failing to
    // reach LOOPBACK servers, and models.github.ai is a public HTTPS host in
    // the same category as anthropic/gemini, neither of which override fetch.
    // The API-version header rides on every request including chat
    // completions; it is required by the catalog and harmless on inference.
    this.client = new OpenAI({
      apiKey: config.apiKey ?? '',
      baseURL: GITHUB_MODELS_INFERENCE_URL,
      defaultHeaders: { 'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION },
    });
  }

  /**
   * The catalog is a GitHub REST resource, not an OpenAI `/models` list, and
   * wants GitHub's own header trio — the plain `Accept: application/json` the
   * openai-compatible provider sends is not the same request.
   */
  private catalogHeaders(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.config.apiKey ?? ''}`,
      'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    // Deliberately NOT OpenAIProvider.listModels() — that calls the OpenAI
    // SDK's client.models.list(), which is the wrong path off this base URL and
    // returns a different response shape. nodeHttpFetch is used the same way
    // azure/openai-compatible use it for their bespoke listing calls: for its
    // transparent gzip/redirect handling, not for the loopback reason.
    const res = await nodeHttpFetch(GITHUB_MODELS_CATALOG_URL, { headers: this.catalogHeaders() });
    if (!res.ok) throw new Error(`GitHub Models catalog ${GITHUB_MODELS_CATALOG_URL} returned HTTP ${res.status}`);

    // A successfully-fetched body whose shape we didn't predict must never
    // throw out of here — an unusable listing degrades the provider to its
    // seed model, whereas an exception marks the whole provider unavailable.
    const body = (await res.json()) as unknown;
    const raw: unknown[] = Array.isArray(body) ? body
      : Array.isArray((body as { models?: unknown[] })?.models) ? (body as { models: unknown[] }).models
      : Array.isArray((body as { data?: unknown[] })?.data) ? (body as { data: unknown[] }).data
      : [];

    const entries = raw
      .map((m) => {
        if (typeof m === 'string') return { id: m, name: m, contextWindow: DEFAULT_CONTEXT_WINDOW, vision: false };
        if (!m || typeof m !== 'object') return undefined;
        const o = m as Record<string, unknown>;
        const id = pickString(o, ['id', 'name', 'model']);
        if (!id) return undefined;
        return {
          id,
          name: pickString(o, ['friendly_name', 'display_name', 'name']) ?? id,
          contextWindow: pickNumber(o, [
            'context_window', 'context_length', 'max_input_tokens',
            'limits.max_input_tokens', 'limits.max_context_tokens',
          ]) ?? DEFAULT_CONTEXT_WINDOW,
          vision: looksVisionCapable(o),
        };
      })
      .filter((e): e is { id: string; name: string; contextWindow: number; vision: boolean } => e !== undefined);

    if (entries.length === 0) return [this.model];

    // The catalog carries embedders alongside chat models, so filter as every
    // other provider does. If that somehow empties the list the ids are shaped
    // in a way isChatModel doesn't understand, and returning nothing would be
    // worse than returning everything — same reasoning as openai-compatible.
    const chat = entries.filter((e) => isChatModel(e.id));

    return (chat.length ? chat : entries).map((e) => ({
      id: e.id,                 // full `owner/model` — what the API is addressed by
      name: e.name,
      provider: 'github-models' as const,
      contextWindow: e.contextWindow,
      isVisionCapable: e.vision,
      // A REAL $0, not a missing number — usage is bundled into the quota of
      // the plan the PAT belongs to and is never billed per token, so
      // `pricingUnknown: false` is the honest value (see the flag's contract in
      // core/router/pricing.ts: 0 alone is ambiguous). Set here rather than in
      // pricing-data.json because resolvePricing() matches exactly on
      // provider|model|region with no wildcard: every catalog model would need
      // a hand-curated row, and the next one GitHub adds would read as "cost
      // unknown" — an inconsistent picture for a billing reality that is
      // identical across the entire catalog.
      //
      // `isLocal` is the OTHER way to reach a real $0, and it is the wrong one:
      // it means "runs on this machine" and carries consequences that are
      // simply false for a hosted API — the shared concurrency-1
      // LocalRequestQueue (serialising these calls behind actual Ollama GPU
      // inference), the 300s local rather than 120s cloud inference timeout,
      // and a literal "[local]" tag in `cascade models`.
      inputCostPer1kTokens: 0,
      outputCostPer1kTokens: 0,
      pricingUnknown: false,
      maxOutputTokens: GITHUB_MODELS_MAX_OUTPUT_TOKENS,
      supportsStreaming: true,
      supportsToolUse: true,
      isLocal: false,
    }));
  }

  async isAvailable(): Promise<boolean> {
    // One catalog request answers both "is this reachable with this PAT" and
    // "what can it serve", which is the right trade when every request counts
    // against a ~10 RPM budget.
    try {
      const res = await nodeHttpFetch(GITHUB_MODELS_CATALOG_URL, { headers: this.catalogHeaders() });
      return res.ok;
    } catch {
      return false;
    }
  }
}
