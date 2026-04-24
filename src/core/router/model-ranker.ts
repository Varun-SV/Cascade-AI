// ─────────────────────────────────────────────
//  Cascade AI — Model Ranker
// ─────────────────────────────────────────────
//
//  Scores available models for a given task type using specialization
//  keyword overlap, context window capacity, and cost.
//  Falls back to the static priority list when no profile data exists.
//

import type { ModelInfo, TierRole } from '../../types.js';
import type { TaskType } from './task-analyzer.js';

const TASK_KEYWORDS: Record<TaskType, string[]> = {
  code:     ['code', 'coding', 'programming', 'developer', 'software', 'debug', 'instruction'],
  analysis: ['analysis', 'analytical', 'reasoning', 'logic', 'research'],
  creative: ['creative', 'writing', 'story', 'content', 'narrative'],
  data:     ['data', 'sql', 'statistics', 'math', 'mathematical'],
  mixed:    [],
};

function specializationScore(model: ModelInfo, taskType: TaskType): number {
  const specs = model.specializations;
  if (!specs?.length) return 0;
  const keywords = TASK_KEYWORDS[taskType] ?? [];
  return specs.reduce((acc, spec) => {
    const specLower = spec.toLowerCase();
    return acc + (keywords.some(k => specLower.includes(k)) ? 1 : 0);
  }, 0);
}

function costScore(model: ModelInfo, tier: TierRole): number {
  const avg = (model.inputCostPer1kTokens + model.outputCostPer1kTokens) / 2;
  if (avg === 0) return 1; // free / local models
  // T3 workers: favor cheaper; T1: favor capable (lower score for high cost is ok)
  if (tier === 'T3') return avg < 0.01 ? 2 : avg < 0.05 ? 1 : 0;
  return avg < 0.05 ? 1 : 0;
}

export interface RankerOptions {
  taskType: TaskType;
  tier: TierRole;
  estimatedTokens: number;
  requiresToolUse?: boolean;
}

/**
 * Rank models by task suitability. Returns best match first.
 * If no model has specialization data, returns the original order.
 */
export function rankModels(models: ModelInfo[], opts: RankerOptions): ModelInfo[] {
  const hasAnyProfile = models.some(m => m.specializations && m.specializations.length > 0);
  if (!hasAnyProfile) return models;

  return [...models]
    .filter(m => {
      // Gate: skip non-tool-capable models for T3 when tools are required (unless only option)
      if (opts.requiresToolUse && m.supportsToolUse === false) return false;
      // Gate: skip models whose context window is too small
      if (m.contextWindow < opts.estimatedTokens * 2) return false;
      return true;
    })
    .map(m => ({
      model: m,
      score: specializationScore(m, opts.taskType) * 3 + costScore(m, opts.tier),
    }))
    .sort((a, b) => b.score - a.score)
    .map(r => r.model)
    // If filtering removed all models, fall back to unfiltered
    .concat(models)
    .filter((m, i, arr) => arr.indexOf(m) === i);
}
