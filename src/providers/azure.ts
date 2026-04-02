// ─────────────────────────────────────────────
//  Cascade AI — Azure OpenAI Provider
// ─────────────────────────────────────────────

import OpenAI from 'openai';
import { AZURE_BASE_URL_TEMPLATE } from '../constants.js';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider } from './openai.js';

export class AzureOpenAIProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    const baseUrl = config.baseUrl
      ?? AZURE_BASE_URL_TEMPLATE.replace('{resource}', 'YOUR_RESOURCE');
    super(
      {
        ...config,
        baseUrl: `${baseUrl}/openai/deployments/${config.deploymentName ?? model.id}`,
      },
      model,
    );

    // Override client with Azure-specific configuration
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: `${baseUrl}/openai/deployments/${config.deploymentName ?? model.id}`,
      defaultQuery: { 'api-version': config.apiVersion ?? '2024-08-01-preview' },
      defaultHeaders: { 'api-key': config.apiKey ?? '' },
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
