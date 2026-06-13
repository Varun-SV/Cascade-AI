// ─────────────────────────────────────────────
//  Cascade AI — Delegation Savings
// ─────────────────────────────────────────────
//
//  Only a hierarchy can answer "what did delegation save you?": the
//  counterfactual is every call running on the premium T1 model instead of
//  being routed to cheaper T2/T3 models (often free local ones). Pure
//  function over RouterStats so it is unit-testable without a router.

import type { ModelInfo } from '../../types.js';
import { calculateCost } from '../../utils/cost.js';
import type { RouterStats } from './index.js';

export interface DelegationSavings {
  /** USD saved vs. running every call on the T1 model. 0 when nothing was saved. */
  savedUsd: number;
  /** Percentage of the counterfactual cost that was saved (0–100, one decimal). */
  savedPct: number;
  /** What the session would have cost if every call had used the T1 model. */
  counterfactualUsd: number;
}

const NO_SAVINGS: DelegationSavings = { savedUsd: 0, savedPct: 0, counterfactualUsd: 0 };

export function computeDelegationSavings(
  stats: Pick<RouterStats, 'totalCostUsd' | 'inputTokensByTier' | 'outputTokensByTier'>,
  t1Model: ModelInfo | undefined | null,
): DelegationSavings {
  if (!t1Model) return NO_SAVINGS;

  let counterfactualUsd = 0;
  const tiers = new Set([
    ...Object.keys(stats.inputTokensByTier),
    ...Object.keys(stats.outputTokensByTier),
  ]);
  for (const tier of tiers) {
    counterfactualUsd += calculateCost(
      stats.inputTokensByTier[tier] ?? 0,
      stats.outputTokensByTier[tier] ?? 0,
      t1Model,
    );
  }

  const savedUsd = counterfactualUsd - stats.totalCostUsd;
  // A free/local T1 (counterfactual 0) or an all-T1 run never shows savings.
  if (!(savedUsd > 0) || counterfactualUsd <= 0) {
    return { ...NO_SAVINGS, counterfactualUsd: Math.max(0, counterfactualUsd) };
  }

  return {
    savedUsd,
    savedPct: Math.round((savedUsd / counterfactualUsd) * 1000) / 10,
    counterfactualUsd,
  };
}
