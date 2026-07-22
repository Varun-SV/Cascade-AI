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

/** Normalize a model id for cross-source comparison (Gemini prefixes `models/`). */
function normalizeModelId(id: string): string {
  return id.replace(/^models\//, '').toLowerCase();
}

export class ModelSelector {
  private availableProviders: Set<ProviderType>;
  private availableModels: Map<string, ModelInfo>;
  /**
   * Per-provider set of model ids the provider's own API confirmed it serves
   * (from listModels discovery). When present for a provider, AUTO selection
   * skips that provider's bundled catalog ids that aren't in the set — so a
   * stale/access-gated catalog id is never picked, then 404'd, then failed over.
   * Absent for a provider ⇒ no validation ran ⇒ behave exactly as before.
   */
  private validatedIds = new Map<ProviderType, Set<string>>();
  /**
   * Normalized ids that were added via discovery/registration but aren't in the
   * bundled catalog — i.e. genuinely new models the provider reported (a Gemini
   * flash released after the catalog was last hand-updated, an Ollama tag, etc.).
   * getCandidatesForTier lets these compete in AUTO ranking so a newer,
   * better-value model isn't invisible until someone edits constants.ts.
   */
  private discovered = new Set<string>();

  constructor(availableProviders: Set<ProviderType>) {
    this.availableProviders = availableProviders;
    this.availableModels = new Map(Object.entries(MODELS));
  }

  addDynamicModel(model: ModelInfo): void {
    this.availableModels.set(model.id, model);
    if (!(model.id in MODELS)) this.discovered.add(normalizeModelId(model.id));
  }

  /** Record the ids a provider's API actually serves (discovery). Empty ⇒ ignored. */
  setValidatedModels(provider: ProviderType, ids: string[]): void {
    if (!ids.length) return;
    this.validatedIds.set(provider, new Set(ids.map(normalizeModelId)));
  }

  /**
   * A model is usable for AUTO selection when its provider is available AND —
   * if that provider was validated — the id is one the provider confirmed.
   */
  private isUsable(model: ModelInfo): boolean {
    if (!this.availableProviders.has(model.provider)) return false;
    const valid = this.validatedIds.get(model.provider);
    return !valid || valid.has(normalizeModelId(model.id));
  }

  /**
   * Permanently drop a model from the available set for this session. Used by
   * the router's 404 / "model not found" self-heal so a dead id is never
   * selected again after it fails once.
   */
  removeModel(id: string): void {
    this.availableModels.delete(id);
  }

  /** Look up an available model by exact id (post-discovery/pricing lookups). */
  getModelById(id: string): ModelInfo | undefined {
    const m = this.availableModels.get(id);
    return m && this.availableProviders.has(m.provider) ? m : undefined;
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
      return null;
    }

    if (requireVision) {
      return this.selectVisionModel();
    }

    const priority = this.getPriorityList(tier);
    for (const key of priority) {
      const model = this.availableModels.get(key);
      if (model && this.isUsable(model)) return model;
    }

    // Fallback: any model from available providers
    for (const [, model] of this.availableModels) {
      if (this.isUsable(model)) return model;
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
      if (model && this.isUsable(model)) return model;
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

  getAllAvailableModels(): ModelInfo[] {
    return Array.from(this.availableModels.values()).filter(m =>
      this.availableProviders.has(m.provider),
    );
  }

  /**
   * Returns all available models eligible for the given tier, ordered by the
   * tier's priority chain. Use this as the candidate set for scored selection.
   */
  getCandidatesForTier(tier: TierRole): ModelInfo[] {
    const priority = this.getPriorityList(tier);
    const candidates: ModelInfo[] = [];
    for (const key of priority) {
      const model = this.availableModels.get(key);
      if (model && this.isUsable(model)) {
        candidates.push(model);
      }
    }
    // Live-discovered models the provider actually serves but that aren't in the
    // static priority chain (e.g. a newly released Gemini flash) — include them
    // for the providers this tier already routes to, so AUTO ranking can pick a
    // newer, better-value model instead of only ever seeing the bundled catalog.
    if (this.discovered.size) {
      const tierProviders = new Set<ProviderType>();
      for (const key of priority) { const m = MODELS[key]; if (m) tierProviders.add(m.provider); }
      const have = new Set(candidates.map((c) => c.id));
      for (const model of this.availableModels.values()) {
        if (have.has(model.id)) continue;
        if (!this.discovered.has(normalizeModelId(model.id))) continue;
        if (tierProviders.has(model.provider) && this.isUsable(model)) candidates.push(model);
      }
    }
    // Local-only tier: when the only available provider is Ollama, widen the
    // candidate set to EVERY available local model — including ones discovered
    // from Ollama that aren't in the static priority chain — so "best available
    // local model" can actually be selected for the task.
    const localOnly = this.availableProviders.size > 0 &&
      Array.from(this.availableProviders).every((p) => p === 'ollama');
    if (localOnly) {
      for (const model of this.availableModels.values()) {
        if (model.isLocal && this.availableProviders.has(model.provider) &&
            !candidates.some((c) => c.id === model.id)) {
          candidates.push(model);
        }
      }
    }
    return candidates;
  }

  isProviderAvailable(provider: ProviderType): boolean {
    return this.availableProviders.has(provider);
  }

  markProviderUnavailable(provider: ProviderType): void {
    this.availableProviders.delete(provider);
  }

  /**
   * Re-add a provider to the available set after it has recovered (e.g. after
   * a failover timeout expires or a successful call confirms recovery). Only
   * re-enables providers that were originally configured — callers should
   * guard against enabling providers that were never configured.
   */
  markProviderAvailable(provider: ProviderType): void {
    this.availableProviders.add(provider);
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

    // A model matching the STRIPPED id may already be registered under its
    // real id (e.g. an Azure deployment or an Ollama tag added via
    // addDynamicModel) with real pricing/context/tool-support metadata.
    // Prefer it over synthesizing a blank $0/generic placeholder below — this
    // is what previously discarded azureModelForDeployment()'s real model the
    // moment a user selected "azure:<deployment>" instead of the bare id.
    const registered = this.availableModels.get(actualId);
    if (registered && (!providerStr || registered.provider === providerStr)) {
      return registered;
    }

    if (!providerStr) {
      const lower = actualId.toLowerCase();
      if (lower.includes('claude')) providerStr = 'anthropic';
      else if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3')) providerStr = 'openai';
      else if (lower.includes('gemini')) providerStr = 'gemini';
      // A `.gguf` filename or a filesystem path (POSIX `/` or Windows `\`, incl.
      // a `C:\…` absolute path) is an OpenAI-compatible / llama.cpp model id —
      // never an Ollama tag, which is always `family:tag`. Prefer the
      // OpenAI-compatible endpoint so a local model isn't mislabeled as Ollama
      // when both providers are configured.
      else if ((lower.endsWith('.gguf') || actualId.includes('/') || actualId.includes('\\')) && this.availableProviders.has('openai-compatible')) providerStr = 'openai-compatible';
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
