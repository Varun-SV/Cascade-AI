import { describe, it, expect } from 'vitest';
import { buildLeaderboard, withSnapshot, publishedBenchmark, type PoolStat, type LeaderboardHistory } from './leaderboard.js';

const stat = (runs: number, rate: number, extra: Partial<PoolStat> = {}): PoolStat => ({
  successCount: runs * rate, failureCount: runs * (1 - rate), totalRetries: 0, totalCostUsd: runs * 0.01, sampleCount: runs, ...extra,
});
const now = new Date('2026-11-20T12:00:00Z');
const noBench = () => undefined;

describe('buildLeaderboard', () => {
  it('ranks by what is known at least, not by a lucky streak', () => {
    const board = buildLeaderboard({
      'lucky-model:code': stat(6, 1),
      'proven-model:code': stat(500, 0.93),
      'middling:code': stat(400, 0.7),
    }, { now, benchmark: noBench });
    // Six for six reads 100%, but six runs prove little: it ranks below 400 runs at 70%.
    expect(board.tasks.code.map((r) => r.model)).toEqual(['proven-model', 'middling', 'lucky-model']);
    const lucky = board.tasks.code.find((r) => r.model === 'lucky-model')!;
    expect(lucky.successRate).toBe(1);
    expect(lucky.low).toBeLessThan(lucky.score);
    expect(lucky.high).toBeGreaterThan(lucky.score);
    expect(lucky.confidence).toBe('low');
    expect(board.tasks.code[0]!.confidence).toBe('high');
    expect(board.tasks.code.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('keeps each task type apart, splits model ids at the last colon, and skips too few runs', () => {
    const board = buildLeaderboard({
      'ollama/qwen3:32b:analysis': stat(20, 0.8),
      'gpt-x:creative': stat(10, 0.9),
      'tiny:data': stat(3, 1),
      'not-a-key': stat(50, 1),
      'weird:unknown-task': stat(50, 1),
    }, { now, benchmark: noBench });
    expect(board.tasks.analysis.map((r) => r.model)).toEqual(['ollama/qwen3:32b']);
    expect(board.tasks.creative.map((r) => r.model)).toEqual(['gpt-x']);
    expect(board.tasks.data).toEqual([]);
    expect(board.totalRuns).toBe(33);
    expect(board.models).toBe(2);
  });

  it('reports cost and retries per run, and the published benchmark beside it', () => {
    const board = buildLeaderboard({ 'm:code': stat(10, 0.8, { totalCostUsd: 0.5, totalRetries: 5 }) }, { now, benchmark: (m, t) => (m === 'm' && t === 'code' ? 88 : undefined) });
    expect(board.tasks.code[0]).toMatchObject({ avgCostUsd: 0.05, avgRetries: 0.5, benchmark: 88 });
  });

  it('never forgets a model routing stopped choosing: it stays, marked inactive, below the active ones', () => {
    const pool = { 'old-model:code': stat(300, 0.95), 'new-model:code': stat(40, 0.8) };
    const history: LeaderboardHistory = {
      '2026-09-01': { 'old-model|code': { runs: 300, low: 0.9 } },
      '2026-11-19': { 'old-model|code': { runs: 300, low: 0.9 }, 'new-model|code': { runs: 40, low: 0.7 } },
    };
    const board = buildLeaderboard(pool, { now, history, benchmark: noBench });
    expect(board.tasks.code.map((r) => [r.model, r.inactive === true, r.lastRun])).toEqual([
      ['new-model', false, '2026-11-19'],
      ['old-model', true, '2026-09-01'],
    ]);
  });

  it('shows the change against the snapshot about a week back', () => {
    const pool = { 'm:code': stat(100, 0.9) };
    const history: LeaderboardHistory = { '2026-11-12': { 'm|code': { runs: 50, low: 0.7 } } };
    const row = buildLeaderboard(pool, { now, history, benchmark: noBench }).tasks.code[0]!;
    expect(row.trend7d).toBeCloseTo((row.low - 0.7) * 100, 0);
    expect(buildLeaderboard(pool, { now, history: { '2026-11-18': { 'm|code': { runs: 50, low: 0.7 } } }, benchmark: noBench }).tasks.code[0]!.trend7d).toBeUndefined();
  });

  it('the 7-day change reads only a snapshot six to nine days back, never a month-old one (Codex on dcf6cb4)', () => {
    const pool = { 'm:code': stat(100, 0.9) };
    const at = (day: string) => buildLeaderboard(pool, { now, history: { [day]: { 'm|code': { runs: 50, low: 0.7 } } }, benchmark: noBench }).tasks.code[0]!.trend7d;
    expect(at('2026-11-12')).toEqual(expect.any(Number));
    expect(at('2026-11-11')).toEqual(expect.any(Number));
    expect(at('2026-10-20')).toBeUndefined();
    expect(at('2026-11-10')).toBeUndefined();
  });

  it('counts runs, not ratings of them: cost per run and run totals leave ratings out (Codex on dcf6cb4)', () => {
    // Ten $0.10 runs, then ten thumbs on them.
    const board = buildLeaderboard({ 'm:code': { successCount: 40, failureCount: 0, totalRetries: 0, totalCostUsd: 1, sampleCount: 20, explicitCount: 10 } }, { now, benchmark: noBench });
    expect(board.totalRuns).toBe(10);
    expect(board.tasks.code[0]).toMatchObject({ runs: 10, avgCostUsd: 0.1 });
    // Without the count (an older pool), every observation is taken for a run, as before.
    expect(buildLeaderboard({ 'm:code': stat(20, 1) }, { now, benchmark: noBench }).tasks.code[0]!.runs).toBe(20);
  });

  it('holds nothing but counts: no field of a row is text from a run', () => {
    const row = buildLeaderboard({ 'm:code': stat(10, 0.8) }, { now, benchmark: noBench }).tasks.code[0]!;
    expect(Object.keys(row).sort()).toEqual(['avgCostUsd', 'avgRetries', 'confidence', 'high', 'low', 'model', 'rank', 'runs', 'score', 'successRate']);
  });
});

describe('withSnapshot', () => {
  it('adds today once, with counts and lower bounds only', () => {
    const pool = { 'm:code': stat(10, 0.8), 'm:bogus': stat(10, 0.8) };
    const h1 = withSnapshot({}, pool, '2026-11-20');
    expect(Object.keys(h1)).toEqual(['2026-11-20']);
    expect(h1['2026-11-20']).toEqual({ 'm|code': { runs: 10, low: expect.any(Number) } });
    expect(withSnapshot(h1, { 'm:code': stat(99, 0.1) }, '2026-11-20')).toBe(h1);
  });
});

describe('publishedBenchmark', () => {
  it('a model a board measured has a score; one nobody measured has none', () => {
    expect(publishedBenchmark('claude-sonnet-5-5', 'code')).toEqual(expect.any(Number));
    expect(publishedBenchmark('totally-unknown-model-xyz', 'code')).toBeUndefined();
  });

  it('a carried seed, or a later release mapped onto a measured one, is no published score (Codex on dcf6cb4)', () => {
    expect(publishedBenchmark('ollama/qwen3:32b', 'code')).toBeUndefined();
    expect(publishedBenchmark('llama3.1:8b', 'code')).toBeUndefined();
    expect(publishedBenchmark('claude-3-opus-20240229', 'code')).toBeUndefined();
  });
});
