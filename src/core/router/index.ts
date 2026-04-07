// ─────────────────────────────────────────────
//  Cascade AI — Model Router
// ─────────────────────────────────────────────

import type {
  CascadeConfig,
  GenerateOptions,
  GenerateResult,
  ModelInfo,
  ProviderConfig,
  ProviderType,
  StreamChunk,
  TierRole,
  TokenUsage,
} from '../../types.js';
import { AnthropicProvider } from '../../providers/anthropic.js';
import { AzureOpenAIProvider } from '../../providers/azure.js';
import { GeminiProvider } from '../../providers/gemini.js';
import { OllamaProvider } from '../../providers/ollama.js';
import { OpenAICompatibleProvider } from '../../providers/openai-compatible.js';
import { OpenAIProvider } from '../../providers/openai.js';
import type { BaseProvider } from '../../providers/base.js';
import { ModelSelector } from './selector.js';
import { FailoverManager } from './failover.js';
import { MODELS, OLLAMA_BASE_URL } from '../../constants.js';
import { calculateCost } from '../../utils/cost.js';

export interface RouterStats {
  totalTokens: number;
  totalCostUsd: number;
  callsByProvider: Record<string, number>;
  callsByTier: Record<string, number>;
}

export class CascadeRouter {
  private selector!: ModelSelector;
  private failover!: FailoverManager;
  private providers: Map<string, BaseProvider> = new Map();
  private stats: RouterStats = {
    totalTokens: 0,
    totalCostUsd: 0,
    callsByProvider: {},
    callsByTier: {},
  };

  private tierModels: Map<TierRole, ModelInfo> = new Map();
  private config!: CascadeConfig;

  async init(config: CascadeConfig): Promise<void> {
    this.config = config;
    const availableProviders = await this.detectAvailableProviders(config.providers);
    this.selector = new ModelSelector(availableProviders);
    this.failover = new FailoverManager(this.selector);

    // Discover Ollama models and register them
    const ollamaCfg = config.providers.find((p) => p.type === 'ollama');
    if (availableProviders.has('ollama')) {
      await this.discoverOllamaModels(ollamaCfg);
    }

    // Apply explicit tier overrides first.
    for (const tier of ['T1', 'T2', 'T3'] as TierRole[]) {
      const override =
        tier === 'T1' ? config.models.t1
        : tier === 'T2' ? config.models.t2
        : config.models.t3;
      if (!override) continue;

      const model = this.selector.selectForTier(tier, override);
      if (!model) {
        throw new Error(`Configured model "${override}" for ${tier} could not be loaded. Check provider availability and exact model name.`);
      }

      if (model.id !== override) {
        throw new Error(`Configured model "${override}" for ${tier} resolved to "${model.id}". Use the exact provider model ID or prefix the provider (e.g. gemini:${override}).`);
      }

      this.tierModels.set(tier, model);
      this.ensureProvider(model, config.providers);
    }

    // Fill any tiers without explicit overrides using priority defaults.
    for (const tier of ['T1', 'T2', 'T3'] as TierRole[]) {
      if (this.tierModels.has(tier)) continue;
      const model = this.selector.selectForTier(tier);
      if (model) {
        this.tierModels.set(tier, model);
        this.ensureProvider(model, config.providers);
      }
    }
  }

  async generate(
    tier: TierRole,
    options: GenerateOptions,
    onChunk?: (chunk: StreamChunk) => void,
    requireVision = false,
  ): Promise<GenerateResult> {
    const model = requireVision
      ? this.selector.selectVisionModel()
      : this.tierModels.get(tier);

    if (!model) throw new Error(`No model available for tier ${tier}`);

    const provider = this.getProvider(model);
    if (!provider) throw new Error(`No provider for model ${model.id}`);

    const useStream = Boolean(onChunk) && model.supportsStreaming && typeof provider.generateStream === 'function';

    try {
      let result: GenerateResult;
      if (useStream && onChunk) {
        try {
          result = await provider.generateStream(options, (chunk) => {
            const text = typeof chunk?.text === 'string' ? chunk.text : '';
            if (text) onChunk({ ...chunk, text });
          });
        } catch {
          result = await provider.generate(options);
        }
      } else {
        result = await provider.generate(options);
      }
      const correctedCost = calculateCost(
        result.usage.inputTokens,
        result.usage.outputTokens,
        model,
      );

      result = {
        ...result,
        usage: {
          ...result.usage,
          estimatedCostUsd: correctedCost,
        },
      };

      if (!result || typeof result.content !== 'string' || !result.usage) {
        throw new Error(`Provider ${model.provider}:${model.id} returned an invalid generation result.`);
      }

      this.recordStats(tier, model, result.usage);
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.isRateLimitError(errMsg)) {
        this.failover.recordFailure(model.provider, 'rate_limit');
        const fallback = this.failover.getFallbackModel(model, tier);
        if (fallback) {
          this.tierModels.set(tier, fallback);
          this.ensureProvider(fallback, this.config.providers);
          return this.generate(tier, options, onChunk, requireVision);
        }
      }
      throw err;
    }
  }

  getModelForTier(tier: TierRole): ModelInfo | undefined {
    return this.tierModels.get(tier);
  }

  getStats(): RouterStats {
    return { ...this.stats };
  }

  getFailures(): Record<string, string> {
    return this.failover.getFailureReport();
  }

  // ── Private ──────────────────────────────────

  private async detectAvailableProviders(
    configs: ProviderConfig[],
  ): Promise<Set<ProviderType>> {
    const available = new Set<ProviderType>();

    const checks = configs.map(async (cfg) => {
      try {
        const testModel = this.getAnyModelForProvider(cfg.type);
        if (!testModel) return;
        const provider = this.createProvider(cfg, testModel);
        const ok = await provider.isAvailable();
        if (ok) available.add(cfg.type);
      } catch { /* provider not available */ }
    });

    await Promise.allSettled(checks);
    return available;
  }

  private async discoverOllamaModels(cfg?: ProviderConfig): Promise<void> {
    try {
      const anyOllamaModel = MODELS['llama3.2:3b']!;
      const provider = new OllamaProvider(
        cfg ?? { type: 'ollama', baseUrl: OLLAMA_BASE_URL },
        anyOllamaModel,
      );
      const models = await provider.listModels();
      for (const m of models) {
        this.selector.addDynamicModel(m);
      }
    } catch { /* Ollama not running */ }
  }

  private ensureProvider(model: ModelInfo, configs: ProviderConfig[]): void {
    const key = `${model.provider}:${model.id}`;
    if (this.providers.has(key)) return;

    const cfg = configs.find((c) => c.type === model.provider)
      ?? { type: model.provider };

    const provider = this.createProvider(cfg, model);
    this.providers.set(key, provider);
  }

  private getProvider(model: ModelInfo): BaseProvider | undefined {
    return this.providers.get(`${model.provider}:${model.id}`);
  }

  private createProvider(cfg: ProviderConfig, model: ModelInfo): BaseProvider {
    switch (cfg.type) {
      case 'anthropic': return new AnthropicProvider(cfg, model);
      case 'openai': return new OpenAIProvider(cfg, model);
      case 'gemini': return new GeminiProvider(cfg, model);
      case 'azure': return new AzureOpenAIProvider(cfg, model);
      case 'ollama': return new OllamaProvider(cfg, model);
      case 'openai-compatible': return new OpenAICompatibleProvider(cfg, model);
      default:
        throw new Error(`Unsupported provider type: ${String(cfg.type)}`);
    }
  }

  private getAnyModelForProvider(type: ProviderType): ModelInfo | undefined {
    return Object.values(MODELS).find((m) => m.provider === type);
  }

  private recordStats(tier: TierRole, model: ModelInfo, usage: TokenUsage): void {
    this.stats.totalTokens += usage.totalTokens;
    this.stats.totalCostUsd += usage.estimatedCostUsd;
    this.stats.callsByProvider[model.provider] = (this.stats.callsByProvider[model.provider] ?? 0) + 1;
    this.stats.callsByTier[tier] = (this.stats.callsByTier[tier] ?? 0) + 1;
  }

  private isRateLimitError(msg: string): boolean {
    return /rate.?limit|429|too.?many.?requests|quota/i.test(msg);
  }
}
