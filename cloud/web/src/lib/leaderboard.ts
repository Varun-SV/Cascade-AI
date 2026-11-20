/** What `/api/leaderboard` serves: see core/router/leaderboard.ts. Counts only. */
export type LeaderboardTask = 'code' | 'analysis' | 'creative' | 'data' | 'mixed';

export interface LeaderboardRow {
  rank: number;
  model: string;
  runs: number;
  successRate: number;
  score: number;
  low: number;
  high: number;
  confidence: 'low' | 'medium' | 'high';
  avgCostUsd: number;
  avgRetries: number;
  benchmark?: number;
  trend7d?: number;
  lastRun?: string;
  inactive?: boolean;
}

export interface Leaderboard {
  generatedAt: string;
  totalRuns: number;
  models: number;
  tasks: Record<LeaderboardTask, LeaderboardRow[]>;
}

export const TASK_LABELS: Array<[LeaderboardTask, string]> = [
  ['code', 'Coding'], ['analysis', 'Analysis'], ['creative', 'Writing'], ['data', 'Data'], ['mixed', 'Mixed'],
];

export async function fetchLeaderboard(signal?: AbortSignal): Promise<Leaderboard> {
  const res = await fetch('/api/leaderboard', signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  return await res.json() as Leaderboard;
}

/** A 0–1 rate as a whole percentage. */
export const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** A run's cost: cents below a dollar, never "$0.00" for a cost that isn't nothing. */
export function runCost(usd: number): string {
  if (!(usd > 0)) return '—';
  if (usd < 0.001) return '<$0.001';
  if (usd < 1) return `$${usd.toFixed(usd < 0.01 ? 3 : 2)}`;
  return `$${usd.toFixed(2)}`;
}

export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}
