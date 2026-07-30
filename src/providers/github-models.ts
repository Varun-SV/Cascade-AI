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
import type { GenerateOptions, GenerateResult, ModelInfo, ProviderConfig, StreamChunk } from '../types.js';
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
export const GITHUB_MODELS_MAX_OUTPUT_TOKENS = 4_000;

/**
 * GitHub also caps INPUT size per request, independent of the underlying
 * model's real window — documented and widely corroborated at 8,000 tokens
 * for common Free/Pro-tier models (e.g. gpt-4o-mini), regardless of that
 * model's real ~131K context. Every discovered model's advertised
 * `contextWindow` is capped to this, not the base model's, so
 * `CascadeRouter.getReferenceContextWindow()` (the budget extended-context
 * compaction reasons against) and `model-ranker.ts`'s
 * `contextWindow < estimatedTokens * 2` candidate filter both see what
 * GitHub will actually accept — otherwise a run compacted to fit a reported
 * 128K window reaches inference and is rejected outright instead of being
 * compacted correctly the first time.
 */
export const GITHUB_MODELS_MAX_INPUT_TOKENS = 8_000;

/** Context window assumed when the catalog entry doesn't state one. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Hard ceiling on catalog pages fetched — a malformed/cyclic Link header must never loop forever. */
const GITHUB_MODELS_MAX_CATALOG_PAGES = 20;

/**
 * Every catalog request carries the PAT — passed to nodeHttpFetch's
 * `allowedRedirectOrigin` so a 3xx response (from the initial request OR any
 * followed `Link` page) can never carry that header to a different origin.
 * nodeHttpFetch replays `init` (headers included) verbatim on a followed
 * redirect by default; without this, a malicious or misconfigured redirect —
 * including a same-origin-to-external-host or HTTPS→HTTP hop — would
 * silently exfiltrate the token.
 */
const GITHUB_MODELS_CATALOG_ORIGIN = new URL(GITHUB_MODELS_CATALOG_URL).origin;

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

/**
 * True when the entry POSITIVELY advertises function/tool calling under any of
 * the plausible field names (mirrors OpenRouter's `supported_parameters:
 * ['tools', ...]`, the shape already seen elsewhere in this codebase — see
 * live-data.test.ts's fixture — plus a `capabilities`-array variant matching
 * looksVisionCapable above). Absence is NOT evidence of absence: a catalog
 * entry with none of these fields set is treated as unsupported (see the
 * caller), not "supported" — the safe default when the real field name is
 * unconfirmed, since sending `tools` to a model that rejects it fails the
 * whole call, while wrongly assuming no support only costs the slower text-
 * tool fallback. `github-models.live.test.ts` surfaces the real field names
 * from an actual catalog response so this can be tightened with certainty.
 */
function looksToolCapable(o: Record<string, unknown>): boolean {
  const params = o['supported_parameters'];
  if (Array.isArray(params) && params.some((x) => typeof x === 'string' && /^tools?$|function.?call/i.test(x))) {
    return true;
  }
  for (const k of ['capabilities', 'supported_output_modalities']) {
    const v = o[k];
    if (Array.isArray(v) && v.some((x) => typeof x === 'string' && /tool|function.?call/i.test(x))) return true;
  }
  const caps = o['capabilities'];
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    const c = caps as Record<string, unknown>;
    if (c['function_calling'] === true || c['tool_calling'] === true || c['tools'] === true) return true;
  }
  return false;
}

/** Extracts the `rel="next"` URL from an RFC 5988 `Link` header, or null past the last page. */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1]!;
  }
  return null;
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
    // User-Agent is set explicitly too — the openai SDK's own HTTP client
    // already sends one by default, unlike nodeHttpFetch (see catalogHeaders),
    // but stating it here removes any dependence on that SDK-internal default.
    this.client = new OpenAI({
      apiKey: config.apiKey ?? '',
      baseURL: GITHUB_MODELS_INFERENCE_URL,
      defaultHeaders: { 'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION, 'User-Agent': 'Cascade-AI' },
    });
  }

  /**
   * `OpenAIProvider.generateStream()` builds its request budget as
   * `options.maxTokens ?? this.model.maxOutputTokens` — an explicit per-call
   * `maxTokens` (T1Administrator's final compilation asks for 8,000, well
   * above GitHub's real ~4K hard cap) wins outright and is sent unclamped.
   * GitHub then rejects the request instead of answering, so a run routed to
   * this provider for that step fails outright rather than getting a
   * (perfectly serviceable, just shorter) completion. Clamp here, once, right
   * before delegating to the inherited implementation, rather than teaching
   * every caller GitHub's specific cap.
   */
  override async generateStream(
    options: GenerateOptions,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<GenerateResult> {
    const clamped = options.maxTokens !== undefined && options.maxTokens > GITHUB_MODELS_MAX_OUTPUT_TOKENS
      ? { ...options, maxTokens: GITHUB_MODELS_MAX_OUTPUT_TOKENS }
      : options;
    return super.generateStream(clamped, onChunk);
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
      // GitHub's REST API rejects any request with no User-Agent — a plain 403
      // regardless of how valid the PAT is. nodeHttpFetch is a thin wrapper
      // over node:http/https, neither of which sets one the way a browser's
      // fetch or a full HTTP client library would, so this has to be explicit.
      'User-Agent': 'Cascade-AI',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    // Deliberately NOT OpenAIProvider.listModels() — that calls the OpenAI
    // SDK's client.models.list(), which is the wrong path off this base URL and
    // returns a different response shape. nodeHttpFetch is used the same way
    // azure/openai-compatible use it for their bespoke listing calls: for its
    // transparent gzip/redirect handling, not for the loopback reason.
    //
    // GitHub REST list endpoints are RFC 5988 paginated via a `Link` response
    // header — follow it like every other GitHub API caller does, rather than
    // assuming the whole catalog fits on one page. A response with no `Link`
    // header (the common case today, and every mocked test response) ends the
    // loop after exactly one request, so this is a no-op until the catalog
    // actually grows past a page.
    const raw: unknown[] = [];
    let url: string | null = GITHUB_MODELS_CATALOG_URL;
    let pages = 0;
    // Every page request carries the PAT via catalogHeaders() — a `Link`
    // header is server-supplied, and a next URL taken from it verbatim would
    // send that Authorization header wherever the header points. Track
    // visited URLs so a cyclic header stops on the SECOND sighting rather
    // than burning the full page cap on identical authenticated requests.
    const visited = new Set<string>();
    while (url && pages < GITHUB_MODELS_MAX_CATALOG_PAGES) {
      if (visited.has(url)) break;
      visited.add(url);

      const res = await nodeHttpFetch(url, { headers: this.catalogHeaders() }, 0, {
        allowedRedirectOrigin: GITHUB_MODELS_CATALOG_ORIGIN,
      });
      if (!res.ok) throw new Error(`GitHub Models catalog ${url} returned HTTP ${res.status}`);

      // A successfully-fetched body whose shape we didn't predict must never
      // throw out of here — an unusable listing degrades the provider to its
      // seed model, whereas an exception marks the whole provider unavailable.
      const body = (await res.json()) as unknown;
      const pageItems: unknown[] = Array.isArray(body) ? body
        : Array.isArray((body as { models?: unknown[] })?.models) ? (body as { models: unknown[] }).models
        : Array.isArray((body as { data?: unknown[] })?.data) ? (body as { data: unknown[] }).data
        : [];
      raw.push(...pageItems);

      // Unlike a parse-shape surprise above, a cross-origin `next` link is not
      // benign data to degrade gracefully around — it's the PAT being pointed
      // somewhere GitHub never sent it, and that must hard-fail loudly rather
      // than silently follow it. Resolved against the CURRENT page's URL per
      // RFC 3986 (a relative Link value is relative to the request it came
      // from), not the catalog root, so a same-origin relative next link
      // still works normally.
      const next = parseNextLink(res.headers.get('link'));
      if (next) {
        const resolved: URL = new URL(next, url);
        if (resolved.origin !== GITHUB_MODELS_CATALOG_ORIGIN) {
          throw new Error(`Refusing cross-origin GitHub Models pagination URL: ${resolved.origin}`);
        }
        url = resolved.href;
      } else {
        url = null;
      }
      pages++;
    }

    const entries = raw
      .map((m) => {
        if (typeof m === 'string') {
          return { id: m, name: m, contextWindow: DEFAULT_CONTEXT_WINDOW, vision: false, tools: false };
        }
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
          tools: looksToolCapable(o),
        };
      })
      .filter((e): e is { id: string; name: string; contextWindow: number; vision: boolean; tools: boolean } => e !== undefined);

    // Unlike openai-compatible's identical-looking fallback, `this.model` here
    // is never a model the user actually typed in — every production caller
    // (the router's synthesized seed, setup/REPL's "dummy" probe seed)
    // constructs this provider with a non-callable placeholder id. Returning
    // it as if it were a real catalog entry would let that placeholder get
    // cached, offered in a tier picker, or selected as a fallback, and the
    // eventual API call would 404 on a literal id like `"github-models"` or
    // `"dummy"` — a confusing failure with no diagnostic trail. An empty
    // catalog fetch means exactly that: nothing usable was discovered.
    if (entries.length === 0) return [];

    // The catalog carries embedders alongside chat models, so filter as every
    // other provider does. If that somehow empties the list the ids are shaped
    // in a way isChatModel doesn't understand, and returning nothing would be
    // worse than returning everything — same reasoning as openai-compatible.
    const chat = entries.filter((e) => isChatModel(e.id));

    return (chat.length ? chat : entries).map((e) => ({
      id: e.id,                 // full `owner/model` — what the API is addressed by
      name: e.name,
      provider: 'github-models' as const,
      // GitHub's real per-request input cap, not the base model's larger one
      // (see GITHUB_MODELS_MAX_INPUT_TOKENS above) — the same reasoning
      // already applied to maxOutputTokens below, for the input side.
      contextWindow: Math.min(e.contextWindow, GITHUB_MODELS_MAX_INPUT_TOKENS),
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
      // Not every catalog model supports function/tool calling — a hardcoded
      // `true` sent `tools` to models that reject the parameter outright and
      // never engaged t3-worker.ts's existing text-tool fallback (only an
      // explicit `false` does). See looksToolCapable's own comment for why
      // "not positively advertised" defaults to false rather than true here.
      supportsToolUse: e.tools,
      isLocal: false,
    }));
  }

  async isAvailable(): Promise<boolean> {
    // One catalog request answers both "is this reachable with this PAT" and
    // "what can it serve", which is the right trade when every request counts
    // against a ~10 RPM budget.
    try {
      const res = await nodeHttpFetch(GITHUB_MODELS_CATALOG_URL, { headers: this.catalogHeaders() }, 0, {
        allowedRedirectOrigin: GITHUB_MODELS_CATALOG_ORIGIN,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
