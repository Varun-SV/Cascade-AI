// ─────────────────────────────────────────────
//  Cascade AI — OpenAI-Compatible Endpoint Provider
// ─────────────────────────────────────────────

import OpenAI from 'openai';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider } from './openai.js';
import { preferIpv4Host } from '../utils/net.js';

export class OpenAICompatibleProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    // Override client to use the custom base URL (forced to IPv4 — see net.ts).
    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'not-required',
      baseURL: preferIpv4Host(config.baseUrl),
    });
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

  // Discover models with a tolerant direct GET instead of the OpenAI SDK's typed
  // `models.list()`. Local servers (llama.cpp / LM Studio / vLLM) return
  // non-standard `/v1/models` payloads — an extra `models` array, filesystem
  // path ids (`C:\…\model.gguf`) — that can make the SDK's typed pagination
  // throw, which previously surfaced as a misleading "endpoint unreachable".
  // A plain fetch + lenient parse is robust and reports the real HTTP error.
  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(this.modelsUrl(), { headers: this.authHeaders() });
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
    return ids.map((id) => ({
      id,
      name: id,
      provider: 'openai-compatible' as const,
      contextWindow: 32_000,
      isVisionCapable: false,
      inputCostPer1kTokens: 0,
      outputCostPer1kTokens: 0,
      maxOutputTokens: 4_000,
      supportsStreaming: true,
      isLocal: false,
    }));
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(this.modelsUrl(), { headers: this.authHeaders() });
      return res.ok;
    } catch {
      return false;
    }
  }
}
