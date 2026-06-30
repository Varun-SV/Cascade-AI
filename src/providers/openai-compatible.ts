// ─────────────────────────────────────────────
//  Cascade AI — OpenAI-Compatible Endpoint Provider
// ─────────────────────────────────────────────

import OpenAI from 'openai';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider } from './openai.js';
import { preferIpv4Host, nodeHttpFetch } from '../utils/net.js';

export class OpenAICompatibleProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    // Talk to the endpoint via Node's http stack (see net.ts) — the Electron
    // main process can't always reach loopback servers through global fetch.
    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'not-required',
      baseURL: preferIpv4Host(config.baseUrl),
      fetch: nodeHttpFetch as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'],
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

  async listModels(): Promise<ModelInfo[]> {
    const res = await nodeHttpFetch(this.modelsUrl(), { headers: this.authHeaders() });
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
      const res = await nodeHttpFetch(this.modelsUrl(), { headers: this.authHeaders() });
      return res.ok;
    } catch {
      return false;
    }
  }
}
