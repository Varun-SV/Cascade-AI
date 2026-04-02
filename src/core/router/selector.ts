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

  selectForTier(
    tier: TierRole,
    overrideModelId?: string,
    requireVision = false,
  ): ModelInfo | null {
    if (overrideModelId) {
      const model = this.availableModels.get(overrideModelId);
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
}
