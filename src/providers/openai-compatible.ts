// ─────────────────────────────────────────────
//  Cascade AI — OpenAI-Compatible Endpoint Provider
// ─────────────────────────────────────────────

import OpenAI from 'openai';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider } from './openai.js';
import { isChatModel } from './model-filter.js';
import { preferIpv4Host, nodeHttpFetch, type NodeHttpFetchOptions } from '../utils/net.js';
import { isLocalEndpoint, withResolvedPricing } from '../core/router/pricing.js';

export class OpenAICompatibleProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    // super() (OpenAIProvider) constructs its own `OpenAI` client from
    // `config.apiKey` directly. Most local servers (llama.cpp / LM Studio /
    // vLLM without --api-key) need no key, so `config.apiKey` is legitimately
    // undefined — but the `openai` SDK throws in its constructor whenever
    // `apiKey` is undefined AND `OPENAI_API_KEY` isn't set in the environment
    // (which it never is for a local endpoint), aborting construction before
    // this subclass's constructor body ever runs. Pass the same "not-required"
    // fallback used below so super() never sees an undefined key.
    super({ ...config, apiKey: config.apiKey ?? 'not-required' }, model);
    // Talk to the endpoint via Node's http stack (see net.ts) — the Electron
    // main process can't always reach loopback servers through global fetch.
    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'not-required',
      baseURL: preferIpv4Host(config.baseUrl),
      // Bound to the configured origin, NOT bare `nodeHttpFetch`. That helper
      // follows a 3xx by reusing `init` verbatim — headers included — so an
      // endpoint that redirected to another host was handed
      // `Authorization: Bearer <apiKey>` on the second one. This is the same
      // leak the Anthropic paths were fixed for; `allowedRedirectOrigin` exists
      // precisely for callers that attach a credential, and this one attaches
      // it on every request.
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        nodeHttpFetch(input, init ?? {}, 0, this.redirectPolicy())
      ) as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'],
    });
  }

  /**
   * Redirects may only stay on the host the credential was configured for.
   *
   * An unparseable `baseUrl` yields no policy, which is the pre-existing
   * behaviour — but such a config cannot address anything anyway, so the
   * request fails before a redirect is possible.
   */
  private redirectPolicy(): NodeHttpFetchOptions {
    try {
      return { allowedRedirectOrigin: new URL(preferIpv4Host(this.config.baseUrl) ?? '').origin };
    } catch {
      return {};
    }
  }

  private modelsUrl(): string {
    const base = (preferIpv4Host(this.config.baseUrl) ?? '').replace(/\/+$/, '');
    return base + '/models';
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await nodeHttpFetch(this.modelsUrl(), { headers: this.authHeaders() }, 0, this.redirectPolicy());
    if (!res.ok) throw new Error(`models endpoint ${this.modelsUrl()} returned HTTP ${res.status}`);
    const body = (await res.json()) as { data?: unknown[]; models?: unknown[] };
    const raw = Array.isArray(body?.data) ? body.data
      : (Array.isArray(body?.models) ? body.models : []);
    const ids = raw
      .map((m) => {
        if (m && typeof m === 'object') {
          const o = m as Record<string, unknown>;
          const v = o['id'] ?? o['name'] ?? o['model'];
          return typeof v === 'string' ? v : undefined;
        }
        return typeof m === 'string' ? m : undefined;
      })
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length === 0) return [this.model];
    // Drop obvious non-chat models (embedders, TTS, …). But don't wipe a custom
    // endpoint's list to empty if everything got filtered — fall back to the raw
    // ids so an unusually-named single-model server still works.
    const chatIds = ids.filter((id) => isChatModel(id));
    // An OpenAI-compatible endpoint is either your own hardware (llama.cpp, LM
    // Studio, vLLM — genuinely $0) or someone's paid API (Together, Groq,
    // Fireworks — definitely not). The default follows the baseUrl host and the
    // user can override it with `local` in the provider config. Getting this
    // wrong in the "hosted" direction is what silently reported real spend as
    // free, so an unpriced hosted model is marked unknown, not zero.
    const local = isLocalEndpoint(this.config);
    return (chatIds.length ? chatIds : ids).map((id) => withResolvedPricing({
      id,
      name: id,
      provider: 'openai-compatible' as const,
      contextWindow: 32_000,
      isVisionCapable: false,
      inputCostPer1kTokens: 0,
      outputCostPer1kTokens: 0,
      maxOutputTokens: 4_000,
      supportsStreaming: true,
      isLocal: local,
    }));
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await nodeHttpFetch(this.modelsUrl(), { headers: this.authHeaders() }, 0, this.redirectPolicy());
      return res.ok;
    } catch {
      return false;
    }
  }
}
