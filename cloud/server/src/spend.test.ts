import { describe, it, expect } from 'vitest';
import { bucketKey, parsePeriod, parseTzOffset, periodRange, spendEntryFromRun } from './spend.js';

const base = { id: 'r1', userId: 'u1', conversationId: 'c1', at: 1_000 };

describe('spendEntryFromRun', () => {
  it('keeps a tier split across the models that served it', () => {
    const e = spendEntryFromRun({
      ...base,
      costUsd: 0.03,
      why: {
        savedUsd: 0.2, totalTokens: 900,
        costByTier: { T1: 0.01, T3: 0.02 },
        models: { T1: 'anthropic:big', T3: 'openai:mini' },
        costByModel: { T1: { 'anthropic:big': 0.01 }, T3: { 'openai:mini': 0.015, 'openai:nano': 0.005 } },
        tokensByModel: { T1: { 'anthropic:big': 100 }, T3: { 'openai:mini': 600, 'openai:nano': 200 } },
      },
    });
    expect(e).toMatchObject({ costUsd: 0.03, savedUsd: 0.2, tokens: 900, outcome: 'answered' });
    expect(e.lines).toEqual([
      { tier: 'T1', model: 'anthropic:big', costUsd: 0.01, tokens: 100 },
      { tier: 'T3', model: 'openai:mini', costUsd: 0.015, tokens: 600 },
      { tier: 'T3', model: 'openai:nano', costUsd: 0.005, tokens: 200 },
    ]);
  });

  it('reads an older report, which named one model per tier, from its stored JSON', () => {
    const e = spendEntryFromRun({
      ...base,
      costUsd: null,
      why: JSON.stringify({
        savedUsd: 0.05, totalCostUsd: 0.012, totalTokens: 400,
        costByTier: { T2: 0.012, T3: 0 }, tokensByTier: { T2: 300, T3: 100 }, models: { T2: 'openai:mid' },
      }),
    });
    // With no cost on the reply, the report's own total stands in.
    expect(e.costUsd).toBe(0.012);
    expect(e.lines).toEqual([
      { tier: 'T2', model: 'openai:mid', costUsd: 0.012, tokens: 300 },
      // Tokens with no price (an unpriced model) are still kept, under no model name.
      { tier: 'T3', model: '', costUsd: 0, tokens: 100 },
    ]);
  });

  it('prefers the cost stored on the reply, and never counts a negative saving', () => {
    const e = spendEntryFromRun({ ...base, costUsd: 0.5, why: { totalCostUsd: 0.4, savedUsd: -0.1 } });
    expect(e.costUsd).toBe(0.5);
    expect(e.savedUsd).toBe(0);
  });

  it('survives a report it cannot read', () => {
    const e = spendEntryFromRun({ ...base, costUsd: 0.01, why: '{not json', outcome: 'failed' });
    expect(e).toMatchObject({ costUsd: 0.01, savedUsd: 0, tokens: 0, outcome: 'failed', lines: [] });
  });

  it('drops tiers that spent nothing at all', () => {
    const e = spendEntryFromRun({ ...base, why: { costByTier: { T1: 0, T2: 0.001 }, tokensByTier: { T1: 0, T2: 10 } } });
    expect(e.lines.map((l) => l.tier)).toEqual(['T2']);
  });
});

describe('report periods', () => {
  // 2026-09-29 20:00 UTC is already 01:30 on the 30th in India (UTC+5:30).
  const now = Date.UTC(2026, 8, 29, 20, 0);
  const IST = 330;

  it('reads bucket keys in the viewer\'s local time', () => {
    expect(bucketKey(now, 0, 'day')).toBe('2026-09-29');
    expect(bucketKey(now, IST, 'day')).toBe('2026-09-30');
    expect(bucketKey(now, IST, 'hour')).toBe('2026-09-30 01');
    expect(bucketKey(now, -300, 'month')).toBe('2026-09');
  });

  it('starts today at the viewer\'s midnight, in hours', () => {
    const r = periodRange('today', IST, now, null);
    expect(r.fromMs).toBe(Date.UTC(2026, 8, 29, 18, 30)); // 00:00 on the 30th in India
    expect(r.bucket).toBe('hour');
    expect(r.keys).toHaveLength(24);
    expect(r.keys[0]).toBe('2026-09-30 00');
    expect(r.keys[23]).toBe('2026-09-30 23');
  });

  it('covers 7 and 30 whole local days ending today', () => {
    const week = periodRange('7d', 0, now, null);
    expect(week.fromMs).toBe(Date.UTC(2026, 8, 23));
    expect(week.keys).toEqual(['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']);
    const month = periodRange('30d', IST, now, null);
    expect(month.keys).toHaveLength(30);
    expect(month.keys[29]).toBe('2026-09-30');
    expect(month.keys[0]).toBe('2026-09-01');
  });

  it('runs a short all-time history day by day, from the first run\'s day', () => {
    const r = periodRange('all', 0, now, Date.UTC(2026, 8, 27, 23, 0));
    expect(r.fromMs).toBeNull();
    expect(r.bucket).toBe('day');
    expect(r.keys).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
    // Sixty days is still daily; a day more switches to months.
    expect(periodRange('all', 0, now, now - 59 * 86_400_000).bucket).toBe('day');
    expect(periodRange('all', 0, now, now - 60 * 86_400_000).bucket).toBe('month');
  });

  it('runs a longer all-time history month by month, across a year end', () => {
    const r = periodRange('all', 0, now, Date.UTC(2025, 10, 15));
    expect(r.fromMs).toBeNull();
    expect(r.keys[0]).toBe('2025-11');
    expect(r.keys).toContain('2026-01');
    expect(r.keys[r.keys.length - 1]).toBe('2026-09');
    expect(r.keys).toHaveLength(11);
    expect(periodRange('all', 0, now, null).keys).toEqual([]);
  });

  it('accepts only the four periods and real UTC offsets', () => {
    expect(parsePeriod('7d')).toBe('7d');
    expect(parsePeriod('90d')).toBeNull();
    expect(parsePeriod(['7d'])).toBeNull();
    expect(parseTzOffset(undefined)).toBe(0);
    expect(parseTzOffset('330')).toBe(330);
    expect(parseTzOffset('-300')).toBe(-300);
    expect(parseTzOffset('841')).toBeNull();
    expect(parseTzOffset('5.5')).toBeNull();
    expect(parseTzOffset('')).toBeNull();
  });
});
