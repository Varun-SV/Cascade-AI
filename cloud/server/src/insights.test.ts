import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudStore } from './db.js';
import { spendEntryFromRun, type SpendSurface } from './spend.js';
import { closedWeeks, everyoneView, isoWeek, MIN_RUNS, MIN_USERS, publishable, releaseClosedWeeks, weekStart } from './insights.js';

const DAY = 86_400_000;
// Monday 2 Nov 2026, 00:00 UTC: ISO week 2026-W45.
const W45 = Date.UTC(2026, 10, 2);

describe('ISO weeks', () => {
  it('start on Monday, UTC, and take their year from their Thursday', () => {
    expect(isoWeek(W45)).toBe('2026-W45');
    expect(isoWeek(W45 + 6 * DAY + DAY - 1)).toBe('2026-W45');
    expect(isoWeek(W45 + 7 * DAY)).toBe('2026-W46');
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe('2026-W01'); // Thursday
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe('2026-W53'); // Friday, so 2026's last week
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe('2025-W01'); // Monday of 2025's first week
    expect(weekStart(W45 + 3 * DAY + 5000)).toBe(W45);
  });

  it('a week is closed only once it has ended', () => {
    expect(closedWeeks(W45 + DAY, W45 + 7 * DAY - 1)).toEqual([]);
    expect(closedWeeks(W45 + DAY, W45 + 7 * DAY).map((w) => w.week)).toEqual(['2026-W45']);
    expect(closedWeeks(W45, W45 + 15 * DAY).map((w) => w.week)).toEqual(['2026-W45', '2026-W46']);
  });
});

describe('what may be published', () => {
  const cell = (runs: number, users: number) => ({ surface: 'cloud' as const, tier: 'T3', model: 'm', runs, users, costUsd: 1, tokens: 10 });
  it('a cell needs both minimums; the user count is never published', () => {
    expect(publishable([cell(MIN_RUNS, MIN_USERS)])).toEqual([{ surface: 'cloud', tier: 'T3', model: 'm', runs: MIN_RUNS, costUsd: 1, tokens: 10 }]);
    expect(publishable([cell(MIN_RUNS - 1, 50)])).toEqual([]);
    expect(publishable([cell(500, MIN_USERS - 1)])).toEqual([]);
  });
});

describe('weekly releases from the ledger', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-insights-'));
    const store = new CloudStore(path.join(dir, 'cloud.db'));
    const users = Array.from({ length: 8 }, (_, i) => store.upsertUser({ provider: 'github', providerId: `u${i}`, email: null, name: null, avatar: null }).id);
    let n = 0;
    const run = (userId: string, at: number, surface: SpendSurface | null, model = 'openai:mini', cost = 0.01) =>
      store.recordSpend(spendEntryFromRun({ id: `r${++n}`, userId, conversationId: null, at, costUsd: cost, surface,
        why: { costByModel: { T3: { [model]: cost } }, tokensByModel: { T3: { [model]: 100 } } } }));
    return { store, users, run, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  };

  it('publishes a week once it closes, only cells over the minimums, and never revises it', () => {
    const s = setup();
    try {
      // Week 45: cloud/mini, 25 runs from 5 users: published. cli/mini, 25 runs from 2 users: held back.
      for (let i = 0; i < 25; i++) s.run(s.users[i % 5]!, W45 + DAY + i, 'cloud');
      for (let i = 0; i < 25; i++) s.run(s.users[i % 2]!, W45 + DAY + i, 'cli');
      // Not yet closed: nothing released.
      expect(releaseClosedWeeks(s.store.insights, W45 + 6 * DAY)).toEqual([]);
      expect(releaseClosedWeeks(s.store.insights, W45 + 7 * DAY + 1)).toEqual(['2026-W45']);
      const v = everyoneView(s.store.insights, null, 1, W45 + 7 * DAY + 1);
      expect(v.label).toBe('week 2026-W45');
      expect(v.rows).toEqual([{ tier: 'T3', model: 'openai:mini', runs: 25, costUsd: expect.closeTo(0.25, 8), tokens: 2500 }]);
      // A late run for the closed week, and enough of them to cross the minimums: still not in it.
      for (let i = 0; i < 30; i++) s.run(s.users[i % 6]!, W45 + 2 * DAY, 'cli');
      expect(releaseClosedWeeks(s.store.insights, W45 + 8 * DAY)).toEqual([]);
      expect(everyoneView(s.store.insights, 'cli', 1, W45 + 8 * DAY).rows).toEqual([]);
      expect(everyoneView(s.store.insights, null, 1, W45 + 8 * DAY).rows[0]!.runs).toBe(25);
    } finally { s.done(); }
  });

  it('"all surfaces" and a span of weeks are sums of published cells, so a held-back cell is never in any figure', () => {
    const s = setup();
    try {
      for (const [week, surface, users, runs] of [[0, 'cloud', 5, 20], [0, 'desktop', 5, 20], [0, 'cli', 3, 40], [1, 'cloud', 6, 30]] as const) {
        for (let i = 0; i < runs; i++) s.run(s.users[i % users]!, W45 + week * 7 * DAY + DAY, surface);
      }
      releaseClosedWeeks(s.store.insights, W45 + 14 * DAY);
      const all = everyoneView(s.store.insights, null, 2, W45 + 14 * DAY);
      expect(all.label).toBe('weeks 2026-W45–2026-W46');
      expect(all.weeks.map((w) => [w.week, w.rows[0]?.runs])).toEqual([['2026-W45', 40], ['2026-W46', 30]]);
      // 40 + 30, not 110: the CLI's 40 runs from 3 users are in no figure at all.
      expect(all.rows.map((r) => r.runs)).toEqual([70]);
      expect(everyoneView(s.store.insights, 'cli', 2, W45 + 14 * DAY).rows).toEqual([]);
    } finally { s.done(); }
  });

  it('rows with no surface (from before surfaces were kept) are in no release', () => {
    const s = setup();
    try {
      for (let i = 0; i < 40; i++) s.run(s.users[i % 8]!, W45 + DAY, null);
      expect(releaseClosedWeeks(s.store.insights, W45 + 14 * DAY)).toEqual([]);
    } finally { s.done(); }
  });
});
