// ─────────────────────────────────────────────
//  Cascade AI — Cost Calculator
// ─────────────────────────────────────────────

import type { ModelInfo, TokenUsage } from '../types.js';

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: ModelInfo,
): number {
  return (
    (inputTokens / 1000) * model.inputCostPer1kTokens +
    (outputTokens / 1000) * model.outputCostPer1kTokens
  );
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