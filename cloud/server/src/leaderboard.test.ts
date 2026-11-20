import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LeaderboardService, poolFrom } from './leaderboard.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-board-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const writePool = (models: Record<string, unknown>) => fs.writeFile(path.join(dir, 'model-perf.json'), JSON.stringify({ models, features: { secret: { totalCostUsd: 1, runCount: 1 } } }));
const stat = (n: number, ok: number) => ({ successCount: ok, failureCount: n - ok, totalRetries: 0, totalCostUsd: n * 0.01, sampleCount: n });

describe('LeaderboardService', () => {
  it('keeps a snapshot a day beside the pool, and adds no second one the same day', async () => {
    await writePool({ 'm:code': stat(10, 9) });
    let now = new Date('2026-11-20T10:00:00Z');
    const svc = new LeaderboardService({ dataDir: dir, now: () => now, cacheMs: 0 });
    await svc.get();
    const h1 = JSON.parse(await fs.readFile(path.join(dir, 'leaderboard-history.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(h1)).toEqual(['2026-11-20']);
    await writePool({ 'm:code': stat(20, 18) });
    now = new Date('2026-11-20T18:00:00Z');
    await svc.get();
    const h2 = JSON.parse(await fs.readFile(path.join(dir, 'leaderboard-history.json'), 'utf8')) as Record<string, Record<string, { runs: number }>>;
    expect(h2['2026-11-20']!['m|code']!.runs).toBe(10);
    now = new Date('2026-11-21T09:00:00Z');
    const board = await svc.get();
    const h3 = JSON.parse(await fs.readFile(path.join(dir, 'leaderboard-history.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(h3)).toEqual(['2026-11-20', '2026-11-21']);
    expect(board.tasks.code[0]).toMatchObject({ model: 'm', runs: 20, lastRun: '2026-11-21' });
  });

  it('serves from its cache, reading the pool again only when it lapses', async () => {
    await writePool({ 'm:code': stat(10, 9) });
    let t = new Date('2026-11-20T10:00:00Z');
    const svc = new LeaderboardService({ dataDir: dir, now: () => t, cacheMs: 60_000 });
    expect((await svc.get()).totalRuns).toBe(10);
    await writePool({ 'm:code': stat(30, 27) });
    expect((await svc.get()).totalRuns).toBe(10);
    t = new Date('2026-11-20T10:02:00Z');
    expect((await svc.get()).totalRuns).toBe(30);
  });

  it('no pool yet: an empty board, and no snapshot written', async () => {
    const svc = new LeaderboardService({ dataDir: dir, cacheMs: 0 });
    expect(await svc.get()).toMatchObject({ totalRuns: 0, models: 0 });
    await expect(fs.access(path.join(dir, 'leaderboard-history.json'))).rejects.toThrow();
  });
});

describe('poolFrom', () => {
  it('reads both shapes the tracker writes, and nothing else from the file', () => {
    expect(Object.keys(poolFrom({ models: { 'a:code': stat(1, 1) }, features: { x: { totalCostUsd: 1, runCount: 1 } } }))).toEqual(['a:code']);
    expect(Object.keys(poolFrom({ 'a:code': stat(1, 1), junk: 'x' }))).toEqual(['a:code']);
    expect(poolFrom(null)).toEqual({});
  });
});
