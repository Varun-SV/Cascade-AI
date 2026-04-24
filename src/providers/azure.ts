// ─────────────────────────────────────────────
//  Cascade AI — Azure OpenAI Provider
// ─────────────────────────────────────────────

import { AzureOpenAI } from 'openai';
import { AZURE_BASE_URL_TEMPLATE } from '../constants.js';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider } from './openai.js';

export class AzureOpenAIProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    const rawUrl = config.baseUrl ?? AZURE_BASE_URL_TEMPLATE.replace('{resource}', 'YOUR_RESOURCE');
    const endpoint = rawUrl.replace(/\/+$/, ''); // Strip trailing slashes
    super(
      {
        ...config,
        baseUrl: endpoint, // Kept for superclass compatibility if it reads it
      },
      model,
    );

    // Use the official AzureOpenAI SDK class which correctly handles pathing and API keys natively
    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: endpoint,
      deployment: config.deploymentName ?? model.id,
      apiVersion: config.apiVersion ?? '2024-08-01-preview',
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    // Azure models are configured per deployment; return a static list
    return [this.model];
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: this.model.id,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      });
      return true;
    } catch {
      return false;
    }
  }
}
