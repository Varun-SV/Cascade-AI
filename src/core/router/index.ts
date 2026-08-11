// ─────────────────────────────────────────────
//  Cascade AI — Model Router
// ─────────────────────────────────────────────

import EventEmitter, { setMaxListeners } from 'node:events';
import crypto from 'node:crypto';
import type {
  CascadeConfig,
  GenerateOptions,
  ConversationMessage,
  GenerateResult,
  ModelInfo,
  ProviderConfig,
  ProviderType,
  StreamChunk,
  TierLimits,
  TierRole,
  TokenUsage,
} from '../../types.js';
import { AnthropicProvider } from '../../providers/anthropic.js';
import { AzureOpenAIProvider, azureModelForDeployment } from '../../providers/azure.js';
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
import type { FeedbackSource } from './feedback-prior.js';
import { DeadModelStore } from './dead-models.js';
import { MODELS, OLLAMA_BASE_URL } from '../../constants.js';
import { buildTokenUsage, resolveModelPricing } from '../../utils/cost.js';
import { estimateTokens, contentToText, CHARS_PER_TOKEN } from '../context/compaction.js';
import { withTimeout, withTimeoutAbort, anySignal, CascadeCancelledError } from '../../utils/retry.js';
import { wireProfile, geminiImageCopies } from './wire-profile.js';
import { ModelProfiler } from './model-profiler.js';
import type { MemoryStore } from '../../memory/store.js';
import { computeDelegationSavings, type DelegationSavings } from './savings.js';
import { LiveDataProvider } from './live-data.js';
import { setBenchmarkLiveProvider } from './benchmarks.js';
import type { WorldStateDB } from '../knowledge/world-state.js';
import type { PrivacyPaths } from '../privacy/paths.js';
import type { GuidanceQueue } from '../steering/guidance.js';

/**
 * Rough capability score inferred from a model/deployment name, used to order
 * benchmark-less Azure deployments across tiers. Higher = stronger/pricier.
 * Purely heuristic (deployment names are opaque) — size/cost keywords dominate,
 * with the version number as a mild secondary signal.
 */
export function inferModelCapability(id: string): number {
  const s = (id || '').toLowerCase();
  let score = 0;
  if (/\b(mini|nano|small|lite|flash|instant|tiny|micro|0\.5b|1b|1\.5b|3b|7b|8b)\b/.test(s)) score -= 30;
  else if (/\b(pro|max|opus|ultra|large|xl|xxl|70b|405b|405)\b/.test(s)) score += 30;
  // First major(.minor) version, e.g. gpt-5.4 → 5.4, o3 → 3, gpt-35 → 3.5.
  const m = s.match(/(\d{1,3})(?:\.(\d))?/);
  if (m) {
    let major = parseInt(m[1]!, 10);
    let minor = m[2] ? parseInt(m[2]!, 10) : 0;
    if (major >= 30 && major < 100) { minor = major % 10; major = Math.floor(major / 10); } // '35' → 3.5
    score += major + minor / 10;
  }
  return score;
}

/**
 * Picks the rank-appropriate deployment for a tier from a capability-descending
 * list: T1 the strongest, T3 the cheapest, T2 the middle (reusing neighbours
 * when there are fewer than three deployments).
 */
export function azureModelForTier<T>(tier: 'T1' | 'T2' | 'T3', ranked: T[]): T | undefined {
  if (ranked.length === 0) return undefined;
  if (tier === 'T1') return ranked[0];
  if (tier === 'T3') return ranked[ranked.length - 1];
  return ranked[Math.min(1, ranked.length - 1)]; // T2: second-strongest, or the only one
}

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
  /** Accumulated cost (USD) broken down by feature tag (e.g. T2 section names). */
  costByFeature: Record<string, number>;
  /**
   * Calls made against models Cascade has no price for. Their spend is NOT in
   * `totalCostUsd` — it can't be — so a non-zero count here means the totals
   * above (and any budget check derived from them) are an undercount.
   */
  untrackedCostCalls: number;
  /** Ids of the models responsible, for "cost not tracked for: …" readouts. */
  untrackedCostModels: string[];
}

// ── Cloud model-discovery cache ──
// listModels() results keyed by a hash of provider+key+baseUrl, so validating a
// key's real models is a one-time cost even though the hosted server creates a
// fresh router per request. In-memory + TTL-bounded; only a hash of the key is
// stored, never the key itself.
/**
 * Tokens charged for an image whose bytes we cannot see (a URL reference, or a
 * block shaped differently than expected). Around what a mid-size photo costs
 * on the common vision models — high enough that a budget check notices the
 * image, low enough that one picture cannot refuse a run on its own.
 */
const IMAGE_TOKENS_FALLBACK = 1_500;

/**
 * The most an image can cost, however many bytes arrive.
 *
 * Vision providers downscale before billing — Anthropic caps around 1.15
 * megapixels, roughly 1,600 tokens, and OpenAI's high-detail tiling lands in
 * the same range — so image cost does NOT grow with file size the way a naive
 * bytes-per-token estimate implies. Left unbounded, a 20 MB screenshot would
 * be charged tens of thousands of tokens it will never incur, and refuse runs
 * that would have completed fine.
 */
const IMAGE_TOKENS_MAX = 2_000;

/**
 * Tokens booked for one image, whatever its bytes say.
 *
 * Byte length is not a proxy for what a vision model charges, in either
 * direction: providers bill from DECODED dimensions, so a heavily compressed
 * PNG — a large solid-colour screenshot is the easy example — can be a few
 * kilobytes and still be billed near the megapixel maximum, while a 20 MB photo
 * is downscaled to that same ceiling. Sizing from bytes therefore undercounts
 * exactly the images that would slip a tight cap.
 *
 * Decoding dimensions would mean parsing image headers inside the budget path.
 * The honest alternative is what the providers effectively do: charge a flat
 * rate per image, at the top of the range they bill in, so no real image falls
 * below what was reserved for it.
 */
const IMAGE_TOKENS_EACH = IMAGE_TOKENS_MAX;

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

/**
 * A token estimate that does not undercount dense scripts.
 *
 * `estimateTokens` divides by four, which suits English and is what the
 * compaction budgeter wants. It is wrong in the UNSAFE direction for CJK,
 * emoji and similar, which commonly cost about a token per character — so a
 * prompt full of them is underestimated roughly fourfold, and an underestimate
 * in an enforcement path is a cap that silently does not hold. Taking the
 * larger of the two counts leaves ASCII exactly as it was.
 */
/**
 * A fresh per-run abort controller, with room for the listeners a run attaches.
 *
 * Every billable call chains to this signal, so a T3 wave adds one listener per
 * call in flight — a wave wider than Node's default ceiling of 10 logged a
 * MaxListenersExceededWarning and made an ordinary parallel run look like a
 * leak. `Cascade.run()` already raises the limit on the caller's own signal for
 * exactly this fan-out; the signal the router owns needs the same, and the same
 * number, or only half the problem is fixed. The listeners are removed as their
 * calls settle.
 */
function newRunAbort(): AbortController {
  const controller = new AbortController();
  setMaxListeners(64, controller.signal);
  return controller;
}

/**
 * Framing every provider adds around each turn — role markers, message
 * delimiters, chat-template scaffolding. Four tokens a message is the figure
 * OpenAI documents for its own format and the others are the same order.
 * Without it a long history of short turns reserved about a token each while
 * the provider billed several times that.
 */
const TOKENS_PER_MESSAGE_FRAMING = 4;

/**
 * ASCII is left at four characters per token, deliberately.
 *
 * Review raised that token-dense ASCII — base64, hashes, minified data —
 * tokenizes closer to two or three characters per token, so this can
 * under-count it. That is true, and it is not worth what correcting it costs:
 * the only cheap discriminator is whitespace ratio, and it cannot tell a
 * base64 blob from a long URL, a pasted code block, or a run of one repeated
 * character (which compresses to almost nothing). Raising the rate for all of
 * them inflates every large paste by more than half and refuses runs that
 * would have completed — the failure this whole check is meant to avoid.
 *
 * The honest fix is a real tokenizer, not a better guess. Until then the
 * residual is a bounded under-count on machine data, caught by the post-call
 * ceiling as it always was.
 */
function guardTokens(text: string): number {
  if (!text) return 0;
  // The bound for the non-ASCII part is its UTF-8 BYTE count, not its
  // character count. Production tokenizers are byte-level BPE, so a token can
  // never span fewer than one byte — bytes are a true ceiling, where "one
  // token per code point" was only a guess, and a wrong one for emoji: a ZWJ
  // sequence is several code points and can cost several tokens each.
  let asciiChars = 0;
  let denseBytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) { asciiChars++; continue; }
    denseBytes += cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  // The two parts are SUMMED, not raced. Taking the larger of the two was a
  // hole in exactly the input this guard exists for: a document mixing prose
  // with CJK charged whichever half was bigger and the other half for nothing,
  // so a megabyte of ASCII alongside 100,000 CJK characters reserved about
  // 325,000 tokens against a real cost near 400,000 — and adding more prose to
  // such a prompt did not move the estimate at all until it overtook the dense
  // part. Neither bound changes on its own: pure ASCII is the same rate it was,
  // and pure dense text is the same byte ceiling.
  if (denseBytes === 0) return estimateTokens(text);
  return Math.ceil(asciiChars / CHARS_PER_TOKEN) + denseBytes;
}

const DISCOVERY_TTL_MS = 15 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 4_000;
interface DiscoveryEntry { ids: string[]; models: ModelInfo[]; at: number }
const cloudDiscoveryCache = new Map<string, DiscoveryEntry>();

function discoveryCacheKey(type: ProviderType, cfg: ProviderConfig): string {
  const raw = `${type}|${cfg.apiKey ?? ''}|${cfg.baseUrl ?? ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/**
 * Apply the configured per-tier token/temperature limits to a generate call.
 * Pure — returns a new options object only when something changed.
 *
 * - maxTokens is a **ceiling**: it lowers an explicit request that exceeds it,
 *   and fills one in when absent, but never raises a smaller explicit value.
 * - temperature is a **default**: applied only when the call left temperature
 *   unset, so internal deterministic calls (which pin `temperature: 0`) keep it.
 */
export function applyTierLimits(options: GenerateOptions, tier: TierRole, limits?: TierLimits): GenerateOptions {
  if (!limits) return options;
  const key = tier.toLowerCase() as 't1' | 't2' | 't3';
  const maxTokens = limits[`${key}MaxTokens` as keyof TierLimits];
  const temperature = limits[`${key}Temperature` as keyof TierLimits];
  let next = options;
  if (typeof maxTokens === 'number' && maxTokens > 0 && (!next.maxTokens || next.maxTokens > maxTokens)) {
    next = { ...next, maxTokens };
  }
  if (typeof temperature === 'number' && next.temperature === undefined) {
    next = { ...next, temperature };
  }
  return next;
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
    costByFeature: {},
    untrackedCostCalls: 0,
    untrackedCostModels: [],
  };

  private tierModels: Map<TierRole, ModelInfo> = new Map();
  /**
   * Tiers the user pinned to a specific model in config (`models.tX` !== 'auto').
   * An explicit pin always wins over Cascade Auto — selectModelForSubtask never
   * re-selects a pinned tier per subtask. (tierModels is also filled with
   * auto-picked defaults, so it alone can't distinguish "pinned" from "default".)
   */
  private explicitTierModels: Set<TierRole> = new Set();
  private config!: CascadeConfig;
  private sessionCostUsd = 0;
  // Per-run accounting for the hard per-task cap. Reset by beginRun() at the
  // start of every `cascade run`, independent of the session-wide budget.
  private runTokens = 0;
  private runCostUsd = 0;
  /**
   * Budget held for calls that are IN FLIGHT — admitted by the preflight check
   * but not yet counted by recordStats. Without these, concurrent calls all
   * measure themselves against the same unspent allowance and are all admitted.
   * Released when each call settles; reset by beginRun() alongside the totals.
   */
  private reservedTokens = 0;
  private reservedCostUsd = 0;
  /**
   * Fires when this run's budget is spent, cancelling work already in flight.
   *
   * The kill switch was previously only a flag, which stops calls that have
   * not yet submitted. A parallel wave's earlier members are already at the
   * provider by then, and they carried on generating for a run whose output
   * would be discarded. Every provider call chains to this, so tripping the
   * ceiling reaches the requests that are running, not just the ones queued.
   */
  private runAbort = newRunAbort();
  /**
   * Bumped by every beginRun(). A release handle remembers the generation it
   * was issued in and does nothing if that has moved on: beginRun() zeroes the
   * counters, so a call still in flight from the previous run would otherwise
   * subtract its estimate from the NEW run's totals and drive them negative —
   * leaving later preflights believing there is more allowance than the cap
   * actually holds, which is worse than no gate at all.
   */
  private runGeneration = 0;
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

  /**
   * Whether the run/session budget is permanently tripped, and why.
   *
   * A tier or worker that catches `BudgetExceededError` internally (T3Worker
   * does, so one dead-end subtask doesn't crash the whole run) absorbs the
   * exception into a normal FAILED/PARTIAL result — the tier returns as if
   * nothing unusual happened. That silently skips `Cascade.run()`'s dedicated
   * budget-exceeded handling (the `run:budget-exceeded` event and
   * `lastInterruptedRun` for `/continue`). This lets a caller check the
   * router's own state directly after a tier returns, regardless of how that
   * tier chose to report the error internally.
   */
  budgetExceededInfo(): { reason: string } | null {
    if (this.runBudgetExceeded) return { reason: this.runBudgetExceededReason ?? 'Per-task budget exceeded.' };
    if (this.budgetState === 'exceeded') return { reason: this.budgetExceededReason ?? 'Session budget exceeded.' };
    return null;
  }
  private tpmLimiter!: TpmLimiter;
  private localQueue!: LocalRequestQueue;
  private taskAnalyzer?: TaskAnalyzer;
  private pendingFeedbackSource?: FeedbackSource;
  /** Models known dead for this account (404 / retired / not enabled). */
  private deadModels = new DeadModelStore();

  /**
   * Back the dead-model memory with durable storage (a JSON file on desktop, a
   * per-user table in the cloud). Without one the verdicts still work, but only
   * for the life of the process — so tomorrow's run pays the same wave of 404s
   * to learn the same fact.
   */
  setDeadModelStore(store: DeadModelStore): void {
    this.deadModels = store;
    this.selector.setDeadModelStore(store);
  }

  /** Models known dead for this account, for `cascade models` and /why. */
  listDeadModels(): ReturnType<DeadModelStore['list']> {
    return this.deadModels.list();
  }

  /** Retry a model the user has since fixed, without waiting out the TTL. */
  forgetDeadModel(provider: string, modelId: string): boolean {
    return this.deadModels.forget(provider, modelId);
  }
  private worldStateDB?: WorldStateDB;
  private privacyPaths?: PrivacyPaths;
  private guidanceQueue?: GuidanceQueue;
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
    this.tpmLimiter = new TpmLimiter(config.rateLimits?.providerTpm ?? {});

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
    //
    // Run discovery directly off the configured baseUrl rather than gating it
    // behind detectAvailableProviders()'s separate isAvailable() probe — that
    // was a second, independent request to the same endpoint, and a flaky or
    // slow first connection there could mark the provider unavailable for the
    // whole session even though this very discovery call succeeds moments
    // later. Availability is now derived from discovery's own result instead.
    const ocConfigs = config.providers.filter((p) => p.type === 'openai-compatible' && p.baseUrl);
    if (ocConfigs.length > 0) {
      const results = await Promise.all(ocConfigs.map((cfg) => this.discoverOpenAICompatibleModels(cfg)));
      if (results.some(Boolean)) this.selector.markProviderAvailable('openai-compatible');
    }

    // Azure deployments are declared in config (there is no discovery endpoint)
    // — register one model per deployment so pickers and per-tier overrides can
    // address them by deployment name. Previously azure existed only as a
    // synthesized seed model with the literal id 'azure', so configured
    // deployments never showed up anywhere.
    //
    // Trust the explicit configuration rather than gating registration on the
    // isAvailable() probe. A user who has entered an endpoint, API key, and
    // deployment name has told us this deployment exists; a flaky or slow probe
    // (cold start, a transient 429, a content-filtered "ping") must not erase
    // their only model and surface downstream as "No model available for tier
    // T1". The probe result stays advisory — a genuinely bad deployment still
    // fails loudly at generate time with the provider's own concrete error,
    // which is far more actionable than a blanket "no model" at startup. This
    // mirrors the openai-compatible discovery above, which likewise derives
    // availability from configuration instead of a separate probe request.
    const azureDeployments = config.providers
      .map((cfg) => azureModelForDeployment(cfg))
      .filter((m): m is ModelInfo => m !== null);
    if (azureDeployments.length > 0) {
      for (const model of azureDeployments) this.selector.addDynamicModel(model);
      // Same shared Set the selector holds — marks azure usable for tier-fill
      // and the "any available model" fallback below.
      availableProviders.add('azure');
    }

    // Validate the official cloud providers against their own model list, so
    // AUTO selection can't pick a bundled catalog id the key doesn't serve (then
    // 404 it and slowly fail over). Best-effort + time-boxed; cached per key.
    await this.validateCloudProviderModels(config);

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
      this.explicitTierModels.add(tier);
      this.ensureProvider(model, config.providers);
    }

    // Azure deployments carry no benchmark data (their ids are opaque
    // deployment names), so the generic fallback used to hand the SAME "first
    // available" deployment to every tier. Instead, rank the configured
    // deployments by an inferred capability score from their names and spread
    // them across tiers — strongest to T1, cheapest to T3 — so a multi-deployment
    // Azure setup actually uses each deployment. A single deployment ranks alone,
    // so it correctly fills all three tiers.
    const azureRanked = [...azureDeployments]
      .sort((a, b) => inferModelCapability(b.id) - inferModelCapability(a.id));

    // Fill any tiers without explicit overrides.
    for (const tier of ['T1', 'T2', 'T3'] as TierRole[]) {
      if (this.tierModels.has(tier)) continue;
      // 1. A benchmarked model from the tier's priority chain wins when present.
      // 2. Otherwise, the rank-appropriate Azure deployment for this tier.
      // 3. Otherwise, the generic "any available model" fallback.
      const model =
        this.selector.getCandidatesForTier(tier)[0]
        ?? (azureRanked.length ? azureModelForTier(tier, azureRanked) : undefined)
        ?? this.selector.selectForTier(tier);
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
   * One-time native tool-call probe for local/compat models with NO capability
   * metadata. llama.cpp / LM Studio "/models" endpoints return ids only, so
   * `supportsToolUse` stays undefined and the T3 tool gate ASSUMES native
   * support — wrong for many local builds, which then fumble tool-format
   * output. Each unknown model is probed once with a trivial tool; the verdict
   * persists in the MemoryStore's model_cache (via the previously-dormant
   * getModelProfile read-back), so a model is probed once EVER, not per run.
   * Cloud providers are never probed — their metadata is authoritative.
   */
  async probeLocalToolSupport(store: MemoryStore): Promise<void> {
    const unknown = this.selector.getAllAvailableModels().filter(
      (m) => m.provider === 'openai-compatible' && m.supportsToolUse === undefined,
    );
    for (const model of unknown) {
      const cached = store.getModelProfile(model.id, model.provider);
      let verdict = cached?.supportsToolUse;
      if (verdict === undefined) {
        const probed = await this.probeNativeToolCall(model);
        if (probed === null) continue; // transport error — retry next start
        verdict = probed;
        store.saveModelCapability(model.id, model.provider, { supportsToolUse: verdict });
      }
      this.selector.addDynamicModel({ ...model, supportsToolUse: verdict });
    }
    // Refresh resolved tier models so the tool-use gate sees the verdicts.
    for (const tier of ['T1', 'T2', 'T3'] as TierRole[]) {
      const cur = this.tierModels.get(tier);
      if (!cur) continue;
      const fresh = this.selector.getModelById(cur.id);
      if (fresh) this.tierModels.set(tier, fresh);
    }
  }

  private async probeNativeToolCall(model: ModelInfo): Promise<boolean | null> {
    try {
      const cfg = this.config.providers.find((p) => p.type === model.provider) ?? { type: model.provider };
      // Direct provider call, NOT this.generate(): failover there could silently
      // answer from a different model and record a wrong verdict.
      const provider = this.createProvider(cfg as ProviderConfig, model);
      // Aborting, like every other billable call: a probe that times out
      // should stop, not keep generating in the background on the user's key.
      const result = await withTimeoutAbort((signal) => provider.generate({
        messages: [{ role: 'user', content: "Call the echo tool with text set to 'ping'. Use the tool; do not answer in prose." }],
        tools: [{
          name: 'echo',
          description: 'Echo the given text back to the caller.',
          inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] },
        }],
        maxTokens: 80,
        temperature: 0,
        signal,
      }), 30_000, 'tool-support probe timed out');
      return (result.toolCalls?.length ?? 0) > 0;
    } catch {
      return null;
    }
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
        cacheFile: benchCfg.cacheFile,
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
   * Validate the official cloud providers (anthropic/openai/gemini) against
   * their own /models list at init time so AUTO selection only picks a model the
   * key actually serves. This is the fix for "a non-existent catalog model gets
   * selected, then the run fails over through several models before one works".
   * Cached per key (TTL) so a per-request router doesn't re-discover; fully
   * best-effort + time-boxed, so offline/error simply keeps the bundled catalog.
   */
  private async validateCloudProviderModels(config: CascadeConfig): Promise<void> {
    const providers: ProviderType[] = ['anthropic', 'openai', 'gemini'];
    await Promise.all(providers.map(async (type) => {
      if (!this.selector.isProviderAvailable(type)) return;
      const cfg = config.providers.find((p) => p.type === type);
      if (!cfg?.apiKey) return;
      const cacheKey = discoveryCacheKey(type, cfg);
      let entry = cloudDiscoveryCache.get(cacheKey);
      if (!entry || Date.now() - entry.at > DISCOVERY_TTL_MS) {
        const seed = this.getAnyModelForProvider(type);
        if (!seed) return;
        try {
          const provider = this.createProvider(cfg, seed);
          if (typeof provider.listModels !== 'function') return;
          const models = await withTimeout(provider.listModels(), DISCOVERY_TIMEOUT_MS, `${type} model discovery timed out`);
          if (!models.length) return; // empty/unreachable → keep the static catalog
          entry = { models, ids: models.map((m) => m.id), at: Date.now() };
          cloudDiscoveryCache.set(cacheKey, entry);
        } catch {
          return; // best-effort — offline/error leaves today's behaviour intact
        }
      }
      for (const m of entry.models) this.selector.addDynamicModel(m);
      this.selector.setValidatedModels(type, entry.ids);
    }));
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
   * Replace available models with live-priced AND capability-corrected copies
   * (real context windows, native tool support, vision from modalities), then
   * refresh the already resolved tier models so shared-tier cost accounting and
   * the tool-use gate both see current data.
   */
  private applyLivePricing(): void {
    if (!this.liveData) return;
    if (!this.liveData.hasLivePricing() && !this.liveData.hasCapabilities()) return;
    let updated = this.selector.getAllAvailableModels();
    if (this.liveData.hasLivePricing()) updated = this.liveData.applyLivePricing(updated);
    if (this.liveData.hasCapabilities()) updated = this.liveData.applyLiveCapabilities(updated);
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

    // ── Pin this call to the run it starts in ─────────────────
    //
    // A run can end and the next one begin while this call is still in flight:
    // beginRun() swaps the generation, the abort controller and the per-run
    // counters together, and setRunSignal() replaces the cancel signal. Every
    // read below happens after at least one await, so reading the fields
    // directly would have a straggler consult the NEXT run's state — chaining
    // to its abort signal, charging its allowance, and cancelling its wave on a
    // verdict about a run that is already over. Captured once, here, before the
    // first await.
    const runGeneration = this.runGeneration;
    const runAbort = this.runAbort;
    const runSignal = this.runSignal;

    // ── Apply per-tier token + temperature limits ──────────────
    options = applyTierLimits(options, tier, this.config?.tierLimits);
    // Inject the run's abort signal so the provider can abort the in-flight
    // request the moment a cancel fires (instant cancellation).
    if (runSignal && !options.signal) {
      options = { ...options, signal: runSignal };
    }
    // Per-call override (Cascade Auto per-subtask routing) wins over the shared
    // tier model, except when a vision model is explicitly required.
    if (options.model && !requireVision) {
      this.ensureProvider(options.model, this.config.providers);
    }
    // Resolve the model for this call. When a tier was never filled during init
    // (e.g. an availability probe was inconclusive at startup), fall back to the
    // selector's live "any available model" pick rather than hard-failing — a
    // single configured deployment should be able to serve every tier.
    let model = requireVision
      ? this.selector.selectVisionModel()
      : (options.model ?? this.tierModels.get(tier) ?? this.selector.selectForTier(tier) ?? undefined);

    // A vision-required call can resolve to a live-discovered model (e.g. an
    // openai-compatible endpoint's /models entry) that was never bound to a BaseProvider
    // instance anywhere else — unlike the options.model override above
    // (bound just before this block) or a tier-fill winner (bound during
    // init()). Without this, getProvider(model) below returns undefined for
    // exactly that case and the call throws "No provider for model ...".
    // ensureProvider() is a no-op if a provider is already bound.
    if (requireVision && model) {
      this.ensureProvider(model, this.config.providers);
    }

    // Privacy tier: a local-only subtask must NEVER reach a cloud provider.
    // Swap to a private model when the resolved one isn't; hard-error rather
    // than silently falling back to cloud when no private model exists.
    if (options.forceLocal && model && !this.isPrivateModel(model)) {
      const localModel = this.selector.getAllAvailableModels().find((m) => this.isPrivateModel(m));
      if (!localModel) {
        throw new Error(
          'privacy.paths: this subtask touches a local-only path but no LOCAL model is available. ' +
          'Configure Ollama or an OpenAI-compatible endpoint on a loopback/private host, or remove the privacy policy.',
        );
      }
      this.ensureProvider(localModel, this.config.providers);
      model = localModel;
    }

    if (!model) throw new Error(`No model available for tier ${tier}`);

    const provider = this.getProvider(model);
    if (!provider) throw new Error(`No provider for model ${model.id}`);

    // Refuse a call whose INPUT alone cannot fit the remaining budget, before
    // spending it. Placed ahead of the TPM wait: there is no point queueing for
    // provider capacity on a call we are about to decline.
    //
    // Returns a release handle: the estimate is RESERVED against the budget
    // until the call settles, so concurrent calls cannot each be admitted
    // against the same unspent allowance.
    let releaseReservation: (() => void) | undefined = this.enforcePreflightBudget(model, options);

    // Per-provider TPM guard: pause this call until the token bucket has
    // enough budget to cover the estimated input+output tokens. Prevents
    // sudden bursts of parallel T3 spawns from overshooting a provider's
    // tokens-per-minute quota. Capped at model.maxOutputTokens: a provider can
    // silently clamp an explicit options.maxTokens down to a real per-request
    // cap well below what a tier asked for (T1's final compilation step asks
    // for 8,000, which not every endpoint will serve) — invisible to this
    // estimate otherwise — so reserving the UNCLAMPED value would withdraw far
    // more than the call can ever actually consume.
    const requestedTokens = options.maxTokens ?? model.maxOutputTokens ?? 1024;
    const estimatedTokens = Math.min(requestedTokens, model.maxOutputTokens ?? requestedTokens) + 512;
    if (this.tpmLimiter) {
      // Cancellable, on every signal that can make this call pointless — not
      // just the budget one. The bucket can hold a call for most of a refill
      // interval, and in that window the run can be cancelled, the wave
      // respawned (T2 aborts its own per-wave signal to do that), or the
      // ceiling tripped by a sibling. Watching only the router's controller
      // left an ordinary cancel parked here for up to a minute, because
      // nothing but the budget aborts that one.
      const wait = anySignal([options.signal, runAbort.signal]);
      try {
        await this.tpmLimiter.acquire(model.provider, estimatedTokens, wait.signal);
      } catch (err) {
        // The reservation is taken above and the try/finally that frees it does
        // not start until below, so bailing out here would strand it for the
        // rest of the run — shrinking every later call's allowance over a
        // request that was never submitted anywhere.
        releaseReservation?.();
        throw this.asAbortFailure(err, options.signal, runSignal);
      } finally {
        wait.release();
      }
    }

    const useStream = Boolean(onChunk) && model.supportsStreaming && typeof provider.generateStream === 'function';

    // Serialize requests to local providers (e.g. Ollama) to prevent GPU VRAM
    // pressure when multiple T3 workers run in parallel on a single-GPU machine.
    let releaseLocalSlot: (() => void) | undefined;
    if (model.isLocal) {
      const inferenceTimeoutMs = this.config.localInferenceTimeoutMs ?? 300_000;
      // Allow up to half the inference timeout to wait in the queue itself.
      const queueWaitMs = Math.round(inferenceTimeoutMs / 2);
      // Same reasoning as the rate-limit wait, and a longer window to be stuck
      // in: with the default concurrency of 1 this holds a call for up to 150
      // seconds, and until the signal was wired through, neither a cancel nor
      // a spent budget got it out — it waited for a slot it would drop the
      // instant it was given one.
      const wait = anySignal([options.signal, runAbort.signal]);
      try {
        releaseLocalSlot = await this.localQueue.acquire(queueWaitMs, wait.signal);
      } catch (err) {
        // The reservation is taken above but the try/finally that frees it does
        // not start until below, so a queue timeout here used to strand it for
        // the rest of the run — shrinking every later call's allowance, and
        // eventually tripping the budget flag, over a request that was never
        // submitted to anything.
        releaseReservation?.();
        throw this.asAbortFailure(err, options.signal, runSignal);
      } finally {
        wait.release();
      }
    }

    try {
      // Re-checked HERE, not only at the top of this method. Between that
      // check and this point a call can sit for a long time in the TPM bucket
      // or the local-inference queue, and a SIBLING in the same T3 wave can
      // trip the per-task ceiling while it waits. Without this, every call
      // already admitted goes on to submit and spend against a run that is
      // already over and whose output will be discarded — which is most of a
      // wave, and most of the cap. Throwing inside the try releases both the
      // reservation and the queue slot on the way out.
      //
      // Read only while this call's run is still the current one: after
      // beginRun() the flag describes a DIFFERENT run, and refusing a
      // straggler because the next task's budget is spent — or letting one
      // through because it is not — are both wrong answers to a question
      // about the wrong run.
      if (runGeneration === this.runGeneration && this.runBudgetExceeded) {
        // Hand the rate-limit capacity back. acquire() already deducted it,
        // and the bucket outlives beginRun() — keeping tokens that were never
        // spent would throttle the NEXT run for up to a refill interval over a
        // request that was never submitted.
        this.tpmLimiter?.refund(model.provider, estimatedTokens);
        throw new CascadeRouter.BudgetExceededError(
          this.runBudgetExceededReason ?? 'Per-task budget exceeded.',
        );
      }

      let result: GenerateResult;

      // Every provider call below is time-boxed with withTimeoutAbort, which
      // CANCELS the request when the clock runs out instead of merely racing
      // it. Providers all honour options.signal already; nothing was handing
      // them one. That is what made a timed-out request keep generating and
      // keep billing with its usage never reported — and what the abandoned
      // attempt accounting, the retry preflight and the second reservation all
      // existed to paper over. Those are gone: the first request is on its way
      // down before the fallback starts.
      if (model.isLocal) {
        // Apply a hard timeout to local inference calls so a slow/overloaded
        // model doesn't block the worker indefinitely.
        const inferenceTimeoutMs = this.config.localInferenceTimeoutMs ?? 300_000;
        result = await withTimeoutAbort(
          (signal) => (useStream && onChunk
            ? provider.generateStream({ ...options, signal }, (chunk) => {
                const text = typeof chunk?.text === 'string' ? chunk.text : '';
                if (text) onChunk({ ...chunk, text });
              })
            : provider.generate({ ...options, signal })),
          inferenceTimeoutMs,
          `Local model ${model.id} inference timed out after ${inferenceTimeoutMs}ms`,
          [options.signal, runAbort.signal],
        );
      } else if (useStream && onChunk) {
        // Cloud streaming MUST be time-boxed: a stalled SSE connection (TCP open,
        // no terminal chunk) would otherwise hang the whole run with no output.
        const cloudTimeoutMs = this.config.cloudInferenceTimeoutMs ?? 120_000;
        try {
          result = await withTimeoutAbort(
            (signal) => provider.generateStream({ ...options, signal }, (chunk) => {
              const text = typeof chunk?.text === 'string' ? chunk.text : '';
              if (text) onChunk({ ...chunk, text });
            }),
            cloudTimeoutMs,
            `Model ${model.id} stream timed out after ${cloudTimeoutMs}ms`,
            [options.signal, runAbort.signal],
          );
        } catch (streamErr) {
          // Cancelled mid-stream — propagate the abort, don't retry.
          if ((streamErr instanceof Error && streamErr.name === 'AbortError') || runSignal?.aborted || options.signal?.aborted) {
            throw streamErr;
          }
          // Stream stalled or errored — fall back to a (also time-boxed)
          // non-streaming call rather than letting a hung stream freeze the run.
          // The stalled attempt has been aborted by now, so this is the only
          // request in flight and the reservation taken above still covers it.
          result = await withTimeoutAbort(
            (signal) => provider.generate({ ...options, signal }),
            cloudTimeoutMs,
            `Model ${model.id} inference timed out after ${cloudTimeoutMs}ms`,
            [options.signal, runAbort.signal],
          );
        }
      } else {
        const cloudTimeoutMs = this.config.cloudInferenceTimeoutMs ?? 120_000;
        result = await withTimeoutAbort(
          (signal) => provider.generate({ ...options, signal }),
          cloudTimeoutMs,
          `Model ${model.id} inference timed out after ${cloudTimeoutMs}ms`,
          [options.signal, runAbort.signal],
        );
      }

      // Recompute against the ROUTER's view of the model (which carries dataset
      // pricing the provider instance may not have), and carry the
      // unknown-price flag through with it — dropping it here would turn an
      // untracked call back into a $0.00 one.
      const corrected = buildTokenUsage(
        result.usage.inputTokens,
        result.usage.outputTokens,
        model,
      );

      result = {
        ...result,
        usage: {
          ...result.usage,
          estimatedCostUsd: corrected.estimatedCostUsd,
          ...(corrected.costUnknown ? { costUnknown: true } : { costUnknown: undefined }),
        },
      };

      if (!result || typeof result.content !== 'string' || !result.usage) {
        throw new Error(`Provider ${model.provider}:${model.id} returned an invalid generation result.`);
      }

      // Add to tracking
      this.recordStats(tier, model, result.usage, options.featureTag, runGeneration);
      // On success, signal the failover manager so that a provider which
      // previously tripped a rate-limit can be immediately re-enabled rather
      // than waiting the full backoff window to expire.
      this.failover.recordSuccess(model.provider);
      return result;
    } catch (err) {
      // A budget abort also cancels the in-flight request, but it is NOT a
      // user cancellation: it must keep saying it ran out of budget, or the
      // reason the run stopped is lost on the way up. Checked first, because
      // the abort below would otherwise swallow it.
      if (err instanceof CascadeRouter.BudgetExceededError) throw err;
      // A cancelled run aborts the in-flight provider request. Surface it as a
      // cancellation so it propagates like the checkpoint-based cancel (graceful
      // stop + partial output upstream) rather than being retried/failed-over.
      if ((err instanceof Error && err.name === 'AbortError') || runSignal?.aborted || options.signal?.aborted) {
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
          // Same reasoning for the budget reservation: the retry re-runs the
          // preflight and reserves for itself, so holding this one across it
          // would charge the run twice for one logical call and could refuse a
          // failover that fits.
          releaseReservation?.();
          releaseReservation = undefined;
          // Clear a per-subtask pin (Cascade Auto's explicit `options.model`)
          // that pointed at the now-rate-limited model — otherwise the
          // recursive call's `options.model ?? this.tierModels.get(tier)`
          // resolves right back to the pin, ignoring the fallback just bound
          // above and re-hitting the same rate-limited provider. Same fix
          // already applied to the model-not-found branch below.
          const retryOpts = options.model && options.model.id === model.id
            ? { ...options, model: undefined }
            : options;
          return this.generate(tier, retryOpts, onChunk, requireVision);
        }
      }
      // Stale / invalid model id (e.g. a retired preview that 404s). Drop it so
      // it is never selected again this session and fail over to the next
      // candidate, instead of surfacing the raw provider error to the user.
      if (isModelNotFoundError(errMsg)) {
        this.selector.removeModel(model.id);
        // Persist the verdict so the next run doesn't pay to rediscover it.
        // `record` reports only the FIRST sighting as new — a concurrent T3
        // wave all hits the same dead id at once, and the user should see one
        // line, not one per worker.
        const firstSighting = this.deadModels.record(model.provider, model.id, errMsg);
        if (firstSighting) this.emit('model:dead', { provider: model.provider, modelId: model.id, reason: errMsg });
        // Cap the not-found chain: up-front validation should mean this rarely
        // fires, but a stale catalog with many dead ids must not walk them all.
        const depth = ((options as GenerateOptions & { _notFoundDepth?: number })._notFoundDepth ?? 0) + 1;
        const next = depth <= 3 ? this.selector.selectForTier(tier) : null;
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
          // Same reasoning for the budget reservation: the retry re-runs the
          // preflight and reserves for itself, so holding this one across it
          // would charge the run twice for one logical call and could refuse a
          // failover that fits.
          releaseReservation?.();
          releaseReservation = undefined;
          // Clear a per-subtask override that pointed at the dead model so the
          // recursive call resolves the tier's next-best model, and carry the
          // depth so the chain is bounded.
          const base = options.model && options.model.id === model.id
            ? { ...options, model: undefined }
            : options;
          const retryOpts = { ...base, _notFoundDepth: depth } as GenerateOptions;
          return this.generate(tier, retryOpts, onChunk, requireVision);
        }
      }
      throw err;
    } finally {
      releaseLocalSlot?.();
      // Actual usage has been recorded by now (recordStats on the success
      // path), so the reservation must go or it would double-count against
      // every later call in the run.
      releaseReservation?.();
      releaseReservation = undefined;
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

  /** Project-knowledge settings (config.knowledge). Facts extraction on by default. */
  getKnowledgeConfig(): { factsExtraction: boolean } {
    return { factsExtraction: this.config?.knowledge?.factsExtraction !== false };
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

  /**
   * The tightest context window (in tokens) across the resolved tier models, or
   * undefined if none are resolved yet. Extended-context compaction budgets
   * against this so the compacted context fits whichever tier handles the run.
   */
  getReferenceContextWindow(): number | undefined {
    const windows = [...this.tierModels.values()]
      .map((m) => m.contextWindow)
      .filter((n) => typeof n === 'number' && n > 0);
    return windows.length ? Math.min(...windows) : undefined;
  }

  /** Wire the Cascade Auto task analyzer used for per-subtask model routing. */
  /**
   * Feed per-model thumbs counts into Auto routing. Forwarded to the analyzer
   * because that is where the public benchmark score is combined; the prior
   * adjusts that number rather than sitting anywhere else in the pipeline.
   */
  setFeedbackSource(source: FeedbackSource): void {
    this.taskAnalyzer?.setFeedbackSource(source);
    this.pendingFeedbackSource = source;
  }

  setTaskAnalyzer(analyzer: TaskAnalyzer): void {
    this.taskAnalyzer = analyzer;
    // Ordering between setFeedbackSource and setTaskAnalyzer is not guaranteed
    // by callers, so a source supplied first is applied on arrival.
    if (this.pendingFeedbackSource) analyzer.setFeedbackSource(this.pendingFeedbackSource);
  }

  setWorldStateDB(db: WorldStateDB | undefined): void {
    this.worldStateDB = db;
  }

  getWorldStateDB(): WorldStateDB | undefined {
    return this.worldStateDB;
  }

  setPrivacyPaths(paths: PrivacyPaths | undefined): void {
    this.privacyPaths = paths;
  }

  getPrivacyPaths(): PrivacyPaths | undefined {
    return this.privacyPaths;
  }

  setGuidanceQueue(queue: GuidanceQueue | undefined): void {
    this.guidanceQueue = queue;
  }

  getGuidanceQueue(): GuidanceQueue | undefined {
    return this.guidanceQueue;
  }

  /**
   * "Private" = inference never leaves the user's machine/network: Ollama
   * models (isLocal), or an OpenAI-compatible endpoint (e.g. llama.cpp, vLLM,
   * LM Studio) whose configured host is loopback or a private range. A cloud
   * OpenAI-compatible endpoint (public host) does NOT qualify.
   */
  private isPrivateModel(model: ModelInfo): boolean {
    if (model.isLocal) return true;
    if (model.provider !== 'openai-compatible') return false;
    const baseUrl = this.config?.providers?.find((p) => p.type === 'openai-compatible')?.baseUrl;
    if (!baseUrl) return false;
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
        || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || host.endsWith('.local');
    } catch {
      return false;
    }
  }

  /**
   * Cascade Auto per-subtask routing: pick the benchmark-best model for a
   * specific subtask's text, scoped to the tier's eligible candidates. Returns
   * null when Cascade Auto is off (callers then use the shared tier model).
   * Pure heuristic — no extra LLM call.
   */
  async selectModelForSubtask(tier: TierRole, text: string, opts?: { requiresToolUse?: boolean }): Promise<ModelInfo | null> {
    // An explicit per-tier pin always wins over Cascade Auto — the user chose
    // that exact model for this tier, so never re-select it per subtask.
    if (this.explicitTierModels.has(tier)) return this.tierModels.get(tier) ?? null;
    if (!this.config?.cascadeAuto || !this.taskAnalyzer || !text.trim()) return null;
    try {
      return await this.taskAnalyzer.selectModel(text, tier, this.selector, opts);
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
      costByFeature: { ...this.stats.costByFeature },
      untrackedCostCalls: this.stats.untrackedCostCalls,
      untrackedCostModels: [...this.stats.untrackedCostModels],
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
      costByFeature: {},
      untrackedCostCalls: 0,
      untrackedCostModels: [],
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

  /**
   * Every model available across the configured + reachable providers, after
   * discovery (Ollama tags, OpenAI-compatible/llama.cpp models, cloud catalog).
   * Used to populate the desktop model pickers with the user's real models.
   */
  getAvailableModels(): ModelInfo[] {
    return this.selector?.getAllAvailableModels() ?? [];
  }

  // ── Private ──────────────────────────────────

  /**
   * Why each configured provider failed its availability probe, kept so the
   * surfaces can say something better than "add an API key" to a user who
   * already has one. Cleared and refilled by each detectAvailableProviders().
   */
  private probeFailures = new Map<ProviderType, string>();

  /**
   * What stopped the configured providers from being usable, if anything.
   * Empty when every configured provider passed — or when none was configured,
   * which is a different problem with a different answer.
   */
  providerProbeFailures(): Array<{ provider: ProviderType; reason: string }> {
    return [...this.probeFailures].map(([provider, reason]) => ({ provider, reason }));
  }

  /** Logs why a configured provider failed its availability probe. */
  private emitProbeFailure(type: ProviderType, reason: string): void {
    this.probeFailures.set(type, reason);
    console.warn(`[router] provider "${type}" is not available: ${reason}`);
  }

  private async detectAvailableProviders(
    configs: ProviderConfig[],
  ): Promise<Set<ProviderType>> {
    const available = new Set<ProviderType>();
    this.probeFailures.clear();

    const checks = configs.map(async (cfg) => {
      try {
        const testModel = this.getAnyModelForProvider(cfg.type);
        if (!testModel) return;
        const provider = this.createProvider(cfg, testModel);
        const ok = await provider.isAvailable();
        if (ok) available.add(cfg.type);
        else this.emitProbeFailure(cfg.type, 'availability check returned false (bad key, wrong endpoint/deployment, or unreachable)');
      } catch (err) {
        // Don't silently drop the provider — a swallowed probe error is exactly
        // why a misconfigured Azure deployment surfaced only as the downstream
        // "No model available for tier T3". Log the concrete reason.
        this.emitProbeFailure(cfg.type, err instanceof Error ? err.message : String(err));
      }
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

  /** Returns true when at least one real model was discovered from the endpoint. */
  private async discoverOpenAICompatibleModels(cfg: ProviderConfig): Promise<boolean> {
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
      return models.length > 0;
    } catch (err) {
      console.warn('[router] OpenAI-compatible model discovery failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private ensureProvider(model: ModelInfo, configs: ProviderConfig[]): void {
    const key = `${model.provider}:${model.id}`;
    if (this.providers.has(key)) return;

    // Azure supports multiple deployments, each its own resource/endpoint/key —
    // the model's id IS the deployment name, so bind the matching config entry
    // (find-first would silently route every deployment to the first resource).
    const cfg = (model.provider === 'azure'
      ? configs.find((c) => c.type === 'azure' && c.deploymentName === model.id)
      : undefined)
      ?? configs.find((c) => c.type === model.provider)
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
    // openai-compatible and azure have NO fixed catalog entry — both are
    // configured per-endpoint, so their real ids exist only at the endpoint the
    // user pointed at. Without a seed model `detectAvailableProviders` skipped
    // them entirely — so an OpenAI-compatible (e.g. llama.cpp) provider was never
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

  /**
   * `runGeneration` is the generation the call was ADMITTED in — see
   * `generate()`. Session-wide accounting always applies (the spend is real
   * whenever it lands), but the per-RUN ceiling is only meaningful for the run
   * the call belongs to, so a straggler from a finished run is left out of it.
   * Omitted by the direct callers in tests, which have no run to straddle.
   */
  private recordStats(
    tier: TierRole,
    model: ModelInfo,
    usage: TokenUsage,
    featureTag?: string,
    runGeneration?: number,
  ): void {
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

    if (featureTag) {
      this.stats.costByFeature[featureTag] = (this.stats.costByFeature[featureTag] ?? 0) + usage.estimatedCostUsd;
    }

    // ── Untracked spend ──────────────────────────
    // A call on a model with no known price contributes $0 to every total
    // above. That is not free money: it is money we cannot count, and it means
    // a cost cap can never be tripped by this model. Record it, and say so out
    // loud the first time it happens while a cost cap is configured — silently
    // under-reporting spend is precisely what a budget ceiling exists to stop.
    if (usage.costUnknown) {
      this.stats.untrackedCostCalls += 1;
      if (!this.stats.untrackedCostModels.includes(model.id)) {
        this.stats.untrackedCostModels.push(model.id);
        const capped =
          this.config?.budget?.maxCostPerRunUsd != null ||
          this.config?.budget?.sessionBudgetUsd != null;
        this.emit('cost:untracked', {
          modelId: model.id,
          provider: model.provider,
          reason: capped
            ? `No published price for ${model.provider}:${model.id}. Its spend is not counted toward your cost budget — the token cap still applies. Add it to the pricing dataset, or set the provider's \`local: true\` if this endpoint really is free.`
            : `No published price for ${model.provider}:${model.id}. Cost for this model is reported as "not tracked" rather than $0.00.`,
        });
      }
    }

    // ── Per-run accounting (hard per-task ceiling) ──
    //
    // Skipped for a call admitted under a PREVIOUS run. beginRun() zeroes
    // runTokens/runCostUsd for the new task, so adding a straggler's usage
    // charges the old run's spend to the new run's allowance — and worse, if
    // that pushes it over, enforceRunBudget() aborts `this.runAbort`, which is
    // now the NEW run's controller, cancelling a wave of work that has nothing
    // to do with the call that just returned. Same class of bug as the
    // reservation release handles, and scoped the same way.
    //
    // Everything above this line is session-wide and is recorded either way:
    // the money left the account whichever run asked for it, and the session
    // cap must not be escapable by crossing a task boundary.
    const currentRun = runGeneration === undefined || runGeneration === this.runGeneration;
    if (currentRun) {
      this.runTokens += usage.totalTokens;
      this.runCostUsd += usage.estimatedCostUsd;
    }

    // ── Budget enforcement & warning (atomic state transitions) ─
    this.updateBudgetState();
    if (currentRun) this.enforceRunBudget();
  }

  /**
   * Resets per-run accounting at the start of each `cascade run`. Session
   * totals and a session-wide budget halt are deliberately preserved; only the
   * per-task ceiling is cleared so the next task starts with a fresh allowance.
   */
  beginRun(): void {
    this.runTokens = 0;
    this.runCostUsd = 0;
    // A run that ended mid-flight (cancelled, crashed) can leave a reservation
    // behind; starting the next one with it still held would shrink that run's
    // allowance for no reason.
    this.reservedTokens = 0;
    this.reservedCostUsd = 0;
    // A fresh switch: the previous run's abort must not cancel this one's work.
    this.runAbort = newRunAbort();
    // Invalidates every release handle the previous run handed out.
    this.runGeneration++;
    this.runBudgetExceeded = false;
    this.runBudgetExceededReason = undefined;
  }

  /**
   * Refuse a call whose input alone cannot fit what is left of the run budget.
   *
   * `enforceRunBudget()` below runs AFTER a call returns, which makes the caps
   * a stop rather than a pre-authorisation: the tokens are already bought by
   * the time it looks. That was tolerable while a prompt could not exceed
   * 20,000 characters, and stopped being so when that cap was removed in
   * 0.72.0 — a multi-megabyte prompt is billed in full on the very first call
   * (the complexity classifier sends the whole thing), and no ceiling
   * configured downstream can give that money back.
   *
   * Deliberately narrow, because a false refusal is worse than a late stop:
   *
   *   • INPUT ONLY. What a call returns is not knowable in advance, and
   *     charging a worst-case `maxTokens` of output against the budget would
   *     decline runs that would have finished comfortably. Input is the part
   *     that is already determined, and it is the part the removed cap used to
   *     bound.
   *   • Compared against what REMAINS (`cap - spent`), not the whole cap, so a
   *     call is judged on the budget it can actually draw from.
   *   • Skipped when the model has no usable price. An estimate cannot be made,
   *     and refusing on ignorance would break every self-hosted and local model
   *     the moment a cost cap is set. The post-hoc stop still applies there.
   *   • Skipped entirely when no cap is configured — there is nothing to
   *     pre-authorise against.
   *
   * The message names the cap AND the estimate, because "too expensive" with
   * no numbers gives the user nothing to change.
   */
  private enforcePreflightBudget(
    model: ModelInfo,
    options: GenerateOptions,
  ): (() => void) | undefined {
    const budget = this.config?.budget;
    const maxCost = budget?.maxCostPerRunUsd;
    const maxTokens = budget?.maxTokensPerRun;
    if (maxCost == null && maxTokens == null) return undefined;

    const inputTokens = this.estimateInputTokens(options, model);

    if (maxTokens != null) {
      // Against spent AND reserved — see the reservation note below.
      const remaining = maxTokens - this.runTokens - this.reservedTokens;
      if (inputTokens > remaining) {
        this.failPreflight(
          `This request's input is about ${inputTokens.toLocaleString()} tokens, but only `
          + `${Math.max(0, remaining).toLocaleString()} of the per-task cap of `
          + `${maxTokens.toLocaleString()} remain. Shorten the input, or raise `
          + 'budget.maxTokensPerRun.',
        );
      }
    }

    let estimatedUsd = 0;
    if (maxCost != null) {
      // Priced at the CONTEXT BAND this input lands in. Several long-context
      // models charge more past a threshold, and resolving the cheapest band
      // unconditionally under-estimated exactly the large calls this check
      // exists to catch.
      const { input: inputPer1k, unknown } = resolveModelPricing(model, { inputTokens });
      if (!unknown && inputPer1k > 0) {
        estimatedUsd = (inputTokens / 1000) * inputPer1k;
        const remaining = maxCost - this.runCostUsd - this.reservedCostUsd;
        if (estimatedUsd > remaining) {
          this.failPreflight(
            `Sending this request to ${model.provider}:${model.id} would cost about `
            + `$${estimatedUsd.toFixed(4)} in input alone (~${inputTokens.toLocaleString()} tokens), `
            + `and only $${Math.max(0, remaining).toFixed(4)} of the per-task cap of `
            + `$${maxCost.toFixed(4)} remains. Shorten the input, choose a cheaper model, `
            + 'or raise budget.maxCostPerRunUsd.',
          );
        }
      }
    }

    // ── Reserve until this call settles ──
    //
    // Checking against spent-so-far alone is a time-of-check/time-of-use hole
    // the common case walks straight into: T2 launches a T3 wave through
    // Promise.allSettled, so every call in it reaches this check before any
    // response has updated runCostUsd. Each would see the same untouched
    // allowance, all would be admitted, and the run would bill several times
    // the cap before the post-hoc stop noticed. Holding the estimate against
    // the budget for the duration of the call makes the wave queue behind
    // itself instead.
    this.reservedTokens += inputTokens;
    this.reservedCostUsd += estimatedUsd;
    const generation = this.runGeneration;
    let released = false;
    return () => {
      // A handle from a previous run refunds nothing: beginRun() already
      // zeroed the counters it was drawn against.
      if (released || generation !== this.runGeneration) return;
      released = true;
      this.reservedTokens -= inputTokens;
      this.reservedCostUsd -= estimatedUsd;
    };
  }

  /**
   * What this call will send, in tokens.
   *
   * Text is the bulk of it, but not all of it: providers bill the serialized
   * TOOL DEFINITIONS on every native-tool call (Anthropic sends each name,
   * description and input schema), and an image is billed by its own size
   * rather than as the `[image]` placeholder `contentToText` reduces it to. A
   * tool-heavy or vision request could therefore pass either cap while its real
   * input already exceeded the allowance.
   */
  private estimateInputTokens(options: GenerateOptions, model: ModelInfo): number {
    let tokens = guardTokens(options.systemPrompt ?? '');
    let images = 0;

    // What the PROVIDER will send, not what the caller passed. Every provider
    // drops, rewrites or duplicates some of a request on the way out, and the
    // differences are large enough to matter in both directions: charging for
    // content that is discarded refuses runs that would have completed, and
    // skipping content that is sent leaves the cap unenforced. The rules live
    // in wire-profile.ts, derived by reading each serializer end to end.
    const wire = wireProfile(model.provider);
    const countsImage = (img: { type?: string } | undefined): boolean =>
      wire.sendsUrlImages || img?.type === 'base64';

    for (const message of options.messages) {
      if (wire.dropsMessage(message)) continue;
      tokens += TOKENS_PER_MESSAGE_FRAMING;
      if (typeof message.content === 'string') {
        tokens += guardTokens(message.content);
      } else {
        switch (wire.blockHandling(message)) {
          case 'blocks':
            for (const block of message.content) {
              // A block type the conversion has no branch for is dropped —
              // a tool_result block in a user turn is the real case, and
              // contentToText expands its whole payload, so charging it
              // refused runs over data no provider submits.
              if (!wire.sendsBlock(block)) continue;
              if (block.type === 'image') {
                if (countsImage(block.image)) images++;
                continue;
              }
              tokens += guardTokens(contentToText([block]));
            }
            break;
          case 'stringified':
            // JSON.stringify()d whole — an image block's base64 payload goes
            // on the wire in full, so it is charged by its real size rather
            // than the flat per-image rate.
            tokens += guardTokens(safeJson(message.content));
            break;
          case 'dropped':
            // Reduced to '' by the provider: neither the text blocks nor the
            // images reach the request, so none of it is billed. The turn
            // itself is still sent, so its framing stands.
            break;
        }
      }
      // An assistant turn's TOOL CALLS are not in `content` — they are a
      // separate field, and providers serialize them back into the next
      // request. After a model emitted a large argument object, the following
      // call passed preflight without reserving a byte of it.
      //
      // Sized in the provider's own envelope, like the tool definitions above.
      // Cascade's normalized `{id,name,input}` is nobody's wire format: OpenAI
      // serializes `input` to a string and embeds it, so every quote inside is
      // escaped twice over, while Gemini drops the id entirely. Across a long
      // tool-using history that difference runs to thousands of tokens.
      if (message.toolCalls?.length && wire.sendsToolCalls(message)) {
        tokens += guardTokens(safeJson(wire.sizeToolCalls(message.toolCalls)));
      }
      // The id that ties a tool result back to its call. Short, but there is
      // one per tool result and a tool-heavy history has many.
      if (message.toolCallId && message.role === 'tool' && wire.sendsToolCallId) {
        tokens += guardTokens(message.toolCallId);
      }
    }

    // Tool DEFINITIONS ride on every native-tool call — each name, description
    // and input schema in full. Sized as the provider will actually send them:
    // Gemini rewrites every schema through its own sanitiser first, and a large
    // MCP schema is mostly the metadata that strips out.
    if (options.tools?.length) {
      tokens += guardTokens(safeJson(wire.sizeTools(options.tools)));
    }

    // The top-level `images` field is read by GeminiProvider alone — every
    // other provider builds its request from `messages` and never looks at it.
    // Counting it for all of them charged 2,000 tokens apiece for bytes that
    // are not submitted, which refuses runs over input the provider never
    // sees; not counting it at all left Gemini's vision path unreserved.
    if (wire.readsTopLevelImages) {
      const topLevel = (options.images ?? []).filter(countsImage).length;
      images += topLevel * geminiImageCopies(options.messages);
    }
    tokens += images * IMAGE_TOKENS_EACH;

    return tokens;
  }

  /**
   * Report a wait that ended because something asked it to stop, the same way
   * the provider call below reports one.
   *
   * The queue waits sit OUTSIDE the try/catch that maps aborts, so without
   * this a cancellation surfaced as whatever the queue happened to throw and
   * was retried or failed over like an ordinary error. A budget abort keeps
   * saying it ran out of budget — otherwise the reason the run stopped is lost
   * on the way up — and anything else that was aborted becomes a cancellation.
   */
  private asAbortFailure(err: unknown, callSignal?: AbortSignal, runSignal?: AbortSignal): unknown {
    if (err instanceof CascadeRouter.BudgetExceededError) return err;
    if (err instanceof CascadeCancelledError) return err;
    if (callSignal?.aborted || runSignal?.aborted) return new CascadeCancelledError('Run cancelled');
    return err;
  }

  /** Trips the same run-level flag a post-hoc overrun does, and reports it the same way. */
  private failPreflight(reason: string): never {
    this.runBudgetExceeded = true;
    this.runBudgetExceededReason = reason;
    this.runAbort.abort(new CascadeRouter.BudgetExceededError(reason));
    this.emit('budget:exceeded', { reason, spentUsd: this.sessionCostUsd });
    throw new CascadeRouter.BudgetExceededError(reason);
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
    // Reaches the calls already at the provider, not only the ones still
    // queued behind this one.
    this.runAbort.abort(new CascadeRouter.BudgetExceededError(reason));
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
