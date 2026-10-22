import { describe, it, expect } from 'vitest';
import { bucketKey, buildSpendReport, legacyCliRunCost, parsePeriod, parseTimeZone, parseTzOffset, periodRange, spendEntryFromRun, type SpendSource } from './spend.js';

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
      { tier: 'T1', model: 'anthropic:big', costUsd: 0.01, tokens: 100, unpriced: null },
      { tier: 'T3', model: 'openai:mini', costUsd: 0.015, tokens: 600, unpriced: null },
      { tier: 'T3', model: 'openai:nano', costUsd: 0.005, tokens: 200, unpriced: null },
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
      { tier: 'T2', model: 'openai:mid', costUsd: 0.012, tokens: 300, unpriced: null },
      // Tokens at $0 are still kept, under no model name; whether they were
      // priced is unknown for a report this old.
      { tier: 'T3', model: '', costUsd: 0, tokens: 100, unpriced: null },
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

  it('tells a free local model from one with no price, when the report says', () => {
    const e = spendEntryFromRun({
      ...base,
      why: {
        costByModel: { T3: { 'ollama:llama': 0, 'compat:mystery': 0, 'openai:mini': 0.002 } },
        tokensByModel: { T3: { 'ollama:llama': 1000, 'compat:mystery': 500, 'openai:mini': 300 } },
        unpricedByModel: { T3: { 'compat:mystery': 2 } },
      },
    });
    expect(e.lines).toEqual([
      { tier: 'T3', model: 'ollama:llama', costUsd: 0, tokens: 1000, unpriced: false },
      { tier: 'T3', model: 'compat:mystery', costUsd: 0, tokens: 500, unpriced: true },
      { tier: 'T3', model: 'openai:mini', costUsd: 0.002, tokens: 300, unpriced: false },
    ]);
    // An empty map still says every model was priced.
    const allPriced = spendEntryFromRun({ ...base, why: { costByModel: { T3: { 'ollama:llama': 0 } }, tokensByModel: { T3: { 'ollama:llama': 10 } }, unpricedByModel: {} } });
    expect(allPriced.lines[0]!.unpriced).toBe(false);
  });

  it('counts no saving for an older run whose $0 model may have had no price', () => {
    const legacy = spendEntryFromRun({
      ...base,
      why: { savedUsd: 0.3, costByModel: { T3: { 'compat:mystery': 0 } }, tokensByModel: { T3: { 'compat:mystery': 900 } } },
    });
    expect(legacy.savedUsd).toBe(0);
    // A newer report says it was priced (a free local model): its saving stands.
    const priced = spendEntryFromRun({
      ...base,
      why: { savedUsd: 0.3, costByModel: { T3: { 'ollama:llama': 0 } }, tokensByModel: { T3: { 'ollama:llama': 900 } }, unpricedByModel: {} },
    });
    expect(priced.savedUsd).toBe(0.3);
    // An older report with every model priced above $0 keeps its saving too.
    const paid = spendEntryFromRun({ ...base, why: { savedUsd: 0.3, costByTier: { T3: 0.01 }, tokensByTier: { T3: 900 } } });
    expect(paid.savedUsd).toBe(0.3);
  });

  it('keeps an unpriced call that reported no usage', () => {
    const e = spendEntryFromRun({
      ...base,
      why: { costByModel: {}, tokensByModel: {}, unpricedByModel: { T3: { 'compat:mystery': 1 } } },
    });
    // Its cost is unknown, which the report says, rather than an exact $0.
    expect(e.lines).toEqual([{ tier: 'T3', model: 'compat:mystery', costUsd: 0, tokens: 0, unpriced: true }]);
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

  describe('in a time zone with daylight saving', () => {
    // London: BST (UTC+1) until 02:00 on 25 Oct 2026, GMT (UTC+0) after.
    const LONDON = 'Europe/London';
    const afterChange = Date.UTC(2026, 9, 26, 12, 0); // Mon 26 Oct, GMT

    it('reads each instant under the offset in force then, not today\'s', () => {
      // 23:30 UTC on 24 Oct is 00:30 on the 25th in BST: a fixed GMT offset
      // (today's) would put it on the 24th.
      const lateOnThe24th = Date.UTC(2026, 9, 24, 23, 30);
      expect(bucketKey(lateOnThe24th, LONDON, 'day')).toBe('2026-10-25');
      expect(bucketKey(lateOnThe24th, 0, 'day')).toBe('2026-10-24');
      expect(bucketKey(afterChange, LONDON, 'hour')).toBe('2026-10-26 12');
    });

    it('starts each day at its own local midnight', () => {
      const week = periodRange('7d', LONDON, afterChange, null);
      expect(week.keys).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);
      // 00:00 BST on the 20th is 23:00 UTC on the 19th: not 24 × 7 hours back.
      expect(week.fromMs).toBe(Date.UTC(2026, 9, 19, 23, 0));
    });

    it('gives the change day its 25 hours, with the repeated hour as one slot', () => {
      const changeDay = Date.UTC(2026, 9, 25, 12, 0);
      const r = periodRange('today', LONDON, changeDay, null);
      expect(r.fromMs).toBe(Date.UTC(2026, 9, 24, 23, 0)); // 00:00 BST
      expect(r.keys).toHaveLength(24);
      expect(r.keys.filter((k) => k === '2026-10-25 01')).toHaveLength(1);
      expect(r.keys[23]).toBe('2026-10-25 23');
    });

    it('puts runs into the right local day in the report', () => {
      const source: SpendSource = {
        firstSpendAt: () => null,
        spendTotals: () => ({ spentUsd: 0, savedUsd: 0, runs: 0, tokens: 0, failedRuns: 0, failedUsd: 0 }),
        spendRuns: () => [
          { at: Date.UTC(2026, 9, 24, 23, 30), spentUsd: 1, savedUsd: 0 }, // 00:30 BST on the 25th
          { at: Date.UTC(2026, 9, 25, 23, 30), spentUsd: 2, savedUsd: 0 }, // 23:30 GMT on the 25th
          { at: Date.UTC(2026, 9, 26, 0, 30), spentUsd: 4, savedUsd: 0 },  // 00:30 GMT on the 26th
        ],
        spendByTierModel: () => [],
        spendTopChats: () => [],
      };
      const report = buildSpendReport(source, 'u1', '7d', LONDON, afterChange);
      const byDay = Object.fromEntries(report.series.map((s) => [s.key, s.spentUsd]));
      expect(byDay['2026-10-24']).toBe(0);
      expect(byDay['2026-10-25']).toBe(3);
      expect(byDay['2026-10-26']).toBe(4);
    });

    it('accepts a real zone name and refuses anything else', () => {
      expect(parseTimeZone('Europe/London')).toBe('Europe/London');
      expect(parseTimeZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
      expect(parseTimeZone('UTC')).toBe('UTC');
      expect(parseTimeZone('330')).toBe(330);
      expect(parseTimeZone(undefined)).toBe(0);
      expect(parseTimeZone('Mars/Olympus_Mons')).toBeNull();
      expect(parseTimeZone('../etc/passwd')).toBeNull();
      expect(parseTimeZone(['Europe/London'])).toBeNull();
    });
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

describe('legacyCliRunCost', () => {
  it('takes what an old CLI\'s running total grew by', () => {
    expect(legacyCliRunCost(0.01, null)).toBeCloseTo(0.01, 12);
    expect(legacyCliRunCost(0.03, 0.01)).toBeCloseTo(0.02, 12);
    expect(legacyCliRunCost(0.03, 0.03)).toBe(0);
  });

  it('reads a total that went down as a new session, all its own', () => {
    expect(legacyCliRunCost(0.002, 0.05)).toBeCloseTo(0.002, 12);
  });

  it('never goes negative or counts nonsense', () => {
    expect(legacyCliRunCost(-1, null)).toBe(0);
    expect(legacyCliRunCost(Number.NaN, 0.01)).toBe(0);
  });
});
