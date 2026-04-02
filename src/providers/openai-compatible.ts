// ─────────────────────────────────────────────
//  Cascade AI — OpenAI-Compatible Endpoint Provider
// ─────────────────────────────────────────────

import OpenAI from 'openai';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider } from './openai.js';

export class OpenAICompatibleProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    super(config, model);
    // Override client to use custom base URL
    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'not-required',
      baseURL: config.baseUrl,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list();
      return response.data.map((m) => ({
        id: m.id,
        name: m.id,
        provider: 'openai-compatible' as const,
        contextWindow: 32_000,
        isVisionCapable: false,
        inputCostPer1kTokens: 0,
        outputCostPer1kTokens: 0,
        maxOutputTokens: 4_000,
        supportsStreaming: true,
        isLocal: false,
      }));
    } catch {
      return [this.model];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
