// ─────────────────────────────────────────────
//  Cascade AI — A device run's /why for the cloud
// ─────────────────────────────────────────────
//
//  A run on the user's own device (the CLI, the desktop app) is copied into
//  their cloud chat. What it cost goes with it, in the shape a hosted run
//  keeps on its reply: the web's /why panel reads it, and so does the spend
//  report, which counts the run by tier and by the models that served it.

import type { ModelInfo } from '../types.js';
import type { RouterStats } from '../core/router/index.js';
import { computeDelegationSavings } from '../core/router/savings.js';

/** One run's /why as the cloud keeps it on the reply. */
export interface CloudRunReport {
  /** The tier that did the most work. */
  tier: string | null;
  /** The model that served that tier (`provider:id`). */
  model: string | null;
  decisions: Array<{ at: string; kind: string; detail: string }>;
  savedUsd: number;
  savedPct: number;
  totalCostUsd: number;
  totalTokens: number;
  durationMs: number;
  costByTier: Record<string, number>;
  tokensByTier: Record<string, number>;
  /** tier → `provider:id` → cost / tokens. */
  costByModel: Record<string, Record<string, number>>;
  tokensByModel: Record<string, Record<string, number>>;
  /** tier → the model that did most of its work. */
  models: Record<string, string>;
}

type Flat = Record<string, number>;
type Nested = Record<string, Record<string, number>>;

function minus(after: Flat, before: Flat = {}): Flat {
  const out: Flat = {};
  for (const [key, value] of Object.entries(after)) {
    const left = value - (before[key] ?? 0);
    if (left > 0) out[key] = left;
  }
  return out;
}

function minusNested(after: Nested, before: Nested = {}): Nested {
  const out: Nested = {};
  for (const [key, inner] of Object.entries(after)) {
    const left = minus(inner, before[key]);
    if (Object.keys(left).length > 0) out[key] = left;
  }
  return out;
}

function top(m: Flat): string | undefined {
  return Object.entries(m).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The /why of the run that just ended. Where one router serves several runs
 * (the CLI's session), `before` is its stats as the run began and the run is
 * what was added since; where a router serves one run (the desktop app's),
 * leave it out.
 */
export function cloudRunReport(input: {
  stats: RouterStats;
  before?: RouterStats;
  /** The model T1 runs on, which savings are measured against. */
  t1Model: ModelInfo | null | undefined;
  decisions: CloudRunReport['decisions'];
  durationMs: number;
}): CloudRunReport {
  const { stats } = input;
  // Stats that went down were reset since: all they hold is this run's.
  const before = input.before
    && stats.totalTokens >= input.before.totalTokens
    && stats.totalCostUsd >= input.before.totalCostUsd
    ? input.before
    : undefined;

  const costByTier = minus(stats.costByTier, before?.costByTier);
  const tokensByTier = minus(stats.tokensByTier, before?.tokensByTier);
  const costByModel = minusNested(stats.costByTierModel, before?.costByTierModel);
  const tokensByModel = minusNested(stats.tokensByTierModel, before?.tokensByTierModel);
  const totalCostUsd = Math.max(0, stats.totalCostUsd - (before?.totalCostUsd ?? 0));
  const totalTokens = Math.max(0, stats.totalTokens - (before?.totalTokens ?? 0));
  const savings = computeDelegationSavings({
    totalCostUsd,
    inputTokensByTier: minus(stats.inputTokensByTier, before?.inputTokensByTier),
    outputTokensByTier: minus(stats.outputTokensByTier, before?.outputTokensByTier),
  }, input.t1Model);

  const models: Record<string, string> = {};
  for (const tier of new Set([...Object.keys(tokensByModel), ...Object.keys(costByModel)])) {
    const model = top(tokensByModel[tier] ?? {}) ?? top(costByModel[tier] ?? {});
    if (model) models[tier] = model;
  }
  const tier = top(tokensByTier) ?? top(costByTier) ?? null;

  return {
    tier,
    model: (tier && models[tier]) || null,
    decisions: input.decisions,
    savedUsd: savings.savedUsd,
    savedPct: savings.savedPct,
    totalCostUsd,
    totalTokens,
    durationMs: input.durationMs,
    costByTier,
    tokensByTier,
    costByModel,
    tokensByModel,
    models,
  };
}

/** The reply's accounting as the cloud's `/turns` takes it. */
export function cloudTurnAccounting(report: CloudRunReport): { costUsd: number; why: string } {
  return { costUsd: report.totalCostUsd, why: JSON.stringify(report) };
}
