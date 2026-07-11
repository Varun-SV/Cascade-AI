// ─────────────────────────────────────────────
//  Cascade AI — Azure OpenAI Provider
// ─────────────────────────────────────────────

import { AzureOpenAI } from 'openai';
import { AZURE_BASE_URL_TEMPLATE } from '../constants.js';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider } from './openai.js';

/**
 * The ModelInfo for one configured Azure deployment. On Azure the deployment
 * IS the model (you address it by deployment name, and which base model backs
 * it is opaque to the API) — so each `providers[]` entry with a deploymentName
 * becomes exactly one selectable model. Which base model a deployment serves
 * isn't queryable, so capabilities/pricing use GPT-4o-class defaults: cost
 * tracking reads as an estimate rather than $0.
 */
export function azureModelForDeployment(cfg: ProviderConfig): ModelInfo | null {
  if (cfg.type !== 'azure' || !cfg.deploymentName?.trim()) return null;
  const id = cfg.deploymentName.trim();
  return {
    id,
    name: cfg.label?.trim() || id,
    provider: 'azure',
    contextWindow: 128_000,
    isVisionCapable: false,
    inputCostPer1kTokens: 0.0025,
    outputCostPer1kTokens: 0.01,
    maxOutputTokens: 16_000,
    supportsStreaming: true,
    isLocal: false,
    supportsToolUse: true,
  };
}

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
    // Azure has no queryable model catalog — the configured deployment IS the
    // model. Surface it under its deployment name (previously this returned
    // the synthesized 'azure' seed, so real deployments never appeared in any
    // model list and the desktop's Azure dropdown stayed empty).
    const fromDeployment = azureModelForDeployment(this.config);
    return [fromDeployment ?? this.model];
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
