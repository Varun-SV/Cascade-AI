import { describe, it, expect } from 'vitest';
import { aggregateCostStats } from './cost-stats.js';
import type { Session } from '../types.js';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    title: overrides.id,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    identityId: 'default',
    workspacePath: '/w',
    messages: [],
    metadata: { totalTokens: 0, totalCostUsd: 0, modelsUsed: [], toolsUsed: [], taskCount: 0 },
    ...overrides,
  } as Session;
}

const NOW = new Date('2026-07-08T12:00:00.000Z');

describe('aggregateCostStats', () => {
  it('returns zero totals and a zero-filled window for no sessions', () => {
    const stats = aggregateCostStats([], { days: 7, now: NOW });
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.totalSessions).toBe(0);
    expect(stats.perDay).toHaveLength(7);
    expect(stats.perDay[0]!.date).toBe('2026-07-02');
    expect(stats.perDay[6]!.date).toBe('2026-07-08');
    expect(stats.perDay.every((d) => d.costUsd === 0 && d.tokens === 0 && d.runs === 0)).toBe(true);
    expect(stats.topSessions).toHaveLength(0);
  });

  it('buckets sessions into their updatedAt day and sums totals', () => {
    const sessions = [
      makeSession({
        id: 'a',
        updatedAt: '2026-07-08T01:00:00.000Z',
        metadata: { totalTokens: 1000, totalCostUsd: 0.5, modelsUsed: [], toolsUsed: [], taskCount: 2 },
      }),
      makeSession({
        id: 'b',
        updatedAt: '2026-07-08T23:00:00.000Z',
        metadata: { totalTokens: 500, totalCostUsd: 0.25, modelsUsed: [], toolsUsed: [], taskCount: 1 },
      }),
      makeSession({
        id: 'c',
        updatedAt: '2026-07-05T09:00:00.000Z',
        metadata: { totalTokens: 100, totalCostUsd: 0.1, modelsUsed: [], toolsUsed: [], taskCount: 1 },
      }),
    ];
    const stats = aggregateCostStats(sessions, { days: 7, now: NOW });
    expect(stats.totalCostUsd).toBeCloseTo(0.85);
    expect(stats.totalTokens).toBe(1600);
    expect(stats.totalRuns).toBe(4);
    const today = stats.perDay.find((d) => d.date === '2026-07-08')!;
    expect(today.costUsd).toBeCloseTo(0.75);
    expect(today.runs).toBe(3);
    const jul5 = stats.perDay.find((d) => d.date === '2026-07-05')!;
    expect(jul5.costUsd).toBeCloseTo(0.1);
  });

  it('counts sessions outside the day window in totals but not buckets', () => {
    const stats = aggregateCostStats([
      makeSession({
        id: 'old',
        updatedAt: '2026-01-01T00:00:00.000Z',
        metadata: { totalTokens: 9, totalCostUsd: 9, modelsUsed: [], toolsUsed: [], taskCount: 9 },
      }),
    ], { days: 7, now: NOW });
    expect(stats.totalCostUsd).toBe(9);
    expect(stats.perDay.every((d) => d.costUsd === 0)).toBe(true);
  });

  it('ranks top sessions by cost, excluding zero-cost ones, capped at topN', () => {
    const sessions = ['a', 'b', 'c', 'd'].map((id, i) => makeSession({
      id,
      updatedAt: '2026-07-08T00:00:00.000Z',
      metadata: { totalTokens: i, totalCostUsd: i * 0.1, modelsUsed: [], toolsUsed: [], taskCount: 1 },
    }));
    const stats = aggregateCostStats(sessions, { days: 7, topN: 2, now: NOW });
    expect(stats.topSessions.map((s) => s.sessionId)).toEqual(['d', 'c']);
  });

  it('tolerates malformed timestamps and missing metadata', () => {
    const broken = makeSession({ id: 'x', updatedAt: 'not-a-date' });
    (broken as { metadata?: unknown }).metadata = undefined;
    const stats = aggregateCostStats([broken], { days: 3, now: NOW });
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.totalSessions).toBe(1);
  });
});
