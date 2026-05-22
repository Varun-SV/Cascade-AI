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

export type TaskType = 'code' | 'analysis' | 'creative' | 'data' | 'mixed';

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
  private lastProfile: TaskProfile | null = null;
  private lastSelectedModels = new Map<TierRole, ModelInfo>();

  constructor(tracker?: ModelPerformanceTracker) {
    this.tracker = tracker;
  }

  setTracker(tracker: ModelPerformanceTracker): void {
    this.tracker = tracker;
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
    const cacheKey = prompt.slice(0, 200);
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
  ): Promise<ModelInfo | null> {
    const profile = await this.analyze(prompt);

    // Vision tasks: always route to a vision-capable model
    if (profile.requiresVision) {
      return selector.selectVisionModel();
    }

    const candidates = selector.getCandidatesForTier(tier);
    if (candidates.length === 0) return selector.selectForTier(tier);

    const scored = candidates.map(m => ({
      model: m,
      score: this.scoreModel(m, profile),
    }));
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0]?.model ?? selector.selectForTier(tier);
    if (best) this.lastSelectedModels.set(tier, best);
    return best;
  }

  /**
   * Record the outcome of a completed run across all tiers that were selected
   * during this session and persist stats to disk.
   */
  recordRunOutcome(outcome: 'success' | 'failure', costByTier: Record<string, number>): void {
    if (!this.tracker || !this.lastProfile) return;
    const taskType = this.lastProfile.type;
    for (const [tier, model] of this.lastSelectedModels) {
      const cost = costByTier[tier] ?? 0;
      this.tracker.record(model.id, taskType, outcome, 0, cost);
    }
    this.lastSelectedModels.clear();
    void this.tracker.save();
  }

  private scoreModel(model: ModelInfo, profile: TaskProfile): number {
    const perf = this.tracker?.performanceScore(model.id, profile.type) ?? 0.5;
    const costEff = this.costEfficiency(model, profile.complexity);
    const match = this.taskMatchScore(model, profile);
    return perf * costEff * match;
  }

  private costEfficiency(model: ModelInfo, complexity: 1 | 2 | 3 | 4 | 5): number {
    if (this.tracker) return this.tracker.costEfficiencyScore(model, complexity);
    // Same formula without the tracker instance
    const blended = model.inputCostPer1kTokens + model.outputCostPer1kTokens * 2;
    const normalised = Math.min(1.0, blended / 0.05);
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
