// ─────────────────────────────────────────────
//  Cascade AI — The model leaderboard, from what Cascade's runs measured
// ─────────────────────────────────────────────
//
//  Every routed call records how it went in the shared learning pool
//  (model-perf.json): per model and task type, success and failure evidence,
//  retries, cost and how many times it ran. No prompt, no answer, no user: the
//  pool holds counts and sums only. This turns those into a ranking.
//
//  Ranked by the LOWER bound of a 90% interval on the success rate, not by the
//  rate itself. A model with three lucky runs has a high rate and a wide
//  interval; ranking on the rate puts it above one with five hundred runs at
//  95%. The lower bound asks "how good is it, at least, on what we've seen",
//  so a model climbs by being run, not by being lucky. The interval is the
//  same Beta posterior routing uses (bayes.ts), so the board and the router
//  agree about what is known.
//
//  Nothing is forgotten. The pool is all-time; a model routing stops choosing
//  stays on the board, marked inactive from the day its runs stopped, which
//  the daily snapshots (`LeaderboardHistory`) are what can tell.

import type { ModelInfo, TaskType } from '../../types.js';
import { posteriorMean, posteriorStdDev, weightedPosterior } from './bayes.js';
import { CARRIED_SEED_FAMILIES, benchmarkProfile, resolveFamily } from './benchmarks.js';

/** One model on one task type, as the learning pool holds it. */
export interface PoolStat {
  successCount: number;
  failureCount: number;
  totalRetries: number;
  totalCostUsd: number;
  /** Observations: runs, and explicit ratings of them. What the posterior's tightness reads. */
  sampleCount: number;
  /** How many of those were ratings, not runs (absent in older pools). */
  explicitCount?: number;
}

export const LEADERBOARD_TASKS: readonly TaskType[] = ['code', 'analysis', 'creative', 'data', 'mixed'];

/** Runs a model needs on a task type before it is ranked at all. */
export const MIN_RANKED_RUNS = 5;
/** Days without a new run before a model is shown as inactive. */
export const INACTIVE_AFTER_DAYS = 30;
/** z for a two-sided 90% interval. */
const Z90 = 1.645;

export interface LeaderboardRow {
  rank: number;
  model: string;
  /** Runs measured: how many times Cascade routed this model on this kind of task. */
  runs: number;
  /** What happened, unshrunk: success evidence over all evidence. 0–1. */
  successRate: number;
  /** The believed success rate (posterior mean). 0–1. */
  score: number;
  /** The 90% interval on it. Ranked by `low`. 0–1. */
  low: number;
  high: number;
  confidence: 'low' | 'medium' | 'high';
  /** Average cost of one run, USD, as the providers billed it. */
  avgCostUsd: number;
  avgRetries: number;
  /** The published benchmarks' score for this kind of task, 0–100, when a board has measured the model. */
  benchmark?: number;
  /** Change in `low`, in points, against a snapshot six to nine days back, when there is one. */
  trend7d?: number;
  /** The last day a new run of it was seen, from the snapshots (YYYY-MM-DD). */
  lastRun?: string;
  /** No new run in INACTIVE_AFTER_DAYS: still shown, not forgotten. */
  inactive?: boolean;
}

export interface Leaderboard {
  generatedAt: string;
  /** Runs measured across every model and task type, ranked or not. */
  totalRuns: number;
  models: number;
  tasks: Record<TaskType, LeaderboardRow[]>;
}

/** One day's state, kept so trends and inactivity can be told. Counts only. */
export interface LeaderboardSnapshot { runs: number; low: number }
/** Day (YYYY-MM-DD) → "model|task" → snapshot. */
export type LeaderboardHistory = Record<string, Record<string, LeaderboardSnapshot>>;

/** "modelId:taskType" → the model and task, split at the last colon (model ids can hold colons). */
function splitKey(key: string): { model: string; task: TaskType } | null {
  const at = key.lastIndexOf(':');
  if (at <= 0) return null;
  const task = key.slice(at + 1) as TaskType;
  return LEADERBOARD_TASKS.includes(task) ? { model: key.slice(0, at), task } : null;
}

const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/** Executions of the model: observations less ratings of them. */
const runsOf = (s: PoolStat): number => Math.max(0, finite(s.sampleCount) - finite(s.explicitCount));

function intervalOf(s: PoolStat): { score: number; low: number; high: number; successRate: number } {
  const p = weightedPosterior(finite(s.successCount), finite(s.failureCount), finite(s.sampleCount));
  const score = posteriorMean(p);
  const sd = posteriorStdDev(p);
  const evidence = finite(s.successCount) + finite(s.failureCount);
  return {
    score,
    low: Math.max(0, score - Z90 * sd),
    high: Math.min(1, score + Z90 * sd),
    successRate: evidence > 0 ? finite(s.successCount) / evidence : 0,
  };
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The published benchmark for a model on a task type, 0–100, only where a board
 * measured that very model. Routing is looser, and rightly: it carries seed scores
 * for local builds no board measures, and maps a release no board has reached yet
 * onto its measured predecessor. Neither is a published score, so neither is shown:
 * a carried seed is left out, and so is a model whose own id doesn't name the
 * measured family's version.
 */
export function publishedBenchmark(model: string, task: TaskType): number | undefined {
  const info = { id: model, name: model } as ModelInfo;
  const family = resolveFamily(info);
  if (!family || CARRIED_SEED_FAMILIES.has(family) || !squash(model).includes(squash(family))) return undefined;
  const profile = benchmarkProfile(info);
  if (!profile) return undefined;
  if (task === 'mixed') {
    const vals = (['code', 'analysis', 'creative', 'data'] as const).map((t) => profile[t]).filter((v): v is number => typeof v === 'number');
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : undefined;
  }
  const v = profile[task];
  return typeof v === 'number' ? Math.round(v) : undefined;
}

const dayMs = 86_400_000;
const dayOf = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

/**
 * Adds today's snapshot to the history, if it hasn't one. Returns the history to
 * keep (the same object when nothing changed). All days are kept: a year is a few
 * hundred small entries per day.
 */
export function withSnapshot(history: LeaderboardHistory, pool: Record<string, PoolStat>, today: string): LeaderboardHistory {
  if (history[today]) return history;
  const day: Record<string, LeaderboardSnapshot> = {};
  for (const [key, stat] of Object.entries(pool)) {
    const k = splitKey(key);
    if (!k || runsOf(stat) === 0) continue;
    day[`${k.model}|${k.task}`] = { runs: runsOf(stat), low: Math.round(intervalOf(stat).low * 1000) / 1000 };
  }
  return { ...history, [today]: day };
}

/** The ranking for every task type, from the pool and, for trends and inactivity, its snapshots. */
export function buildLeaderboard(
  pool: Record<string, PoolStat>,
  opts: { history?: LeaderboardHistory; now?: Date; minRuns?: number; benchmark?: (model: string, task: TaskType) => number | undefined } = {},
): Leaderboard {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const minRuns = opts.minRuns ?? MIN_RANKED_RUNS;
  const benchmark = opts.benchmark ?? publishedBenchmark;
  const history = opts.history ?? {};
  const days = Object.keys(history).sort();
  // A snapshot about a week back: six to nine days old, the one nearest seven. The
  // history is kept only on the days the board is read, so the nearest older one
  // can be a month back, and a month's change shown as "7 days" would mislead.
  const weekAgo = days
    .filter((d) => { const age = (dayOf(today) - dayOf(d)) / dayMs; return age >= 6 && age <= 9; })
    .sort((a, b) => Math.abs((dayOf(today) - dayOf(a)) / dayMs - 7) - Math.abs((dayOf(today) - dayOf(b)) / dayMs - 7))[0];

  const tasks = Object.fromEntries(LEADERBOARD_TASKS.map((t) => [t, [] as LeaderboardRow[]])) as Record<TaskType, LeaderboardRow[]>;
  const models = new Set<string>();
  let totalRuns = 0;
  for (const [key, stat] of Object.entries(pool)) {
    const k = splitKey(key);
    if (!k) continue;
    // Runs, not observations: an explicit rating of a run is not another run, and
    // costs nothing, so counting it would inflate runs and shrink cost per run.
    const runs = runsOf(stat);
    totalRuns += runs;
    if (runs < minRuns) continue;
    models.add(k.model);
    const { score, low, high, successRate } = intervalOf(stat);
    const id = `${k.model}|${k.task}`;
    // The last day its run count went up: the first snapshot holding the count it has now.
    let lastRun: string | undefined;
    for (const d of days) {
      const snap = history[d]?.[id];
      if (snap && snap.runs >= runs) { lastRun = d; break; }
    }
    const inactive = lastRun !== undefined && dayOf(today) - dayOf(lastRun) >= INACTIVE_AFTER_DAYS * dayMs;
    const then = weekAgo ? history[weekAgo]?.[id] : undefined;
    const bench = benchmark(k.model, k.task);
    tasks[k.task].push({
      rank: 0,
      model: k.model,
      runs,
      successRate,
      score,
      low,
      high,
      confidence: runs >= 200 ? 'high' : runs >= 30 ? 'medium' : 'low',
      avgCostUsd: finite(stat.totalCostUsd) / runs,
      avgRetries: finite(stat.totalRetries) / runs,
      ...(bench !== undefined ? { benchmark: bench } : {}),
      ...(then ? { trend7d: Math.round((low - then.low) * 1000) / 10 } : {}),
      ...(lastRun ? { lastRun } : {}),
      ...(inactive ? { inactive: true } : {}),
    });
  }
  for (const rows of Object.values(tasks)) {
    // Active models first, each group by lower bound, then by runs.
    rows.sort((a, b) => Number(a.inactive === true) - Number(b.inactive === true) || b.low - a.low || b.runs - a.runs || a.model.localeCompare(b.model));
    rows.forEach((r, i) => { r.rank = i + 1; });
  }
  return { generatedAt: now.toISOString(), totalRuns, models: models.size, tasks };
}
