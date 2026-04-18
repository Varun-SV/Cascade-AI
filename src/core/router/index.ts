// ─────────────────────────────────────────────
//  Cascade AI — Model Router
// ─────────────────────────────────────────────

import EventEmitter from 'node:events';
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
import { TpmLimiter } from './tpm-limiter.js';
import { MODELS, OLLAMA_BASE_URL } from '../../constants.js';
import { calculateCost } from '../../utils/cost.js';
import { withTimeout } from '../../utils/retry.js';

export interface RouterStats {
  totalTokens: number;
  totalCostUsd: number;
  callsByProvider: Record<string, number>;
  callsByTier: Record<string, number>;
  /** Accumulated cost (USD) broken down per tier — useful for budget attribution. */
  costByTier: Record<string, number>;
  /** Accumulated token usage broken down per tier (input + output). */
  tokensByTier: Record<string, number>;
  /** Input and output token counts per tier for granular cost analysis. */
  inputTokensByTier: Record<string, number>;
  outputTokensByTier: Record<string, number>;
}

export class CascadeRouter extends EventEmitter {
  private selector!: ModelSelector;
  private failover!: FailoverManager;
  private providers: Map<string, BaseProvider> = new Map();
  private stats: RouterStats = {
    totalTokens: 0,
    totalCostUsd: 0,
    callsByProvider: {},
    callsByTier: {},
    costByTier: {},
    tokensByTier: {},
    inputTokensByTier: {},
    outputTokensByTier: {},
  };

  private tierModels: Map<TierRole, ModelInfo> = new Map();
  private config!: CascadeConfig;
  private sessionCostUsd = 0;
  /**
   * Budget state machine — guards against two concurrent `generate()` calls
   * each firing the warning or both slipping past the hard cap. All
   * transitions happen inside `updateBudgetState()` which is called only
   * from `recordStats`, single-threaded per V8 event loop turn.
   */
  private budgetState: 'ok' | 'warned' | 'exceeded' = 'ok';
  private budgetExceededReason: string | undefined;
  private tpmLimiter!: TpmLimiter;

  /** Thrown when the configured budget is exceeded. */
  static BudgetExceededError = class extends Error {
    constructor(msg: string) { super(msg); this.name = 'BudgetExceededError'; }
  };

  constructor() {
    super();
  }

  async init(config: CascadeConfig): Promise<void> {
    this.config = config;
    const availableProviders = await this.detectAvailableProviders(config.providers);
    this.selector = new ModelSelector(availableProviders);
    this.failover = new FailoverManager(this.selector);
    this.tpmLimiter = new TpmLimiter((config as unknown as {
      rateLimits?: { providerTpm?: Partial<Record<ProviderType, number>> };
    }).rateLimits?.providerTpm ?? {});

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
    // Hard stop: refuse every new LLM call once the budget kill-switch fired.
    // This closes the race where two in-flight generate() calls both slipped
    // past the pre-existing `>= cap` check and pushed spend over the limit.
    if (this.budgetState === 'exceeded') {
      throw new CascadeRouter.BudgetExceededError(
        this.budgetExceededReason ?? 'Session budget exceeded.',
      );
    }

    // ── Apply per-tier token limit ──────────────
    const limits = this.config?.tierLimits;
    const tierKey = tier.toLowerCase() as 't1' | 't2' | 't3';
    const tierMaxTokens = limits?.[`${tierKey}MaxTokens` as keyof typeof limits] as number | undefined;
    if (tierMaxTokens && (!options.maxTokens || options.maxTokens > tierMaxTokens)) {
      options = { ...options, maxTokens: tierMaxTokens };
    }
    const model = requireVision
      ? this.selector.selectVisionModel()
      : this.tierModels.get(tier);

    if (!model) throw new Error(`No model available for tier ${tier}`);

    const provider = this.getProvider(model);
    if (!provider) throw new Error(`No provider for model ${model.id}`);

    // Per-provider TPM guard: pause this call until the token bucket has
    // enough budget to cover the estimated input+output tokens. Prevents
    // sudden bursts of parallel T3 spawns from overshooting a provider's
    // tokens-per-minute quota.
    const estimatedTokens = (options.maxTokens ?? model.maxOutputTokens ?? 1024) + 512;
    if (this.tpmLimiter) {
      await this.tpmLimiter.acquire(model.provider, estimatedTokens);
    }

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
      // On success, signal the failover manager so that a provider which
      // previously tripped a rate-limit can be immediately re-enabled rather
      // than waiting the full backoff window to expire.
      this.failover.recordSuccess(model.provider);
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

  /**
   * Cascade Auto: temporarily override the model for a tier.
   * Used by TaskAnalyzer to inject task-optimal models before execution.
   * The override is valid for the current task only — restored by restoreTierModels().
   */
  overrideTierModel(tier: TierRole, model: ModelInfo): void {
    this.tierModels.set(tier, model);
    this.ensureProvider(model, this.config.providers);
  }

  getSelector(): import('./selector.js').ModelSelector {
    return this.selector;
  }

  getStats(): RouterStats {
    // Deep-copy the nested Record maps so callers cannot mutate internal state.
    return {
      totalTokens: this.stats.totalTokens,
      totalCostUsd: this.stats.totalCostUsd,
      callsByProvider: { ...this.stats.callsByProvider },
      callsByTier: { ...this.stats.callsByTier },
      costByTier: { ...this.stats.costByTier },
      tokensByTier: { ...this.stats.tokensByTier },
      inputTokensByTier: { ...this.stats.inputTokensByTier },
      outputTokensByTier: { ...this.stats.outputTokensByTier },
    };
  }

  /**
   * Returns a human-readable cost summary broken down by tier.
   * Example: { T1: "$0.0120 (2 calls, 1500 tokens)", T2: "$0.0043 (6 calls, 4200 tokens)", ... }
   */
  getTierCostSummary(): Record<string, string> {
    const summary: Record<string, string> = {};
    for (const tier of Object.keys(this.stats.callsByTier)) {
      const cost = (this.stats.costByTier[tier] ?? 0).toFixed(6);
      const calls = this.stats.callsByTier[tier] ?? 0;
      const tokens = this.stats.tokensByTier[tier] ?? 0;
      summary[tier] = `$${cost} (${calls} call${calls !== 1 ? 's' : ''}, ${tokens.toLocaleString()} tokens)`;
    }
    return summary;
  }

  /**
   * Returns the percentage of total cost attributed to each tier.
   * Useful for identifying which tier is the dominant cost driver.
   */
  getTierCostPercentages(): Record<string, number> {
    const total = this.stats.totalCostUsd;
    if (total === 0) return {};
    const pcts: Record<string, number> = {};
    for (const [tier, cost] of Object.entries(this.stats.costByTier)) {
      pcts[tier] = Math.round((cost / total) * 1000) / 10; // e.g. 42.5
    }
    return pcts;
  }

  /**
   * Resets all stats — useful between independent task runs in long-lived sessions.
   */
  resetStats(): void {
    this.stats = {
      totalTokens: 0,
      totalCostUsd: 0,
      callsByProvider: {},
      callsByTier: {},
      costByTier: {},
      tokensByTier: {},
      inputTokensByTier: {},
      outputTokensByTier: {},
    };
    this.sessionCostUsd = 0;
    this.budgetState = 'ok';
    this.budgetExceededReason = undefined;
  }

  getFailures(): Record<string, string> {
    return this.failover.getFailureReport();
  }

  /**
   * Returns the current session budget cap (USD), or undefined if no cap is set.
   */
  getSessionBudget(): number | undefined {
    return this.config?.budget?.sessionBudgetUsd;
  }

  /**
   * Sets (or clears) a runtime session budget cap (USD).
   * Pass null to remove the cap.
   */
  setSessionBudget(usd: number | null): void {
    if (!this.config) return;
    if (!this.config.budget) {
      this.config = { ...this.config, budget: { sessionBudgetUsd: usd ?? undefined, warnAtPct: 80 } };
    } else {
      this.config = {
        ...this.config,
        budget: { ...this.config.budget, sessionBudgetUsd: usd ?? undefined },
      };
    }
  }

  /**
   * Returns how much of the session budget has been used (USD).
   */
  getSessionSpend(): number {
    return this.sessionCostUsd;
  }

  /**
   * Returns the resolved ModelInfo for a given tier, or null if no model
   * is available (e.g. the required provider is not configured).
   */
  getTierModel(tier: TierRole): ModelInfo | null {
    return this.tierModels.get(tier) ?? null;
  }

  /**
   * Returns all models available for the given provider type.
   * Useful for listing configured/usable models per provider.
   */
  getModelsForProvider(provider: ProviderType): ModelInfo[] {
    return this.selector.getAvailableModelsForProvider(provider);
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
    this.sessionCostUsd += usage.estimatedCostUsd;
    this.stats.callsByProvider[model.provider] = (this.stats.callsByProvider[model.provider] ?? 0) + 1;
    this.stats.callsByTier[tier] = (this.stats.callsByTier[tier] ?? 0) + 1;

    // ── Per-tier cost & token breakdown ──────────
    this.stats.costByTier[tier] = (this.stats.costByTier[tier] ?? 0) + usage.estimatedCostUsd;
    this.stats.tokensByTier[tier] = (this.stats.tokensByTier[tier] ?? 0) + usage.totalTokens;
    this.stats.inputTokensByTier[tier] = (this.stats.inputTokensByTier[tier] ?? 0) + usage.inputTokens;
    this.stats.outputTokensByTier[tier] = (this.stats.outputTokensByTier[tier] ?? 0) + usage.outputTokens;

    // ── Budget enforcement & warning (atomic state transitions) ─
    this.updateBudgetState();
  }

  /**
   * Single point of truth for budget state transitions. Called after each
   * recordStats() so warning and hard-stop transitions are evaluated
   * exactly once — previous logic allowed concurrent generate() calls to
   * both fire the warning or both miss the hard stop.
   */
  private updateBudgetState(): void {
    const budget = this.config?.budget;
    const cap = budget?.sessionBudgetUsd;
    if (!cap) return;
    const spendPct = (this.sessionCostUsd / cap) * 100;
    const warnAt = budget.warnAtPct ?? 80;

    if (this.budgetState === 'ok' && spendPct >= warnAt) {
      this.budgetState = 'warned';
      this.emit('budget:warning', {
        spentUsd: this.sessionCostUsd,
        capUsd: cap,
        spendPct: Math.round(spendPct * 10) / 10,
        warnAtPct: warnAt,
        remainingUsd: Math.max(0, cap - this.sessionCostUsd),
      });
    }

    if (this.budgetState !== 'exceeded' && this.sessionCostUsd >= cap) {
      const reason = `Session budget of $${cap.toFixed(4)} exceeded (spent $${this.sessionCostUsd.toFixed(4)}).`;
      this.halt(reason);
      // Throw on the current call so the caller also unwinds.
      throw new CascadeRouter.BudgetExceededError(reason);
    }
  }

  /**
   * Flip the router to "exceeded" state. Subsequent `generate()` calls will
   * throw BudgetExceededError immediately, and a `budget:exceeded` event is
   * broadcast once so listeners (REPL, dashboard, SDK) can cancel any
   * pending approvals and unwind the run.
   */
  halt(reason: string): void {
    if (this.budgetState === 'exceeded') return;
    this.budgetState = 'exceeded';
    this.budgetExceededReason = reason;
    this.emit('budget:exceeded', { reason, spentUsd: this.sessionCostUsd });
  }

  /** Returns current budget state — useful for tests and dashboard. */
  getBudgetState(): 'ok' | 'warned' | 'exceeded' {
    return this.budgetState;
  }

  private isRateLimitError(msg: string): boolean {
    return /rate.?limit|429|too.?many.?requests|quota/i.test(msg);
  }
}
