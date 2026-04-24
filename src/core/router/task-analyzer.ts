// ─────────────────────────────────────────────
//  Cascade AI — Task Analyzer (Cascade Auto)
// ─────────────────────────────────────────────
//
//  Cascade Auto selects the optimal model for each tier based on task analysis.
//  Uses a hybrid approach:
//    1. Heuristic pass (instant) — keyword/pattern scoring
//    2. AI inference fallback (when heuristic confidence < 0.7)
//

import type { TierRole, ModelInfo } from '../../types.js';
import type { ModelSelector } from './selector.js';
import type { CascadeRouter } from './index.js';
import { rankModels } from './model-ranker.js';

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

function selectModelFromProfile(
  profile: TaskProfile,
  tier: TierRole,
  selector: ModelSelector,
): ModelInfo | null {
  // Vision tasks always need a vision model regardless of tier
  if (profile.requiresVision) {
    return selector.selectVisionModel();
  }

  // Cascade Auto model mapping:
  // T1: orchestrator — always benefits from the most capable model
  if (tier === 'T1') {
    if (profile.complexity >= 4) {
      // High complexity → most capable (opus-class)
      return selector.selectForTier('T1');
    } else {
      // Lower complexity → mid-tier for T1 to save cost
      return selector.selectForTier('T2');
    }
  }

  // T2: section manager
  if (tier === 'T2') {
    if (profile.type === 'code' || profile.type === 'data') {
      // Structured tasks need reliable instruction-following
      return selector.selectForTier('T2');
    } else if (profile.complexity <= 2) {
      // Simple sections can use the fast tier
      return selector.selectForTier('T3');
    }
    return selector.selectForTier('T2');
  }

  // T3: worker — optimize for task type
  if (tier === 'T3') {
    if (profile.complexity >= 4 || profile.requiresReasoning) {
      // Complex subtasks need a capable model
      return selector.selectForTier('T2');
    } else if (profile.type === 'creative') {
      // Creative tasks benefit from a balanced model
      return selector.selectForTier('T2');
    } else {
      // Most T3 tasks → fast model to minimize latency
      return selector.selectForTier('T3');
    }
  }

  return selector.selectForTier(tier);
}

// ── TaskAnalyzer class ─────────────────────────

/** Prompt hash cache — avoids repeated analysis of the same input within a session. */
const analysisCache = new Map<string, TaskProfile>();

export class TaskAnalyzer {
  private router?: CascadeRouter;

  constructor(router?: CascadeRouter) {
    this.router = router;
  }

  /**
   * Analyze a prompt and return a TaskProfile.
   * Uses heuristics first; falls back to AI inference if confidence is low.
   */
  async analyze(prompt: string): Promise<TaskProfile> {
    // Cache hit
    const cacheKey = prompt.slice(0, 200);
    const cached = analysisCache.get(cacheKey);
    if (cached) return cached;

    // Phase 1: Heuristic pass (instant)
    const heuristic = heuristicAnalyze(prompt);

    // Phase 2: AI inference fallback when heuristics are uncertain
    if (heuristic.confidence < 0.7 && this.router) {
      try {
        const aiProfile = await this.aiInference(prompt);
        const merged: TaskProfile = {
          type: aiProfile.type,
          complexity: aiProfile.complexity,
          requiresReasoning: aiProfile.requiresReasoning,
          requiresVision: heuristic.requiresVision || aiProfile.requiresVision,
          estimatedTokens: heuristic.estimatedTokens,
          confidence: 0.9, // AI-backed
        };
        analysisCache.set(cacheKey, merged);
        return merged;
      } catch {
        // AI inference failed — use heuristic result
      }
    }

    analysisCache.set(cacheKey, heuristic);
    return heuristic;
  }

  /**
   * Select the optimal model for a given tier based on task analysis.
   * Uses specialization ranking when profile data is available.
   */
  async selectModel(
    prompt: string,
    tier: TierRole,
    selector: ModelSelector,
  ): Promise<ModelInfo | null> {
    const profile = await this.analyze(prompt);

    // Try specialization-based ranking first
    const candidates = selector.getAllAvailableModels().filter(m => {
      // Rough tier affinity: T3 → local/cheap, T1 → capable
      if (tier === 'T3') return m.isLocal || (m.inputCostPer1kTokens ?? 0) < 0.02;
      if (tier === 'T1') return !m.isLocal;
      return true;
    });

    if (candidates.some(m => m.specializations?.length)) {
      const ranked = rankModels(candidates, {
        taskType: profile.type,
        tier,
        estimatedTokens: profile.estimatedTokens,
        requiresToolUse: tier === 'T3',
      });
      if (ranked.length > 0) return ranked[0]!;
    }

    return selectModelFromProfile(profile, tier, selector);
  }

  private async aiInference(prompt: string): Promise<TaskProfile> {
    if (!this.router) throw new Error('No router for AI inference');

    const inferencePrompt = `Analyze this task and return ONLY a JSON object — no other text.

Task: "${prompt.slice(0, 300)}"

Return: { "type": "code"|"analysis"|"creative"|"data"|"mixed", "complexity": 1-5, "requiresReasoning": true|false, "requiresVision": true|false }

Where complexity: 1=trivial, 2=simple, 3=moderate, 4=complex, 5=research-grade.`;

    const result = await this.router.generate('T3', {
      messages: [{ role: 'user', content: inferencePrompt }],
      maxTokens: 80,
    });

    const jsonMatch = /\{[\s\S]*?\}/.exec(result.content);
    if (!jsonMatch) throw new Error('No JSON in AI inference response');
    const parsed = JSON.parse(jsonMatch[0]) as {
      type: TaskType;
      complexity: number;
      requiresReasoning: boolean;
      requiresVision: boolean;
    };

    const validTypes: TaskType[] = ['code', 'analysis', 'creative', 'data', 'mixed'];
    const type = validTypes.includes(parsed.type) ? parsed.type : 'mixed';
    const complexity = Math.max(1, Math.min(5, Math.round(parsed.complexity))) as 1 | 2 | 3 | 4 | 5;

    return {
      type,
      complexity,
      requiresReasoning: Boolean(parsed.requiresReasoning),
      requiresVision: Boolean(parsed.requiresVision),
      estimatedTokens: 0,
      confidence: 0.9,
    };
  }

  /** Clear the analysis cache (call between sessions). */
  static clearCache(): void {
    analysisCache.clear();
  }
}
