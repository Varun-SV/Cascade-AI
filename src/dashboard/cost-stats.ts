// ─────────────────────────────────────────────
//  Cascade AI — Dashboard cost analytics helpers
// ─────────────────────────────────────────────
//
//  Pure aggregation over stored sessions, kept out of server.ts so it can be
//  unit-tested without an Express/socket harness. Powers GET /api/costs
//  (desktop Insights → Costs) and carries the Why-report shape shared by
//  `run:why` broadcasts and GET /api/sessions/:id/why.

import type { Session } from '../types.js';
import type { DecisionLogEntry } from '../core/cascade.js';

/** The decision trail + router economics of one session's most recent run. */
export interface WhyReport {
  sessionId: string;
  capturedAt: string;
  decisions: DecisionLogEntry[];
  savedUsd: number;
  savedPct: number;
  totalCostUsd: number;
  totalTokens: number;
  costByTier: Record<string, number>;
  durationMs?: number;
}

export interface DayCostBucket {
  /** ISO date (YYYY-MM-DD, UTC). */
  date: string;
  costUsd: number;
  tokens: number;
  runs: number;
}

export interface CostStats {
  totalCostUsd: number;
  totalTokens: number;
  totalSessions: number;
  totalRuns: number;
  /** One bucket per day for the trailing window, oldest first, zero-filled. */
  perDay: DayCostBucket[];
  topSessions: Array<{ sessionId: string; title: string; costUsd: number; tokens: number; runs: number; updatedAt: string }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Aggregate spend/token/run counts from stored sessions. A session's activity
 * is bucketed by its `updatedAt` day (sessions are the finest persisted grain
 * — per-run receipts aren't stored), so a long-lived session counts toward
 * the day it last ran. Days with no activity are zero-filled so charts render
 * a continuous axis.
 */
export function aggregateCostStats(
  sessions: Session[],
  opts: { days?: number; topN?: number; now?: Date } = {},
): CostStats {
  const days = Math.max(1, opts.days ?? 30);
  const topN = Math.max(1, opts.topN ?? 8);
  const now = opts.now ?? new Date();

  const buckets = new Map<string, DayCostBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const key = utcDateKey(new Date(now.getTime() - i * DAY_MS));
    buckets.set(key, { date: key, costUsd: 0, tokens: 0, runs: 0 });
  }

  let totalCostUsd = 0;
  let totalTokens = 0;
  let totalRuns = 0;

  for (const s of sessions) {
    const cost = s.metadata?.totalCostUsd ?? 0;
    const tokens = s.metadata?.totalTokens ?? 0;
    const runs = s.metadata?.taskCount ?? 0;
    totalCostUsd += cost;
    totalTokens += tokens;
    totalRuns += runs;

    const when = new Date(s.updatedAt || s.createdAt);
    if (!Number.isNaN(when.getTime())) {
      const bucket = buckets.get(utcDateKey(when));
      if (bucket) {
        bucket.costUsd += cost;
        bucket.tokens += tokens;
        bucket.runs += runs;
      }
    }
  }

  const topSessions = [...sessions]
    .filter((s) => (s.metadata?.totalCostUsd ?? 0) > 0)
    .sort((a, b) => (b.metadata?.totalCostUsd ?? 0) - (a.metadata?.totalCostUsd ?? 0))
    .slice(0, topN)
    .map((s) => ({
      sessionId: s.id,
      title: s.title,
      costUsd: s.metadata?.totalCostUsd ?? 0,
      tokens: s.metadata?.totalTokens ?? 0,
      runs: s.metadata?.taskCount ?? 0,
      updatedAt: s.updatedAt,
    }));

  return {
    totalCostUsd,
    totalTokens,
    totalSessions: sessions.length,
    totalRuns,
    perDay: [...buckets.values()],
    topSessions,
  };
}
