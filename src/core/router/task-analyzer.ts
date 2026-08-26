// ─────────────────────────────────────────────
//  Cascade AI — Task Analyzer (Cascade Auto)
// ─────────────────────────────────────────────
//
//  Cascade Auto selects the optimal model for each tier based on task analysis.
//  Pure heuristic scoring — no AI calls for model selection.
//  Adapts over time via ModelPerformanceTracker (session + persistent stats).

import type { TierRole, ModelInfo } from '../../types.js';
import type { ModelSelector } from './selector.js';
import type { ModelPerformanceTracker } from './model-performance-tracker.js';
import { benchmarkScore01 } from './benchmarks.js';
import { applyFeedback, type FeedbackSource } from './feedback-prior.js';
import { posteriorMean, sampleBeta, posteriorStdDev, type Rng } from './bayes.js';
import { BLENDED_COST_CEILING, blendedCostPer1k } from './pricing.js';

export type TaskType = 'code' | 'analysis' | 'creative' | 'data' | 'mixed';

/** Cascade Auto cost/quality trade-off bias. See CascadeConfig.autoBias. */
export type AutoBias = 'balanced' | 'quality' | 'cost';

/** Options shared by both selection entry points. */
export interface SelectOptions {
  requiresToolUse?: boolean;
}

/**
 * One model this run selected, what it was selected FOR, and whether it ever
 * actually ran.
 *
 * `served` is set by noteServed() from the provider-call boundary. It is a
 * FACT, and it replaces three successive attempts to infer the same thing:
 *
 *   1. "the last model selected for a tier is the one that ran" — false as soon
 *      as selection samples, because two subtasks can draw differently;
 *   2. "a tier default that a per-work selection replaced did not run" — true,
 *      but it only covers one of the ways a default fails to serve;
 *   3. "a tier absent from costByTier made no call" — false, because
 *      costByTier is session-cumulative and beginRun() never clears it, so
 *      after a tier runs once every later run looks like it ran too.
 *
 * Each inference was reasonable and each was wrong in a way the next one
 * exposed. Selecting a model is not running it, and no amount of reasoning
 * about selections recovers what only the call site knows.
 */
export interface RunSelection {
  model: ModelInfo;
  taskType: TaskType;
  served: boolean;
}

/** A routing choice, plus why it might not be the obvious one. */
export interface Selection {
  model: ModelInfo | null;
  /**
   * Set only when the draw beat the belief — i.e. this is an experiment, not
   * the evidence's own answer. Null on an ordinary pick, so a caller can print
   * it unconditionally.
   */
  note: string | null;
}

export interface TaskProfile {
  type: TaskType;
  /** 1 = trivial, 5 = research-grade */
  complexity: 1 | 2 | 3 | 4 | 5;
  requiresReasoning: boolean;
  requiresVision: boolean;
  estimatedTokens: number;
  /** 0.0–1.0 heuristic confidence; below 0.7 triggers AI fallback */
  confidence: number;
}

// ── Heuristic scoring tables ───────────────────

const CODE_SIGNALS = [
  /\b(?:function|class|interface|async|await|import|export|const|let|var|def|return|if|else|for|while|try|catch)\b/,
  /\b(?:typescript|javascript|python|rust|go|java|c\+\+|sql|bash|shell|dockerfile|kubernetes|terraform)\b/i,
  /\b(?:implement|refactor|debug|fix|write.*code|create.*function|add.*method|parse|compile|build|test|deploy)\b/i,
  /[{}[\]()=>]/, // Code-like punctuation density
];

const ANALYSIS_SIGNALS = [
  /\b(?:analyze|analyse|explain|describe|compare|evaluate|assess|review|summarize|understand|interpret)\b/i,
  /\b(?:why|what.*cause|how.*work|difference.*between|pros.*cons|trade.?off|benchmark)\b/i,
];

const CREATIVE_SIGNALS = [
  /\b(?:write|draft|compose|create.*story|generate.*text|poem|essay|blog|article|email|proposal)\b/i,
  /\b(?:creative|imaginative|fictional|narrative|persuasive|marketing)\b/i,
];

const DATA_SIGNALS = [
  /\b(?:csv|json|yaml|xml|excel|spreadsheet|dataframe|dataset|sql|query|aggregate|pivot)\b/i,
  /\b(?:statistics|chart|graph|visualize|plot|correlation|regression|cluster)\b/i,
];

const HIGH_COMPLEXITY_SIGNALS = [
  /\b(?:architect|design.*system|distributed|microservice|scalab|performance|optimiz|refactor.*entire|migrate)\b/i,
  /\b(?:research|comprehensive|detailed|in-depth|thorough|complete|full.*implementation)\b/i,
  /multiple.*file|several.*component|entire.*codebase|whole.*project/i,
];

const LOW_COMPLEXITY_SIGNALS = [
  /\b(?:simple|quick|brief|short|small|single|one-line|rename|typo|hello world)\b/i,
  /^(?:hi|hello|thanks|ok|yes|no|what is|list|show me|tell me)\b/i,
];

// ── Heuristic analyser ─────────────────────────

function scoreText(text: string, patterns: RegExp[]): number {
  return patterns.reduce((score, re) => score + (re.test(text) ? 1 : 0), 0);
}

function heuristicAnalyze(prompt: string): TaskProfile {
  const lower = prompt.toLowerCase();

  const codeScore = scoreText(lower, CODE_SIGNALS);
  const analysisScore = scoreText(lower, ANALYSIS_SIGNALS);
  const creativeScore = scoreText(lower, CREATIVE_SIGNALS);
  const dataScore = scoreText(lower, DATA_SIGNALS);
  const highComplexityScore = scoreText(lower, HIGH_COMPLEXITY_SIGNALS);
  const lowComplexityScore = scoreText(lower, LOW_COMPLEXITY_SIGNALS);

  // Determine primary type
  const scores: Record<TaskType, number> = {
    code: codeScore,
    analysis: analysisScore,
    creative: creativeScore,
    data: dataScore,
    mixed: 0,
  };
  const maxScore = Math.max(...Object.values(scores));
  const topTypes = (Object.entries(scores) as [TaskType, number][]).filter(([, s]) => s === maxScore && s > 0);
  const type: TaskType = topTypes.length === 1 ? topTypes[0]![0] : 'mixed';

  // Determine complexity (1-5)
  const wordCount = prompt.split(/\s+/).length;
  let complexity: 1 | 2 | 3 | 4 | 5 = 3;
  if (lowComplexityScore > 0 || wordCount < 10) complexity = 1;
  else if (highComplexityScore >= 2 || wordCount > 200) complexity = 5;
  else if (highComplexityScore === 1 || wordCount > 80) complexity = 4;
  else if (wordCount > 30) complexity = 3;
  else complexity = 2;

  // Confidence = how clearly the signals point to one type
  const totalSignals = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalSignals === 0 ? 0.3 : Math.min(0.95, (maxScore / totalSignals) * (maxScore > 0 ? 1 : 0.3));

  const requiresReasoning = complexity >= 4 || analysisScore > 1;
  const requiresVision = /\b(?:image|screenshot|photo|diagram|figure|visual)\b/i.test(lower);
  const estimatedTokens = wordCount * 5; // rough token estimate

  return { type, complexity, requiresReasoning, requiresVision, estimatedTokens, confidence };
}

// ── Model selection from profile ───────────────

// ── TaskAnalyzer class ─────────────────────────

/**
 * Cache key for an analysed prompt. A digest of the full text, so two prompts
 * that merely start alike cannot share a routing profile. Non-cryptographic
 * (FNV-1a over the whole string, length-salted) — this guards a local Map, not
 * a security boundary, and avoids pulling node:crypto into a hot path that the
 * browser bundle also reaches.
 */
function hashPrompt(prompt: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < prompt.length; index++) {
    hash ^= prompt.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prompt.length}:${hash.toString(36)}`;
}

/** Prompt hash cache — avoids repeated analysis of the same input within a session. */
const analysisCache = new Map<string, TaskProfile>();

// Map from task type to relevant model specialization tags
const TASK_TYPE_TAGS: Record<TaskType, string[]> = {
  code: ['code', 'instruction'],
  analysis: ['analysis', 'instruction'],
  creative: ['creative', 'multilingual'],
  data: ['data', 'code'],
  mixed: [],
};

export class TaskAnalyzer {
  private tracker?: ModelPerformanceTracker;
  /** Per-model thumbs counts, when the host collects them. */
  private feedback?: FeedbackSource;
  private bias: AutoBias;
  private lastProfile: TaskProfile | null = null;
  /**
   * Models used per tier this run — a LIST, each carrying its own task type.
   *
   * A tier can legitimately run several models now that selection samples: two
   * T3 subtasks in one run may draw differently. Every one of them has to
   * receive the run's outcome, or the explored model records nothing and
   * exploration cannot learn from its own experiment.
   *
   * And each carries the task type IT was chosen for, because subtasks within
   * one run are not all the same type. Crediting them all to the last
   * selection's profile teaches the router that whichever model happened to
   * write the closing paragraph is good at code.
   */
  private currentRunSelections = new Map<TierRole, RunSelection[]>();
  /**
   * Immutable snapshot of the last COMPLETED run: its selections AND the task
   * type they were chosen for.
   *
   * The task type has to travel WITH the selections. `lastProfile` is overwritten
   * by the next analyze(), so if run B started before the user rated run A, A's
   * models were credited under B's task type — teaching the router that a coding
   * model is good at creative writing, from a rating that never said so.
   *
   * Explicit ratings arrive after the run finishes — rateLastRun() is by nature
   * a reaction to a finished answer — but the run finalizer calls
   * recordRunOutcome() first, and that used to clear the only map there was. So
   * every explicit rating iterated an empty map, recorded nothing, and returned
   * false: the 3x-weighted user signal never reached the tracker at all.
   */
  private lastCompletedRun?: { selections: Map<TierRole, RunSelection[]> };

  /**
   * Uniform source for Thompson draws. Injectable so a test can pin the
   * exploration decision instead of asserting on chance.
   */
  private rng: Rng = Math.random;


  constructor(tracker?: ModelPerformanceTracker, bias: AutoBias = 'balanced') {
    this.tracker = tracker;
    this.bias = bias;
  }

  /** Replace the RNG behind exploration (tests). */
  setRng(rng: Rng): void {
    this.rng = rng;
  }

  /**
   * Supply per-model rating counts. Optional by design: a host that collects no
   * feedback (the CLI, a fresh install) scores exactly as it did before, since
   * feedbackAdjustment returns 0 for an empty record.
   */
  setFeedbackSource(source: FeedbackSource): void {
    this.feedback = source;
  }

  setTracker(tracker: ModelPerformanceTracker): void {
    this.tracker = tracker;
  }

  /** Change the cost/quality bias at runtime (e.g. when config reloads). */
  setBias(bias: AutoBias): void {
    this.bias = bias;
  }

  /** Returns the TaskProfile from the most recent analyze() call — used for outcome recording. */
  getLastProfile(): TaskProfile | null {
    return this.lastProfile;
  }

  /**
   * Analyze a prompt and return a TaskProfile using pure heuristics.
   * Low confidence prompts fall back to a conservative mixed/moderate profile.
   */
  async analyze(prompt: string): Promise<TaskProfile> {
    // Hash the WHOLE prompt, not its first 200 characters. Two tasks that share
    // a preamble — the same file header, the same "You are working in repo X"
    // block, the same pasted stack trace — collided on the truncated key and the
    // second silently inherited the first's profile. That profile decides tier
    // and model, so "summarise this log" could be routed as whatever the last
    // task with the same opening happened to be. Truncation only ever saved a
    // few microseconds of hashing on a call that then does real work.
    const cacheKey = hashPrompt(prompt);
    const cached = analysisCache.get(cacheKey);
    if (cached) {
      this.lastProfile = cached;
      return cached;
    }

    const profile = heuristicAnalyze(prompt);
    analysisCache.set(cacheKey, profile);
    this.lastProfile = profile;
    return profile;
  }

  /**
   * Select the optimal model for a given tier.
   * Scores tier-eligible models using cost efficiency + historical performance.
   * Falls back to the priority-list default when no candidates have history.
   */
  async selectModel(
    prompt: string,
    tier: TierRole,
    selector: ModelSelector,
    opts?: SelectOptions,
  ): Promise<ModelInfo | null> {
    return (await this.select(prompt, tier, selector, opts)).model;
  }

  /**
   * Select a model AND say whether the choice was exploratory.
   *
   * The note is returned rather than left on the instance for the caller to
   * collect afterwards. That looks like an over-careful API for one string,
   * and it is not: `Cascade.run` selects every tier CONCURRENTLY
   * (`Promise.all` over the tiers in play, cascade.ts), all against this one
   * analyzer. A field would be written by three interleaved calls and read by
   * three continuations in an order nothing establishes — /why would attribute
   * one tier's exploration to another, and lose the rest. Clearing the field
   * per call does not fix that; it only removes the staleness across
   * SEQUENTIAL calls. Ownership is what is actually needed, and a return value
   * is what ownership looks like.
   */
  async select(
    prompt: string,
    tier: TierRole,
    selector: ModelSelector,
    opts?: SelectOptions,
  ): Promise<Selection> {
    const profile = await this.analyze(prompt);

    // EVERY exit from this method must record, or the run is only partially
    // represented in the rating snapshot: a vision-routed run had nothing to
    // rate at all, and a fallback selection was silently omitted from the
    // feedback that is supposed to teach the router which models work.
    const recordSelection = (model: ModelInfo | null, note: string | null = null): Selection => {
      if (model) {
        const used = this.currentRunSelections.get(tier) ?? [];
        // ACCUMULATE. This was `set(tier, model)`, harmless while selection was
        // a deterministic argmax — every subtask in a tier picked the same
        // model, so the overwrite replaced a model with itself. A sampled
        // selection breaks that: two T3 subtasks can legitimately pick
        // different models, and the overwrite hands the whole tier's outcome to
        // whichever was chosen last. The explored model — the entire reason the
        // draw exists — would record no evidence at all, so exploration could
        // never learn from what it tried, nor stop trying it.
        //
        // Selecting is not running, so these arrive unserved; noteServed()
        // marks the ones that reach a provider.
        if (!used.some((sel) => sel.model.id === model.id && sel.taskType === profile.type)) {
          used.push({ model, taskType: profile.type, served: false });
        }
        this.currentRunSelections.set(tier, used);
      }
      return { model, note };
    };

    // Vision tasks: always route to a vision-capable model
    if (profile.requiresVision) {
      return recordSelection(selector.selectVisionModel());
    }

    let candidates = selector.getCandidatesForTier(tier);
    if (candidates.length === 0) return recordSelection(selector.selectForTier(tier));

    // Tool-heavy subtasks prefer models with NATIVE tool support — the text
    // fallback works but is slower and flakier. Soft gate: if every candidate
    // is tool-less, keep them all rather than starving the tier.
    if (opts?.requiresToolUse) {
      const toolCapable = candidates.filter((m) => m.supportsToolUse !== false);
      if (toolCapable.length > 0) candidates = toolCapable;
    }

    // Scored twice: once on what we BELIEVE (the posterior mean) and once on a
    // DRAW from the same posterior. The draw is what gets picked.
    //
    // Thompson sampling, and the reason it is the right shape here: a model we
    // have barely tried has a wide posterior and will occasionally draw high
    // enough to earn a turn, while a model we have measured a hundred times
    // draws its own mean every time and stops being explored. There is no rate
    // to tune and no bonus to decay — the decay IS the posterior narrowing as
    // evidence arrives. Without it, `perf` was an absorbing state: a model that
    // failed once was ranked below everything and so never ran again to prove
    // otherwise.
    const scored = candidates.map(m => ({
      model: m,
      belief: this.scoreModel(m, profile, 'mean'),
      score: this.scoreModel(m, profile, 'sample'),
    }));
    scored.sort((a, b) => b.score - a.score);

    const chosen = scored[0];
    // An exploratory pick is one the evidence alone would not have made. It
    // has to be explainable, or it reads as the router malfunctioning.
    const byBelief = [...scored].sort((a, b) => b.belief - a.belief)[0];
    const note = chosen && byBelief && chosen.model.id !== byBelief.model.id
      ? this.describeExploration(chosen.model, byBelief.model, profile)
      : null;

    return recordSelection(chosen?.model ?? selector.selectForTier(tier), note);
  }

  /**
   * Mark a selected model as having actually served a call on this tier.
   *
   * Called from the provider-call boundary (RouterCore.recordStats), which is
   * the only place that knows a request was really made and which model made
   * it. Everything upstream of that knows only what was CHOSEN.
   *
   * A model that serves without having been selected here — an explicitly
   * pinned tier, a failover replacement — has no entry and is ignored, which
   * matches the existing contract that this analyzer only rates its own
   * choices.
   */
  noteServed(tier: TierRole, modelId: string): void {
    const used = this.currentRunSelections.get(tier);
    if (!used) return;
    for (const sel of used) {
      if (sel.model.id === modelId) sel.served = true;
    }
  }

  /**
   * Record the outcome of a completed run across all tiers that were selected
   * during this session and persist stats to disk.
   */
  recordRunOutcome(outcome: 'success' | 'failure', costByTier: Record<string, number>, contextTokens = 0): void {
    if (!this.tracker) return;
    const servedByTier = new Map<TierRole, RunSelection[]>();
    for (const [tier, all] of this.currentRunSelections) {
      // Only models that actually reached a provider. A selection is a plan,
      // not an observation: a rejected plan, a cancelled subtask, or a tier
      // default that per-work routing replaced all leave selections behind
      // that never ran, and paying them the run's outcome teaches the router
      // about work that did not happen.
      const used = all.filter((sel) => sel.served);
      if (used.length === 0) continue;
      servedByTier.set(tier, used);
      // The caller only knows what a TIER cost, not what each model in it cost,
      // so a tier served by several models splits its cost evenly across them.
      // An approximation, and a deliberate one: charging every model the whole
      // tier's cost would multiply the recorded spend by the number of models
      // and make an explored model look ruinous purely for having been tried.
      // The tier total stays right, which is what the cost column reports.
      const cost = (costByTier[tier] ?? 0) / used.length;
      for (const sel of used) {
        // sel.taskType, not the run's last profile: a run's subtasks are not
        // all the same type, and crediting a coding model under `creative`
        // because the closing section was prose teaches the router something
        // no observation ever said.
        this.tracker.record(sel.model.id, sel.taskType, outcome, 0, cost, contextTokens);
      }
    }
    // Hand the selections to the completed-run snapshot rather than dropping
    // them, so a rating that arrives after this point still knows what to rate —
    // and what task type to rate it under.
    // The SAME set that received the outcome — a tier that never ran must not
    // collect an explicit rating either, or the thumb credits a model the run
    // never used.
    this.lastCompletedRun = { selections: new Map(servedByTier) };
    this.currentRunSelections.clear();
    void this.tracker.save();
  }

  /**
   * Record an explicit user rating (good/bad) for the last COMPLETED run's models.
   * Explicit ratings carry 3× the weight of auto-detected outcomes.
   *
   * Reads the completed-run snapshot, not the in-flight map: by the time a user
   * can rate an answer, the finalizer has already run and the in-flight map is
   * empty.
   *
   * The snapshot is CONSUMED. recordExplicit() weights a rating 3x by recording
   * three samples, so a double submit would inject six — a stutter on the
   * button would count as two opinions. Consuming makes a second call a no-op
   * that reports false, which is what "rate this run" should mean.
   */
  recordExplicitRating(rating: 'good' | 'bad'): boolean {
    const snapshot = this.lastCompletedRun;
    if (!this.tracker || !snapshot || snapshot.selections.size === 0) return false;
    // Deduplicated by MODEL, not by tier. The tracker is keyed (modelId,
    // taskType) — tier is not part of it — so one model serving T1, T2 and T3
    // (the ordinary single-local-model setup) took three recordExplicit calls,
    // and each of those records three samples for its 3x weighting. One thumbs
    // up became nine samples, and the models a user happens to run on every
    // tier drifted fastest purely from that.
    // Deduped by (model, task type) — the tracker's own key. The same model
    // serving a coding subtask and a creative one is two things the user's
    // thumb is an opinion about, not one.
    const rated = new Set<string>();
    for (const [, used] of snapshot.selections) {
      for (const sel of used) {
        const key = `${sel.model.id}:${sel.taskType}`;
        if (rated.has(key)) continue;
        rated.add(key);
        this.tracker.recordExplicit(sel.model.id, sel.taskType, rating, 0);
      }
    }
    this.lastCompletedRun = undefined;
    return true;
  }

  /**
   * @param perfMode `mean` scores on what we believe; `sample` draws from the
   *        posterior. Everything else in the score is a deterministic lookup —
   *        the benchmark, the price, the specialization match — so this is the
   *        only term where exploration could live.
   */
  private scoreModel(model: ModelInfo, profile: TaskProfile, perfMode: 'mean' | 'sample' = 'mean'): number {
    const perf = this.perfFor(model, profile, perfMode);
    const costEff = this.costEfficiency(model, profile.complexity);
    const match = this.taskMatchScore(model, profile);
    // Public-benchmark strength for this task type dominates the choice (so a
    // coding subtask prefers Claude, a writing one GPT/Gemini, etc.) while cost
    // efficiency still breaks ties on trivial work. The 0.3 floor keeps a
    // benchmark-unknown model competitive rather than zeroing it out.
    // Your ratings adjust the public score — they never replace it. The
    // adjustment is capped at ±0.05 and shrunk toward zero by sample size, so a
    // couple of thumbs cannot outweigh a real benchmark gap but sustained
    // agreement can break a near-tie. See router/feedback-prior.ts for why the
    // data deserves exactly that much weight and no more.
    const rated = this.feedback?.(model.id);
    const publicScore = benchmarkScore01(model, profile.type);
    const adjusted = rated ? applyFeedback(publicScore, rated) : publicScore;
    const benchmark = 0.3 + 0.7 * adjusted;

    // autoBias reshapes the same factors:
    //   balanced — quality × cost-efficiency (default; unchanged behavior).
    //   quality  — benchmark dominates; cost is only a light tiebreak.
    //   cost     — cheapest wins, but √benchmark keeps a soft quality floor so a
    //              dirt-cheap weak model can't win a hard task outright.
    switch (this.bias) {
      case 'quality':
        return perf * match * (benchmark ** 2) * (0.85 + 0.15 * costEff);
      case 'cost':
        return perf * match * (costEff ** 1.5) * Math.sqrt(benchmark);
      case 'balanced':
      default:
        return perf * costEff * match * benchmark;
    }
  }

  /**
   * The one stochastic term in the score.
   *
   * The retry penalty is applied to a DRAW the same way performanceScore()
   * applies it to the mean, so exploring cannot smuggle a model past a cost it
   * has actually been shown to carry.
   */
  private perfFor(model: ModelInfo, profile: TaskProfile, mode: 'mean' | 'sample'): number {
    if (!this.tracker) return 0.5;
    if (mode === 'mean') return this.tracker.performanceScore(model.id, profile.type);
    const posterior = this.tracker.posteriorFor(model.id, profile.type);
    const drawn = sampleBeta(posterior, this.rng);
    // Asked for directly, NOT recovered as performanceScore / posteriorMean.
    // That ratio is the retry factor only while the score floor is slack: once
    // the mean drops under 0.05 — around 37 straight failures — performanceScore
    // returns the floor instead of the penalised mean, and the "retry factor"
    // becomes 0.05/mean, which GROWS as the model gets worse. At 100 failures
    // it multiplied every draw by 2.6, at 300 by 7.6. The worst-established
    // models in the catalogue were having their draws amplified, which is the
    // exact opposite of letting exploration self-limit.
    const retryFactor = this.tracker.retryFactorFor(model.id, profile.type);
    return Math.max(0.05, drawn * retryFactor);
  }

  /** One line for /why, naming what was tried and how little is known about it. */
  private describeExploration(chosen: ModelInfo, byBelief: ModelInfo, profile: TaskProfile): string {
    const n = this.tracker?.sampleCountFor(chosen.id, profile.type) ?? 0;
    const spread = this.tracker
      ? posteriorStdDev(this.tracker.posteriorFor(chosen.id, profile.type))
      : 0;
    const seen = n === 0 ? 'never used it for this' : `${n} ${n === 1 ? 'run' : 'runs'} of history`;
    return `exploring ${chosen.provider}:${chosen.id} over ${byBelief.provider}:${byBelief.id} `
      + `— ${seen}, so its success rate is still uncertain (±${spread.toFixed(2)}). `
      + `Routing tries a plausible alternative occasionally rather than only ever picking the current best.`;
  }

  private costEfficiency(model: ModelInfo, complexity: 1 | 2 | 3 | 4 | 5): number {
    if (this.tracker) return this.tracker.costEfficiencyScore(model, complexity);
    // Same formula without the tracker instance — including the unknown-price
    // ceiling, so both paths agree that "no price" is not "no cost".
    const blended = blendedCostPer1k(model);
    const normalised = Math.min(1.0, blended / BLENDED_COST_CEILING);
    const complexityWeight = (6 - complexity) / 5;
    return Math.max(0.1, 1 - normalised * complexityWeight);
  }

  private taskMatchScore(model: ModelInfo, profile: TaskProfile): number {
    const expected = TASK_TYPE_TAGS[profile.type];
    if (!model.specializations?.length || expected.length === 0) return 1.0;
    const matches = expected.filter(tag => model.specializations!.includes(tag)).length;
    // Boost 30% for full match, slight penalty for zero match vs a specialised competitor
    return matches > 0 ? 1.0 + (matches / expected.length) * 0.3 : 0.8;
  }

  /** Clear the analysis cache (call between sessions). */
  static clearCache(): void {
    analysisCache.clear();
  }
}
