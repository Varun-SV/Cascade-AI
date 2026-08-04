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
import { BLENDED_COST_CEILING, blendedCostPer1k } from './pricing.js';

export type TaskType = 'code' | 'analysis' | 'creative' | 'data' | 'mixed';

/** Cascade Auto cost/quality trade-off bias. See CascadeConfig.autoBias. */
export type AutoBias = 'balanced' | 'quality' | 'cost';

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
  /** Models chosen by the run currently in flight. Cleared when it completes. */
  private currentRunSelections = new Map<TierRole, ModelInfo>();
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
  private lastCompletedRun?: { selections: Map<TierRole, ModelInfo>; taskType: TaskType };

  constructor(tracker?: ModelPerformanceTracker, bias: AutoBias = 'balanced') {
    this.tracker = tracker;
    this.bias = bias;
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
    opts?: { requiresToolUse?: boolean },
  ): Promise<ModelInfo | null> {
    const profile = await this.analyze(prompt);

    // EVERY exit from this method must record, or the run is only partially
    // represented in the rating snapshot: a vision-routed run had nothing to
    // rate at all, and a fallback selection was silently omitted from the
    // feedback that is supposed to teach the router which models work.
    const recordSelection = (model: ModelInfo | null): ModelInfo | null => {
      if (model) this.currentRunSelections.set(tier, model);
      return model;
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

    const scored = candidates.map(m => ({
      model: m,
      score: this.scoreModel(m, profile),
    }));
    scored.sort((a, b) => b.score - a.score);

    return recordSelection(scored[0]?.model ?? selector.selectForTier(tier));
  }

  /**
   * Record the outcome of a completed run across all tiers that were selected
   * during this session and persist stats to disk.
   */
  recordRunOutcome(outcome: 'success' | 'failure', costByTier: Record<string, number>, contextTokens = 0): void {
    if (!this.tracker || !this.lastProfile) return;
    const taskType = this.lastProfile.type;
    for (const [tier, model] of this.currentRunSelections) {
      const cost = costByTier[tier] ?? 0;
      this.tracker.record(model.id, taskType, outcome, 0, cost, contextTokens);
    }
    // Hand the selections to the completed-run snapshot rather than dropping
    // them, so a rating that arrives after this point still knows what to rate —
    // and what task type to rate it under.
    this.lastCompletedRun = { selections: new Map(this.currentRunSelections), taskType };
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
    // The snapshot's own task type — NOT lastProfile, which the next run has
    // very likely already overwritten.
    for (const [, model] of snapshot.selections) {
      this.tracker.recordExplicit(model.id, snapshot.taskType, rating, 0);
    }
    this.lastCompletedRun = undefined;
    return true;
  }

  private scoreModel(model: ModelInfo, profile: TaskProfile): number {
    const perf = this.tracker?.performanceScore(model.id, profile.type) ?? 0.5;
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
