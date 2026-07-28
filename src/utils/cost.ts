// ─────────────────────────────────────────────
//  Cascade AI — Cost Calculator
// ─────────────────────────────────────────────

import type { ModelInfo, TokenUsage } from '../types.js';
import { MODELS } from '../constants.js';
import { resolvePricing, type PricingProvider } from '../core/router/pricing.js';

export interface ResolvedPricing {
  /** USD per 1k input tokens. */
  input: number;
  /** USD per 1k output tokens. */
  output: number;
  /**
   * True when no price could be found. `input`/`output` are 0 in that case, but
   * they mean "unknown", NOT "free" — never render them as $0.00.
   */
  unknown: boolean;
  /** Set when the rates came from another provider's price sheet (an estimate). */
  estimatedFromProvider?: PricingProvider;
}

/**
 * Resolve per-1k token pricing for a model, in order:
 *
 *   1. Local models cost 0 — genuinely, not for lack of data.
 *   2. The model's own pricing, when it carries any.
 *   3. The pricing dataset (core/router/pricing-data.json), keyed by
 *      model × provider — including the `baseModelId` an Azure deployment or
 *      other aliased id stands for.
 *   4. The bundled catalogue by model id, for anything the dataset misses.
 *   5. Otherwise: UNKNOWN. Not zero.
 *
 * Step 5 is the point of this function. A per-tier override or a freshly
 * discovered preview model used to fall through to 0 here and be reported as
 * free; it now reports as untracked so the number on screen is honest and the
 * budget code knows its total is an undercount.
 */
export function resolveModelPricing(model: ModelInfo): ResolvedPricing {
  if (model.isLocal) return { input: 0, output: 0, unknown: false };

  if (model.inputCostPer1kTokens > 0 || model.outputCostPer1kTokens > 0) {
    return {
      input: model.inputCostPer1kTokens,
      output: model.outputCostPer1kTokens,
      unknown: false,
    };
  }

  const fromDataset = resolvePricing(model);
  if (!fromDataset.unknown) {
    return {
      input: fromDataset.input,
      output: fromDataset.output,
      unknown: false,
      ...(fromDataset.estimatedFromProvider
        ? { estimatedFromProvider: fromDataset.estimatedFromProvider }
        : {}),
    };
  }

  if (model.id) {
    const known = Object.values(MODELS).find((m) => m.id === model.id && !m.isLocal);
    if (known && (known.inputCostPer1kTokens > 0 || known.outputCostPer1kTokens > 0)) {
      return {
        input: known.inputCostPer1kTokens,
        output: known.outputCostPer1kTokens,
        unknown: false,
      };
    }
  }

  return { input: 0, output: 0, unknown: true };
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
  const { input, output, unknown } = resolveModelPricing(model);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: (inputTokens / 1000) * input + (outputTokens / 1000) * output,
    ...(unknown ? { costUnknown: true } : {}),
  };
}
