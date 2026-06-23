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
import { LocalRequestQueue } from './local-queue.js';
import type { TaskAnalyzer } from './task-analyzer.js';
import { MODELS, OLLAMA_BASE_URL } from '../../constants.js';
import { calculateCost } from '../../utils/cost.js';
import { withTimeout, CascadeCancelledError } from '../../utils/retry.js';
import { ModelProfiler } from './model-profiler.js';
import type { MemoryStore } from '../../memory/store.js';
import { computeDelegationSavings, type DelegationSavings } from './savings.js';
import { LiveDataProvider } from './live-data.js';
import { setBenchmarkLiveProvider } from './benchmarks.js';

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
  // Per-run accounting for the hard per-task cap. Reset by beginRun() at the
  // start of every `cascade run`, independent of the session-wide budget.
  private runTokens = 0;
  private runCostUsd = 0;
  private runBudgetExceeded = false;
  private runBudgetExceededReason: string | undefined;
  /**
   * Budget state machine — guards against two concurrent `generate()` calls
   * each firing the warning or both slipping past the hard cap. All
   * transitions happen inside `updateBudgetState()` which is called only
   * from `recordStats`, single-threaded per V8 event loop turn.
   */
  private budgetState: 'ok' | 'warned' | 'exceeded' = 'ok';
  private budgetExceededReason: string | undefined;
  private tpmLimiter!: TpmLimiter;
  private localQueue!: LocalRequestQueue;
  private taskAnalyzer?: TaskAnalyzer;
  private liveData?: LiveDataProvider;
  /** Snapshot of configured/default tier models, taken before Cascade Auto overrides them. */
  private originalTierModels?: Map<TierRole, ModelInfo>;
  /** The current run's abort signal — injected into every provider call so a cancel aborts in-flight requests. */
  private runSignal?: AbortSignal;

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

    this.localQueue = new LocalRequestQueue(config.localConcurrency ?? 1);

    // Discover Ollama models and register them
    const ollamaCfg = config.providers.find((p) => p.type === 'ollama');
    if (availableProviders.has('ollama')) {
      await this.discoverOllamaModels(ollamaCfg);
    }

    // Discover OpenAI-compatible (e.g. llama.cpp) models too, so a configured
    // local model id (like a `.gguf`) resolves to the provider that actually
    // serves it — exact-id match below wins over the heuristic in the selector,
    // which would otherwise mis-attribute it to Ollama when both are configured.
    if (availableProviders.has('openai-compatible')) {
      await Promise.all(
        config.providers
          .filter((p) => p.type === 'openai-compatible')
          .map((cfg) => this.discoverOpenAICompatibleModels(cfg)),
      );
    }

    // Apply explicit tier overrides first.
    for (const tier of ['T1', 'T2', 'T3'] as TierRole[]) {
      const override =
        tier === 'T1' ? config.models.t1
        : tier === 'T2' ? config.models.t2
        : config.models.t3;
      // 'auto' is the UI/CLI sentinel for "no explicit override — let routing
      // pick the best model for this tier". Treat it like an unset override.
      if (!override || override === 'auto') continue;

      const model = this.selector.selectForTier(tier, override);
      if (!model) {
        const knownProviders = ['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible', 'ollama'];
        const hasProviderPrefix = override.includes(':') &&
          knownProviders.some(p => override.startsWith(p + ':'));
        if (hasProviderPrefix) {
          const provider = override.split(':')[0];
          throw new Error(
            `Configured model "${override}" for ${tier} cannot be used: ` +
            `provider '${provider}' is not available or unreachable. ` +
            `Check that the provider is running and accessible.`
          );
        }
        throw new Error(
          `Configured model "${override}" for ${tier} could not be loaded. ` +
          `Check provider availability and exact model name.`
        );
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

  /**
   * Run model specialization profiling in the background.
   * Only profiles models that haven't been profiled yet (cache-first).
   * No-op if store is not provided.
   */
  async profileModels(store: MemoryStore): Promise<void> {
    const allModels = this.selector.getAllAvailableModels();
    const profiler = new ModelProfiler(store, this);
    // Run in background — don't block task execution
    profiler.profileAll(allModels).catch(() => { /* non-fatal */ });
  }

  /**
   * Cascade Auto live data: discover/validate real model ids from each cloud
   * provider, then fetch current public quality scores + per-token prices and
   * apply the prices to the available-model set. Best-effort and safe to run in
   * the background — any failure leaves the bundled catalog/benchmarks in effect.
   */
  async refreshLiveData(): Promise<void> {
    const benchCfg = this.config.benchmarks ?? {};
    if (!this.liveData) {
      this.liveData = new LiveDataProvider({
        live: benchCfg.live,
        pricingLive: benchCfg.pricingLive,
        refreshHours: benchCfg.refreshHours,
        sourceUrl: benchCfg.sourceUrl,
      });
      // Route benchmarkScore01 through the live source for this process.
      setBenchmarkLiveProvider(this.liveData);
    }
    await this.discoverProviderModels();
    await this.liveData.refresh().catch(() => { /* keep last-known-good */ });
    this.applyLivePricing();
  }

  /** Returns the live-data provider once refreshLiveData has run (UX/insight). */
  getLiveData(): LiveDataProvider | undefined {
    return this.liveData;
  }

  /**
   * Query each available cloud provider's live model list and register the
   * results. Confirms catalog ids still exist and surfaces newly released
   * models without a package upgrade. Mirrors discoverOllamaModels.
   */
  private async discoverProviderModels(): Promise<void> {
    const cloud: ProviderType[] = ['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible'];
    const tasks = cloud.map(async (type) => {
      if (!this.selector.isProviderAvailable(type)) return;
      const seed = this.getAnyModelForProvider(type);
      if (!seed) return;
      const cfg = this.config.providers.find((p) => p.type === type) ?? { type };
      try {
        const provider = this.createProvider(cfg, seed);
        if (typeof provider.listModels !== 'function') return;
        const models = await provider.listModels();
        for (const m of models) this.selector.addDynamicModel(m);
      } catch { /* provider listing unavailable — non-fatal */ }
    });
    await Promise.allSettled(tasks);
  }

  /**
   * Replace available models with live-priced copies and refresh the already
   * resolved tier models so shared-tier cost accounting uses current prices.
   */
  private applyLivePricing(): void {
    if (!this.liveData?.hasLivePricing()) return;
    const updated = this.liveData.applyLivePricing(this.selector.getAllAvailableModels());
    for (const m of updated) this.selector.addDynamicModel(m);
    for (const tier of ['T1', 'T2', 'T3'] as TierRole[]) {
      const cur = this.tierModels.get(tier);
      if (!cur) continue;
      const fresh = this.selector.getModelById(cur.id);
      if (fresh) this.tierModels.set(tier, fresh);
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
    // Hard per-task ceiling — stop the moment a single run goes over, so a
    // mis-routed task cannot keep spawning LLM calls.
    if (this.runBudgetExceeded) {
      throw new CascadeRouter.BudgetExceededError(
        this.runBudgetExceededReason ?? 'Per-task budget exceeded.',
      );
    }

    // ── Apply per-tier token limit ──────────────
    const limits = this.config?.tierLimits;
    const tierKey = tier.toLowerCase() as 't1' | 't2' | 't3';
    const tierMaxTokens = limits?.[`${tierKey}MaxTokens` as keyof typeof limits] as number | undefined;
    if (tierMaxTokens && (!options.maxTokens || options.maxTokens > tierMaxTokens)) {
      options = { ...options, maxTokens: tierMaxTokens };
    }
    // Inject the run's abort signal so the provider can abort the in-flight
    // request the moment a cancel fires (instant cancellation).
    if (this.runSignal && !options.signal) {
      options = { ...options, signal: this.runSignal };
    }
    // Per-call override (Cascade Auto per-subtask routing) wins over the shared
    // tier model, except when a vision model is explicitly required.
    if (options.model && !requireVision) {
      this.ensureProvider(options.model, this.config.providers);
    }
    const model = requireVision
      ? this.selector.selectVisionModel()
      : (options.model ?? this.tierModels.get(tier));

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

    // Serialize requests to local providers (e.g. Ollama) to prevent GPU VRAM
    // pressure when multiple T3 workers run in parallel on a single-GPU machine.
    let releaseLocalSlot: (() => void) | undefined;
    if (model.isLocal) {
      const inferenceTimeoutMs = this.config.localInferenceTimeoutMs ?? 300_000;
      // Allow up to half the inference timeout to wait in the queue itself.
      const queueWaitMs = Math.round(inferenceTimeoutMs / 2);
      releaseLocalSlot = await this.localQueue.acquire(queueWaitMs);
    }

    try {
      let result: GenerateResult;

      if (model.isLocal) {
        // Apply a hard timeout to local inference calls so a slow/overloaded
        // model doesn't block the worker indefinitely.
        const inferenceTimeoutMs = this.config.localInferenceTimeoutMs ?? 300_000;
        const inferencePromise = useStream && onChunk
          ? provider.generateStream(options, (chunk) => {
              const text = typeof chunk?.text === 'string' ? chunk.text : '';
              if (text) onChunk({ ...chunk, text });
            })
          : provider.generate(options);
        result = await withTimeout(
          inferencePromise,
          inferenceTimeoutMs,
          `Local model ${model.id} inference timed out after ${inferenceTimeoutMs}ms`,
        );
      } else if (useStream && onChunk) {
        // Cloud streaming MUST be time-boxed: a stalled SSE connection (TCP open,
        // no terminal chunk) would otherwise hang the whole run with no output.
        const cloudTimeoutMs = this.config.cloudInferenceTimeoutMs ?? 120_000;
        try {
          result = await withTimeout(
            provider.generateStream(options, (chunk) => {
              const text = typeof chunk?.text === 'string' ? chunk.text : '';
              if (text) onChunk({ ...chunk, text });
            }),
            cloudTimeoutMs,
            `Model ${model.id} stream timed out after ${cloudTimeoutMs}ms`,
          );
        } catch (streamErr) {
          // Cancelled mid-stream — propagate the abort, don't retry.
          if ((streamErr instanceof Error && streamErr.name === 'AbortError') || this.runSignal?.aborted || options.signal?.aborted) {
            throw streamErr;
          }
          // Stream stalled or errored — fall back to a (also time-boxed)
          // non-streaming call rather than letting a hung stream freeze the run.
          result = await withTimeout(
            provider.generate(options),
            cloudTimeoutMs,
            `Model ${model.id} inference timed out after ${cloudTimeoutMs}ms`,
          );
        }
      } else {
        const cloudTimeoutMs = this.config.cloudInferenceTimeoutMs ?? 120_000;
        result = await withTimeout(
          provider.generate(options),
          cloudTimeoutMs,
          `Model ${model.id} inference timed out after ${cloudTimeoutMs}ms`,
        );
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
      // A cancelled run aborts the in-flight provider request. Surface it as a
      // cancellation so it propagates like the checkpoint-based cancel (graceful
      // stop + partial output upstream) rather than being retried/failed-over.
      if ((err instanceof Error && err.name === 'AbortError') || this.runSignal?.aborted || options.signal?.aborted) {
        throw new CascadeCancelledError('Run cancelled');
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.isRateLimitError(errMsg)) {
        this.failover.recordFailure(model.provider, 'rate_limit');
        const fallback = this.failover.getFallbackModel(model, tier);
        if (fallback) {
          this.tierModels.set(tier, fallback);
          this.ensureProvider(fallback, this.config.providers);
          this.emit('failover', {
            tier,
            from: `${model.provider}:${model.id}`,
            to: `${fallback.provider}:${fallback.id}`,
            reason: 'rate limit',
          });
          // Release the local slot before the recursive call so the fallback
          // model (which may itself be local) can acquire its own slot.
          releaseLocalSlot?.();
          releaseLocalSlot = undefined;
          return this.generate(tier, options, onChunk, requireVision);
        }
      }
      // Stale / invalid model id (e.g. a retired preview that 404s). Drop it so
      // it is never selected again this session and fail over to the next
      // candidate, instead of surfacing the raw provider error to the user.
      if (isModelNotFoundError(errMsg)) {
        this.selector.removeModel(model.id);
        const next = this.selector.selectForTier(tier);
        if (next && next.id !== model.id) {
          this.tierModels.set(tier, next);
          this.ensureProvider(next, this.config.providers);
          this.emit('failover', {
            tier,
            from: `${model.provider}:${model.id}`,
            to: `${next.provider}:${next.id}`,
            reason: 'model not found',
          });
          releaseLocalSlot?.();
          releaseLocalSlot = undefined;
          // Clear a per-subtask override that pointed at the dead model so the
          // recursive call resolves the tier's next-best model.
          const retryOpts = options.model && options.model.id === model.id
            ? { ...options, model: undefined }
            : options;
          return this.generate(tier, retryOpts, onChunk, requireVision);
        }
      }
      throw err;
    } finally {
      releaseLocalSlot?.();
    }
  }

  getModelForTier(tier: TierRole): ModelInfo | undefined {
    return this.tierModels.get(tier);
  }

  /** Reflection settings for workers (config.reflection). Off unless enabled. */
  getReflectionConfig(): { enabled: boolean; maxRounds: number } {
    const r = this.config?.reflection;
    return { enabled: r?.enabled === true, maxRounds: r?.maxRounds ?? 1 };
  }

  /** T3→T2 reinforcement settings (config.reinforcements). Off unless enabled. */
  getReinforcementsConfig(): { enabled: boolean; maxPerSection: number } {
    const r = this.config?.reinforcements;
    return { enabled: r?.enabled === true, maxPerSection: r?.maxPerSection ?? 4 };
  }

  /**
   * Resolved T3 wave execution mode. 'auto' becomes 'sequential' when the T3
   * tier resolves to a LOCAL model (the single-GPU queue serializes anyway, so
   * running them in parallel just thrashes it), and 'parallel' for cloud.
   */
  getT3ExecutionMode(): 'parallel' | 'sequential' {
    const mode = this.config?.t3Execution ?? 'auto';
    if (mode === 'parallel' || mode === 'sequential') return mode;
    return this.tierModels.get('T3')?.isLocal ? 'sequential' : 'parallel';
  }

  /**
   * Cascade Auto: temporarily override the model for a tier.
   * Used by TaskAnalyzer to inject task-optimal models before execution.
   * The override is valid for the current task only — restored by restoreTierModels().
   */
  overrideTierModel(tier: TierRole, model: ModelInfo): void {
    // Snapshot the configured/default tier models once so they can be restored
    // after the run — Cascade Auto's per-task picks must not leak across runs.
    if (!this.originalTierModels) {
      this.originalTierModels = new Map(this.tierModels);
    }
    this.tierModels.set(tier, model);
    this.ensureProvider(model, this.config.providers);
  }

  /**
   * Restore tier models to the configured/default baseline captured before the
   * first Cascade Auto override. Called at the end of each run so `/why`, the
   * status bar, and the next run reflect the configured models, not stale picks.
   */
  restoreTierModels(): void {
    if (this.originalTierModels) {
      this.tierModels = new Map(this.originalTierModels);
      this.originalTierModels = undefined;
    }
  }

  /** Set (or clear) the current run's abort signal for instant cancellation. */
  setRunSignal(signal: AbortSignal | undefined): void {
    this.runSignal = signal;
  }

  getSelector(): import('./selector.js').ModelSelector {
    return this.selector;
  }

  /** Wire the Cascade Auto task analyzer used for per-subtask model routing. */
  setTaskAnalyzer(analyzer: TaskAnalyzer): void {
    this.taskAnalyzer = analyzer;
  }

  /**
   * Cascade Auto per-subtask routing: pick the benchmark-best model for a
   * specific subtask's text, scoped to the tier's eligible candidates. Returns
   * null when Cascade Auto is off (callers then use the shared tier model).
   * Pure heuristic — no extra LLM call.
   */
  async selectModelForSubtask(tier: TierRole, text: string): Promise<ModelInfo | null> {
    if (!this.config?.cascadeAuto || !this.taskAnalyzer || !text.trim()) return null;
    try {
      return await this.taskAnalyzer.selectModel(text, tier, this.selector);
    } catch {
      return null;
    }
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
   * What did delegation save? Compares actual spend against the
   * counterfactual of every call running on the T1 model. This is the
   * number only a tiered hierarchy can show.
   */
  getDelegationSavings(): DelegationSavings {
    return computeDelegationSavings(this.stats, this.tierModels.get('T1'));
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
  /** Raise/set the per-task token cap at runtime (used by /continue resume). */
  setMaxTokensPerRun(maxTokens: number): void {
    if (!this.config) return;
    this.config = { ...this.config, budget: { ...this.config.budget, maxTokensPerRun: maxTokens } };
  }

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

  private async discoverOpenAICompatibleModels(cfg: ProviderConfig): Promise<void> {
    try {
      // Minimal seed ModelInfo just to construct the provider client; listModels
      // returns the endpoint's real models tagged provider: 'openai-compatible'.
      const seed: ModelInfo = {
        id: 'openai-compatible', name: 'openai-compatible', provider: 'openai-compatible',
        contextWindow: 32_000, isVisionCapable: false,
        inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
        maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
      };
      const provider = new OpenAICompatibleProvider(cfg, seed);
      const models = await provider.listModels();
      for (const m of models) {
        this.selector.addDynamicModel(m);
      }
    } catch { /* endpoint not reachable */ }
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
    const fromCatalog = Object.values(MODELS).find((m) => m.provider === type);
    if (fromCatalog) return fromCatalog;
    // openai-compatible and azure are configured per-endpoint and have NO fixed
    // catalog entry. Without a seed model `detectAvailableProviders` skipped them
    // entirely — so an OpenAI-compatible (e.g. llama.cpp) provider was never
    // marked available and its models could not be selected. Synthesize a minimal
    // seed so the client can be built for the availability check and model
    // listing; the real models are discovered from the endpoint.
    if (type === 'openai-compatible' || type === 'azure') {
      return {
        id: type, name: type, provider: type,
        contextWindow: 32_000, isVisionCapable: false,
        inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
        maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
      };
    }
    return undefined;
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

    // ── Per-run accounting (hard per-task ceiling) ──
    this.runTokens += usage.totalTokens;
    this.runCostUsd += usage.estimatedCostUsd;

    // ── Budget enforcement & warning (atomic state transitions) ─
    this.updateBudgetState();
    this.enforceRunBudget();
  }

  /**
   * Resets per-run accounting at the start of each `cascade run`. Session
   * totals and a session-wide budget halt are deliberately preserved; only the
   * per-task ceiling is cleared so the next task starts with a fresh allowance.
   */
  beginRun(): void {
    this.runTokens = 0;
    this.runCostUsd = 0;
    this.runBudgetExceeded = false;
    this.runBudgetExceededReason = undefined;
  }

  /**
   * Enforce the hard per-task ceiling. Once tripped, the flag makes every
   * subsequent (and concurrent) generate() call in this run fail fast.
   */
  private enforceRunBudget(): void {
    if (this.runBudgetExceeded) return;
    const budget = this.config?.budget;
    const maxTokens = budget?.maxTokensPerRun;
    const maxCost = budget?.maxCostPerRunUsd;
    const overTokens = maxTokens != null && this.runTokens >= maxTokens;
    const overCost = maxCost != null && this.runCostUsd >= maxCost;
    if (!overTokens && !overCost) return;

    const reason = overTokens
      ? `Per-task token cap of ${maxTokens!.toLocaleString()} reached (used ${this.runTokens.toLocaleString()}). Stopping this run to avoid runaway cost — raise budget.maxTokensPerRun for larger jobs.`
      : `Per-task cost cap of $${maxCost!.toFixed(4)} reached (spent $${this.runCostUsd.toFixed(4)}). Stopping this run to avoid runaway cost.`;
    this.runBudgetExceeded = true;
    this.runBudgetExceededReason = reason;
    this.emit('budget:exceeded', { reason, spentUsd: this.sessionCostUsd });
    throw new CascadeRouter.BudgetExceededError(reason);
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

/**
 * Detects "this model id doesn't exist / isn't usable" errors so a stale
 * catalog entry self-heals instead of hard-failing. Covers the Gemini
 * "is not found … NOT_FOUND … is not supported for generateContent" shape
 * plus the OpenAI/Anthropic equivalents. Exported for unit testing.
 */
export function isModelNotFoundError(msg: string): boolean {
  return /not[_\s]?found|404|does not exist|no such model|unknown model|invalid model|model_not_found|not supported for generatecontent|is not supported for/i.test(msg);
}
