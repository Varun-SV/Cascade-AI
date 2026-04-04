// ─────────────────────────────────────────────
//  Cascade AI — Model Selector
// ─────────────────────────────────────────────

import type { ModelInfo, ProviderType, TierRole } from '../../types.js';
import {
  T1_MODEL_PRIORITY,
  T2_MODEL_PRIORITY,
  T3_MODEL_PRIORITY,
  VISION_MODEL_PRIORITY,
  MODELS,
} from '../../constants.js';

export class ModelSelector {
  private availableProviders: Set<ProviderType>;
  private availableModels: Map<string, ModelInfo>;

  constructor(availableProviders: Set<ProviderType>) {
    this.availableProviders = availableProviders;
    this.availableModels = new Map(Object.entries(MODELS));
  }

  addDynamicModel(model: ModelInfo): void {
    this.availableModels.set(model.id, model);
  }

  getAvailableModelsForProvider(provider: ProviderType): ModelInfo[] {
    const models = new Map<string, ModelInfo>();
    for (const model of this.availableModels.values()) {
      if (model.provider === provider && this.availableProviders.has(provider)) {
        models.set(model.id, model);
      }
    }
    return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  selectForTier(
    tier: TierRole,
    overrideModelId?: string,
    requireVision = false,
  ): ModelInfo | null {
    if (overrideModelId) {
      let model = this.availableModels.get(overrideModelId);
      if (!model) {
        model = this.resolveDynamicModel(overrideModelId);
      }
      if (model && this.availableProviders.has(model.provider)) return model;
    }

    if (requireVision) {
      return this.selectVisionModel();
    }

    const priority = this.getPriorityList(tier);
    for (const key of priority) {
      const model = this.availableModels.get(key);
      if (model && this.availableProviders.has(model.provider)) return model;
    }

    // Fallback: any model from available providers
    for (const [, model] of this.availableModels) {
      if (this.availableProviders.has(model.provider)) return model;
    }

    return null;
  }

  selectVisionModel(): ModelInfo | null {
    for (const key of VISION_MODEL_PRIORITY) {
      const model = this.availableModels.get(key);
      if (model && this.availableProviders.has(model.provider) && model.isVisionCapable) {
        return model;
      }
    }
    return null;
  }

  getNextFallback(currentModelId: string, tier: TierRole): ModelInfo | null {
    const priority = this.getPriorityList(tier);
    const currentIdx = priority.indexOf(currentModelId);
    if (currentIdx === -1) return null;

    for (let i = currentIdx + 1; i < priority.length; i++) {
      const key = priority[i]!;
      const model = this.availableModels.get(key);
      if (model && this.availableProviders.has(model.provider)) return model;
    }
    return null;
  }

  private getPriorityList(tier: TierRole): string[] {
    switch (tier) {
      case 'T1': return T1_MODEL_PRIORITY;
      case 'T2': return T2_MODEL_PRIORITY;
      case 'T3': return T3_MODEL_PRIORITY;
    }
  }

  isProviderAvailable(provider: ProviderType): boolean {
    return this.availableProviders.has(provider);
  }

  markProviderUnavailable(provider: ProviderType): void {
    this.availableProviders.delete(provider);
  }

  private resolveDynamicModel(overrideModelId: string): ModelInfo | undefined {
    let providerStr: ProviderType | null = null;
    let actualId = overrideModelId;

    if (overrideModelId.includes(':')) {
      const parts = overrideModelId.split(':');
      const prefix = parts[0]!.toLowerCase();
      const validProviders = ['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible', 'ollama'];
      if (validProviders.includes(prefix)) {
        providerStr = prefix as ProviderType;
        actualId = parts.slice(1).join(':');
      }
    }

    if (!providerStr) {
      const lower = actualId.toLowerCase();
      if (lower.includes('claude')) providerStr = 'anthropic';
      else if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3')) providerStr = 'openai';
      else if (lower.includes('gemini')) providerStr = 'gemini';
      else if (this.availableProviders.has('ollama')) providerStr = 'ollama';
      else if (this.availableProviders.has('openai-compatible')) providerStr = 'openai-compatible';
      else if (this.availableProviders.size === 1) providerStr = Array.from(this.availableProviders)[0]!;
    }

    if (providerStr && this.availableProviders.has(providerStr)) {
      const dynamicModel: ModelInfo = {
        id: actualId,
        name: actualId,
        provider: providerStr,
        contextWindow: 128_000,
        isVisionCapable: false,
        inputCostPer1kTokens: 0,
        outputCostPer1kTokens: 0,
        maxOutputTokens: 8_000,
        supportsStreaming: true,
        isLocal: providerStr === 'ollama',
      };
      this.addDynamicModel(dynamicModel);
      return dynamicModel;
    }
    return undefined;
  }
}
