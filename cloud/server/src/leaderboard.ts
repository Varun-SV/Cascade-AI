// ─────────────────────────────────────────────
//  Cascade Cloud — the public model leaderboard
// ─────────────────────────────────────────────
//
//  Served from the shared learning pool every run on this deployment feeds
//  (model-perf.json on the data volume): counts and sums per model and task
//  type, never a prompt, an answer or a user. The ranking itself is the SDK's
//  (core/router/leaderboard.ts); this keeps a snapshot a day beside the pool,
//  so the board can show a week's trend and say when a model stopped being
//  run, and caches the answer so a busy landing page reads the pool rarely.

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildLeaderboard, withSnapshot, type Leaderboard, type LeaderboardHistory, type PoolStat } from '#cascade-ai';

/** How long one answer is served before the pool is read again. */
const CACHE_MS = 5 * 60_000;

export interface LeaderboardServiceOptions {
  dataDir: string;
  now?: () => Date;
  cacheMs?: number;
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return null; }
}

/** Written whole or not at all: a reader never sees half a file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.rename(tmp, file);
}

/** The pool's models, in either of the shapes the tracker has written. */
export function poolFrom(raw: unknown): Record<string, PoolStat> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as { models?: unknown };
  const models = (r.models && typeof r.models === 'object' ? r.models : raw) as Record<string, unknown>;
  const out: Record<string, PoolStat> = {};
  for (const [key, v] of Object.entries(models)) {
    const s = v as Partial<PoolStat> | null;
    if (s && typeof s === 'object' && typeof s.sampleCount === 'number' && typeof s.successCount === 'number') {
      out[key] = {
        successCount: s.successCount, failureCount: Number(s.failureCount) || 0,
        totalRetries: Number(s.totalRetries) || 0, totalCostUsd: Number(s.totalCostUsd) || 0, sampleCount: s.sampleCount,
        ...(typeof s.explicitCount === 'number' ? { explicitCount: s.explicitCount } : {}),
      };
    }
  }
  return out;
}

export class LeaderboardService {
  private cached: { at: number; board: Leaderboard } | null = null;
  private building: Promise<Leaderboard> | null = null;
  private readonly poolFile: string;
  private readonly historyFile: string;
  private readonly now: () => Date;
  private readonly cacheMs: number;

  constructor(opts: LeaderboardServiceOptions) {
    this.poolFile = path.join(opts.dataDir, 'model-perf.json');
    this.historyFile = path.join(opts.dataDir, 'leaderboard-history.json');
    this.now = opts.now ?? (() => new Date());
    this.cacheMs = opts.cacheMs ?? CACHE_MS;
  }

  /** The board, at most `cacheMs` old. One read of the pool at a time, however many ask. */
  async get(): Promise<Leaderboard> {
    const t = this.now().getTime();
    if (this.cached && t - this.cached.at < this.cacheMs) return this.cached.board;
    this.building ??= this.build().finally(() => { this.building = null; });
    return this.building;
  }

  private async build(): Promise<Leaderboard> {
    const now = this.now();
    const pool = poolFrom(await readJson(this.poolFile));
    const before = (await readJson<LeaderboardHistory>(this.historyFile)) ?? {};
    const history = withSnapshot(before, pool, now.toISOString().slice(0, 10));
    // Today's snapshot, once a day. Losing one (a full disk) costs a day of trend, not the board.
    if (history !== before && Object.keys(pool).length) await writeJson(this.historyFile, history).catch(() => {});
    const board = buildLeaderboard(pool, { history, now });
    this.cached = { at: now.getTime(), board };
    return board;
  }
}
