// ─────────────────────────────────────────────
//  Cascade AI — Cost Calculator
// ─────────────────────────────────────────────

import type { ModelInfo, TokenUsage } from '../types.js';
import { MODELS } from '../constants.js';

/**
 * Resolve per-1k token pricing for a model. Uses the model's own pricing when it
 * has any; otherwise falls back to the bundled catalogue by model id. This makes
 * cost tracking robust to ModelInfo objects that were built without pricing — e.g.
 * a configured per-tier override (`anthropic:claude-sonnet-4-6`) whose ModelInfo
 * came back from a path that didn't attach catalogue costs. Local models (Ollama)
 * legitimately cost 0 and won't match a paid catalogue entry, so they stay 0.
 */
export function resolveModelPricing(model: ModelInfo): { input: number; output: number } {
  let input = model.inputCostPer1kTokens;
  let output = model.outputCostPer1kTokens;
  if (input === 0 && output === 0 && model.id && !model.isLocal) {
    const known = Object.values(MODELS).find((m) => m.id === model.id && !m.isLocal);
    if (known) {
      input = known.inputCostPer1kTokens;
      output = known.outputCostPer1kTokens;
    }
  }
  return { input, output };
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: ModelInfo,
): number {
  const { input, output } = resolveModelPricing(model);
  return (inputTokens / 1000) * input + (outputTokens / 1000) * output;
}

export function buildTokenUsage(
  inputTokens: number,
  outputTokens: number,
  model: ModelInfo,
): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: calculateCost(inputTokens, outputTokens, model),
  };
}