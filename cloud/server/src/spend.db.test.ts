import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { CloudStore } from './db.js';
import { buildSpendReport, deviceRunSpendId, spendEntryFromRun, type SpendOutcome } from './spend.js';
import { recordSettledRunSpend, FOLLOW_UP_WAIT_MS } from './runs.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 29, 12, 0);

describe('spend ledger', () => {
  let dir: string;
  let dbPath: string;
  let store: CloudStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-spend-'));
    dbPath = path.join(dir, 'cloud.db');
    store = new CloudStore(dbPath);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const user = (id: string) => store.upsertUser({ provider: 'github', providerId: id, email: null, name: null, avatar: null });

  let seq = 0;
  function run(userId: string, conversationId: string | null, at: number, costUsd: number, savedUsd: number, outcome: SpendOutcome = 'answered') {
    store.recordSpend(spendEntryFromRun({
      id: `run-${++seq}`, userId, conversationId, at, costUsd, outcome,
      why: {
        savedUsd, totalTokens: 1000,
        costByModel: { T1: { 'anthropic:big': costUsd * 0.25 }, T3: { 'openai:mini': costUsd * 0.5, 'openai:nano': costUsd * 0.25 } },
        tokensByModel: { T1: { 'anthropic:big': 100 }, T3: { 'openai:mini': 600, 'openai:nano': 300 } },
      },
    }));
  }

  it('reports a period\'s totals, days, tiers with their models, and costliest chats', () => {
    const u = user('a');
    const big = store.createConversation(u.id, 'Big report');
    const small = store.createConversation(u.id, 'Quick question');
    run(u.id, big.id, NOW - 1 * DAY, 0.4, 1.2);
    run(u.id, big.id, NOW, 0.2, 0.6);
    run(u.id, small.id, NOW, 0.04, 0.1);
    run(u.id, small.id, NOW - 20 * DAY, 9, 9); // outside the week

    const r = buildSpendReport(store.spend, u.id, '7d', 0, NOW);
    expect(r.totals).toMatchObject({ runs: 3, tokens: 3000, failedRuns: 0, failedUsd: 0 });
    expect(r.totals.spentUsd).toBeCloseTo(0.64, 9);
    expect(r.totals.savedUsd).toBeCloseTo(1.9, 9);

    expect(r.bucket).toBe('day');
    expect(r.series).toHaveLength(7);
    expect(r.series[5]).toMatchObject({ key: '2026-09-28', runs: 1 });
    expect(r.series[6]!.spentUsd).toBeCloseTo(0.24, 9);
    expect(r.series[0]).toEqual({ key: '2026-09-23', spentUsd: 0, savedUsd: 0, runs: 0 });

    expect(r.tiers.map((t) => t.tier)).toEqual(['T1', 'T3']);
    const t3 = r.tiers[1]!;
    expect(t3.runs).toBe(3); // three runs used T3, though each used two models there
    expect(t3.spentUsd).toBeCloseTo(0.48, 9);
    expect(t3.models.map((m) => m.model)).toEqual(['openai:mini', 'openai:nano']);
    expect(t3.models[0]!.spentUsd).toBeCloseTo(0.32, 9);
    expect(t3.models[0]!.tokens).toBe(1800);

    expect(r.chats.map((c) => c.title)).toEqual(['Big report', 'Quick question']);
    expect(r.chats[0]).toMatchObject({ conversationId: big.id, runs: 2 });

    const all = buildSpendReport(store.spend, u.id, 'all', 0, NOW);
    expect(all.totals.runs).toBe(4);
    // Twenty-one days of history: all time is day by day, from the first run.
    expect(all.bucket).toBe('day');
    expect(all.series).toHaveLength(21);
    expect(all.series[0]).toMatchObject({ key: '2026-09-09', runs: 1 });
  });

  it('keeps a deleted chat\'s spend, counted together as deleted chats', () => {
    const u = user('b');
    const kept = store.createConversation(u.id, 'Kept');
    const gone1 = store.createConversation(u.id, 'Gone 1');
    const gone2 = store.createConversation(u.id, 'Gone 2');
    run(u.id, kept.id, NOW, 0.1, 0);
    run(u.id, gone1.id, NOW, 0.2, 0);
    run(u.id, gone2.id, NOW, 0.3, 0);
    store.deleteConversation(gone1.id, u.id);
    store.deleteConversation(gone2.id, u.id);

    const r = buildSpendReport(store.spend, u.id, 'today', 0, NOW);
    expect(r.totals.spentUsd).toBeCloseTo(0.6, 9);
    expect(r.chats).toHaveLength(2);
    expect(r.chats[0]).toMatchObject({ conversationId: null, title: null, runs: 2 });
    expect(r.chats[0]!.spentUsd).toBeCloseTo(0.5, 9);
    expect(r.chats[1]).toMatchObject({ conversationId: kept.id, title: 'Kept' });

    // Clearing every chat does not clear the money either.
    store.deleteAllConversations(u.id);
    expect(buildSpendReport(store.spend, u.id, 'today', 0, NOW).totals.runs).toBe(3);
  });

  it('shows each user only their own spend', () => {
    const me = user('c');
    const other = user('d');
    const mine = store.createConversation(me.id, 'Mine');
    const theirs = store.createConversation(other.id, 'Theirs');
    run(me.id, mine.id, NOW, 0.1, 0);
    run(other.id, theirs.id, NOW, 5, 5);
    // A ledger row naming someone else's chat does not reveal its title.
    run(me.id, theirs.id, NOW, 0.01, 0);

    const r = buildSpendReport(store.spend, me.id, 'all', 0, NOW);
    expect(r.totals.runs).toBe(2);
    expect(r.totals.spentUsd).toBeCloseTo(0.11, 9);
    expect(r.chats.map((c) => c.title)).toEqual(['Mine', null]);
  });

  it('counts what failed runs spent, and a run recorded twice once', () => {
    const u = user('e');
    const c = store.createConversation(u.id, 'Flaky');
    run(u.id, c.id, NOW, 0.05, 0, 'failed');
    const twice = spendEntryFromRun({ id: 'same', userId: u.id, conversationId: c.id, at: NOW, costUsd: 0.2, why: { costByTier: { T2: 0.2 } } });
    store.recordSpend(twice);
    store.recordSpend(twice);

    const r = buildSpendReport(store.spend, u.id, 'today', 0, NOW);
    expect(r.totals).toMatchObject({ runs: 2, failedRuns: 1 });
    expect(r.totals.failedUsd).toBeCloseTo(0.05, 9);
    expect(r.totals.spentUsd).toBeCloseTo(0.25, 9);
    expect(r.tiers.find((t) => t.tier === 'T2')!.spentUsd).toBeCloseTo(0.2, 9);
  });

  it('counts a run once per tier, however many models it used there', () => {
    const u = user('i');
    const c = store.createConversation(u.id, 'Mixed');
    store.recordSpend(spendEntryFromRun({ id: 'both', userId: u.id, conversationId: c.id, at: NOW, costUsd: 0.3, why: { costByModel: { T3: { 'openai:mini': 0.2, 'openai:nano': 0.05 } } } }));
    store.recordSpend(spendEntryFromRun({ id: 'nano', userId: u.id, conversationId: c.id, at: NOW, costUsd: 0.1, why: { costByModel: { T3: { 'openai:nano': 0.1 } } } }));
    const t3 = buildSpendReport(store.spend, u.id, 'today', 0, NOW).tiers[0]!;
    expect(t3.runs).toBe(2);
    expect(Object.fromEntries(t3.models.map((m) => [m.model, m.runs]))).toEqual({ 'openai:mini': 1, 'openai:nano': 2 });
    expect(t3.models.map((m) => m.model)).toEqual(['openai:mini', 'openai:nano']);
  });

  it('puts a run on the viewer\'s local day', () => {
    const u = user('f');
    const c = store.createConversation(u.id, 'Late night');
    // 20:00 UTC on the 28th is 01:30 on the 29th in India.
    run(u.id, c.id, Date.UTC(2026, 8, 28, 20, 0), 0.1, 0);
    const utc = buildSpendReport(store.spend, u.id, '7d', 0, NOW);
    const ist = buildSpendReport(store.spend, u.id, '7d', 330, NOW);
    expect(utc.series.find((s) => s.runs > 0)!.key).toBe('2026-09-28');
    expect(ist.series.find((s) => s.runs > 0)!.key).toBe('2026-09-29');
    const today = buildSpendReport(store.spend, u.id, 'today', 330, NOW);
    expect(today.series.find((s) => s.runs > 0)!.key).toBe('2026-09-29 01');
  });

  it('records a run synced from the user\'s device, but not an imported transcript', () => {
    const u = user('g');
    const c = store.createConversation(u.id, 'Desktop chat');
    store.appendTurn(c.id, u.id, {
      userContent: 'hi',
      assistant: { content: 'hello', costUsd: 0.03, why: JSON.stringify({ savedUsd: 0.1, costByTier: { T3: 0.03 }, models: { T3: 'openai:mini' } }) },
    });
    store.importConversation(u.id, 'Imported', null, [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);

    const r = buildSpendReport(store.spend, u.id, 'all', 0, Date.now());
    expect(r.totals.runs).toBe(1);
    expect(r.totals.spentUsd).toBeCloseTo(0.03, 9);
    expect(r.tiers[0]!.models[0]!.model).toBe('openai:mini');
  });

  it('adds a synced turn sent twice with the same run id once', () => {
    const u = user('retry');
    const c = store.createConversation(u.id, 'Desktop chat');
    const turn = {
      userContent: 'hi', runId: 'run-0001-aaaa',
      assistant: { content: 'hello', costUsd: 0.02, why: JSON.stringify({ totalTokens: 100, costByTier: { T3: 0.02 } }) },
    };
    store.appendTurn(c.id, u.id, turn);
    // The first response was lost; the device sends the same turn again.
    const path = store.appendTurn(c.id, u.id, turn);
    expect(store.getMessages(c.id).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(path!.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals).toMatchObject({ runs: 1, spentUsd: 0.02 });
  });

  it('counts a synced turn from a run the user stopped as stopped', () => {
    const u = user('stopped-turn');
    const c = store.createConversation(u.id, 'Chat');
    store.appendTurn(c.id, u.id, { userContent: 'q', runId: 'run-0004-dddd', outcome: 'stopped', assistant: { content: 'half', costUsd: 0.01, why: JSON.stringify({ totalTokens: 10 }) } });
    // The partial reply is kept, marked as stopped on every reload, and the
    // run is a stop in the report.
    expect(store.getMessages(c.id).map((m) => m.content)).toEqual(['q', 'half']);
    expect(store.getActivePath(c.id).map((m) => m.cancelled)).toEqual([undefined, true]);
    const raw = new Database(dbPath, { readonly: true });
    try {
      expect(raw.prepare('SELECT outcome FROM spend_ledger WHERE user_id = ?').all(u.id)).toEqual([{ outcome: 'stopped' }]);
    } finally { raw.close(); }
    // A reply from a run that was not stopped is not marked.
    store.appendTurn(c.id, u.id, { userContent: 'q2', runId: 'run-0005-eeee', assistant: { content: 'whole', costUsd: 0.01, why: '{}' } });
    expect(store.getActivePath(c.id).at(-1)!.cancelled).toBeUndefined();
  });

  it('counts a synced turn at the time its run ended', () => {
    const u = user('late-turn');
    const c = store.createConversation(u.id, 'Chat');
    const ended = Date.now() - 3 * DAY;
    store.appendTurn(c.id, u.id, { userContent: 'q', runId: 'run-0006-ffff', endedAt: ended, assistant: { content: 'a', costUsd: 0.01, why: '{}' } });
    const raw = new Database(dbPath, { readonly: true });
    try {
      expect(raw.prepare('SELECT at FROM spend_ledger WHERE user_id = ?').all(u.id)).toEqual([{ at: ended }]);
    } finally { raw.close(); }
  });

  it('counts a run once when its turn also lands in a second chat', () => {
    const u = user('rechat');
    const turn = {
      userContent: 'hi', runId: 'run-0002-bbbb',
      assistant: { content: 'hello', costUsd: 0.02, why: JSON.stringify({ totalTokens: 100 }) },
    };
    const first = store.createConversation(u.id, 'First');
    const second = store.createConversation(u.id, 'Second');
    store.appendTurn(first.id, u.id, turn);
    store.appendTurn(second.id, u.id, turn);
    // The second chat gets the transcript; the run is still one run.
    expect(store.getMessages(second.id)).toHaveLength(2);
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals.runs).toBe(1);
  });

  it('counts a run once when its spend alone was sent as well as its turn', () => {
    const u = user('both');
    const c = store.createConversation(u.id, 'Chat');
    const why = JSON.stringify({ totalTokens: 100 });
    // What /api/usage/runs records for the device's run id.
    store.recordSpend(spendEntryFromRun({ id: deviceRunSpendId(u.id, 'run-0003-cccc'), userId: u.id, conversationId: null, at: Date.now(), costUsd: 0.02, why, outcome: 'answered' }));
    store.appendTurn(c.id, u.id, { userContent: 'hi', runId: 'run-0003-cccc', assistant: { content: 'hello', costUsd: 0.02, why } });
    const report = buildSpendReport(store.spend, u.id, 'all', 0, Date.now());
    expect(report.totals).toMatchObject({ runs: 1, spentUsd: 0.02 });
    // The turn copied later gives the run its chat: it is the chat's cost now, not a run with no chat.
    expect(report.chats).toEqual([expect.objectContaining({ conversationId: c.id, noChat: false, runs: 1, spentUsd: 0.02 })]);
  });

  it('never moves a run already in a chat, or another user\'s run, to a chat', () => {
    const u = user('linked');
    const other = user('stranger');
    const first = store.createConversation(u.id, 'First');
    const second = store.createConversation(u.id, 'Second');
    const why = JSON.stringify({ totalTokens: 100 });
    store.appendTurn(first.id, u.id, { userContent: 'hi', runId: 'run-0004-dddd', assistant: { content: 'hello', costUsd: 0.02, why } });
    store.appendTurn(second.id, u.id, { userContent: 'hi', runId: 'run-0004-dddd', assistant: { content: 'hello', costUsd: 0.02, why } });
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).chats.map((r) => r.conversationId)).toEqual([first.id]);
    // The same ledger id under another user's name does not touch this user's row.
    store.recordSpend(spendEntryFromRun({ id: 'shared-id', userId: u.id, conversationId: null, at: Date.now(), costUsd: 0.01, why, outcome: 'failed' }));
    const theirs = store.createConversation(other.id, 'Theirs');
    store.recordSpend(spendEntryFromRun({ id: 'shared-id', userId: other.id, conversationId: theirs.id, at: Date.now(), costUsd: 0.01, why, outcome: 'failed' }));
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).chats.find((r) => r.noChat)).toMatchObject({ runs: 1 });
  });

  it('writes a hosted run down when it answers, and completes it once its late calls settle', async () => {
    const u = user('late');
    // The router as a run leaves it: one call still in flight.
    let tokens = 1000; let settle!: () => void;
    const router = {
      whenRunSettled: () => new Promise<boolean>((r) => { settle = () => { tokens = 1500; r(true); }; }),
      getStats: () => ({ totalCostUsd: tokens / 1e6, totalTokens: tokens, costByTierModel: { T3: { 'openai:mini': tokens / 1e6 } }, tokensByTierModel: { T3: { 'openai:mini': tokens } }, untrackedByTierModel: {} }) as never,
      getDelegationSavings: () => ({ savedUsd: 0 }),
    };
    const done = recordSettledRunSpend(store, router, (st) => spendEntryFromRun({
      id: 'hosted-1', userId: u.id, conversationId: null, at: Date.now(), costUsd: st.totalCostUsd,
      why: { costByModel: st.costByTierModel, tokensByModel: st.tokensByTierModel, unpricedByModel: {}, totalTokens: st.totalTokens },
    }));
    await new Promise((r) => setTimeout(r, 0));
    // Already there, with what it had spent when it answered: a restart now keeps it.
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals).toMatchObject({ runs: 1, tokens: 1000 });
    settle();
    await done;
    // The same row, completed: still one run, its lines replaced, not added to.
    const report = buildSpendReport(store.spend, u.id, 'all', 0, Date.now());
    expect(report.totals).toMatchObject({ runs: 1, tokens: 1500 });
    expect(report.tiers[0]!.models[0]).toMatchObject({ model: 'openai:mini', tokens: 1500 });
  });

  it('counts a follow-up call the run starts after its own calls settled', async () => {
    const u = user('distill');
    // The run's calls have settled; then memory distillation makes one more.
    let tokens = 1000; let finish!: () => void;
    const router = {
      whenRunSettled: async () => true,
      getStats: () => ({ totalCostUsd: tokens / 1e6, totalTokens: tokens, costByTierModel: { T3: { 'openai:mini': tokens / 1e6 } }, tokensByTierModel: { T3: { 'openai:mini': tokens } }, untrackedByTierModel: {} }) as never,
      getDelegationSavings: () => ({ savedUsd: 0 }),
    };
    const distillation = new Promise<void>((r) => { finish = () => { tokens = 1300; r(); }; });
    const done = recordSettledRunSpend(store, router, (st) => spendEntryFromRun({
      id: 'hosted-distill', userId: u.id, conversationId: null, at: Date.now(), costUsd: st.totalCostUsd,
      why: { costByModel: st.costByTierModel, tokensByModel: st.tokensByTierModel, unpricedByModel: {}, totalTokens: st.totalTokens },
    }), distillation);
    await new Promise((r) => setTimeout(r, 0));
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals).toMatchObject({ runs: 1, tokens: 1000 });
    finish();
    await done;
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals).toMatchObject({ runs: 1, tokens: 1300 });
  });

  it('records the run anyway when its follow-up work never finishes', async () => {
    vi.useFakeTimers();
    try {
      const u = user('hung');
      const router = {
        whenRunSettled: async () => true,
        getStats: () => ({ totalCostUsd: 0.001, totalTokens: 1000, costByTierModel: {}, tokensByTierModel: {}, untrackedByTierModel: {} }) as never,
        getDelegationSavings: () => ({ savedUsd: 0 }),
      };
      const done = recordSettledRunSpend(store, router, (st) => spendEntryFromRun({
        id: 'hosted-hung', userId: u.id, conversationId: null, at: Date.now(), costUsd: st.totalCostUsd,
        why: { totalTokens: st.totalTokens },
      }), new Promise(() => { /* never settles */ }));
      await vi.advanceTimersByTimeAsync(FOLLOW_UP_WAIT_MS);
      await done;
      expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals.runs).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts an old CLI\'s sync by what each run added, not the running total it sent', () => {
    // The CLI before /why sent its whole session's cost so far on every reply.
    const u = user('cli');
    const c = store.createConversation(u.id, 'From the terminal');
    for (const total of [0.01, 0.03, 0.06]) {
      store.appendTurn(c.id, u.id, { userContent: 'q', assistant: { content: 'a', costUsd: total } });
    }
    const r = buildSpendReport(store.spend, u.id, 'all', 0, Date.now());
    expect(r.totals.runs).toBe(3);
    expect(r.totals.spentUsd).toBeCloseTo(0.06, 9);
    // The reply keeps what was sent, so the next one can be measured against it.
    expect(store.getMessages(c.id).filter((m) => m.role === 'assistant').map((m) => m.costUsd)).toEqual([0.01, 0.03, 0.06]);
  });

  it('does not count a deleted reply\'s run again when an old CLI syncs the next', () => {
    const u = user('cli-del');
    const c = store.createConversation(u.id, 'Pruned');
    store.appendTurn(c.id, u.id, { userContent: 'q', assistant: { content: 'a', costUsd: 0.01 } });
    store.appendTurn(c.id, u.id, { userContent: 'q', assistant: { content: 'a', costUsd: 0.03 } });
    // The user deletes the newest reply; its run stays in the ledger.
    const newest = store.getMessages(c.id).filter((m) => m.role === 'assistant').at(-1)!;
    store.deleteMessageSubtree(c.id, u.id, newest.id);
    store.appendTurn(c.id, u.id, { userContent: 'q', assistant: { content: 'a', costUsd: 0.06 } });
    // 0.01 + 0.02 + 0.03: the third run is what grew since 0.03, not since 0.01.
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals.spentUsd).toBeCloseTo(0.06, 9);
  });

  it('does not take a reply with its own /why as a running total', () => {
    const u = user('mix');
    const c = store.createConversation(u.id, 'Mixed');
    store.appendTurn(c.id, u.id, { userContent: 'q', assistant: { content: 'a', costUsd: 0.04 } });
    store.appendTurn(c.id, u.id, { userContent: 'q', assistant: { content: 'a', costUsd: 0.06, why: JSON.stringify({ totalTokens: 10 }) } });
    store.appendTurn(c.id, u.id, { userContent: 'q', assistant: { content: 'a', costUsd: 0.05 } });
    // 0.04, then the reporting run's own 0.06, then what the old total grew by.
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals.spentUsd).toBeCloseTo(0.04 + 0.06 + 0.01, 9);
  });

  it('back-fills the ledger once, from the replies stored before it existed', () => {
    const u = user('h');
    const c = store.createConversation(u.id, 'Before the ledger');
    store.addMessage({ conversationId: c.id, role: 'user', content: 'q' });
    store.addMessage({
      conversationId: c.id, role: 'assistant', content: 'a', costUsd: 0.07,
      why: JSON.stringify({ savedUsd: 0.3, costByTier: { T1: 0.02, T3: 0.05 }, models: { T1: 'anthropic:big', T3: 'openai:mini' }, totalTokens: 500 }),
    });
    // Imported replies carry no cost or report, so they were never runs here.
    store.addMessage({ conversationId: c.id, role: 'assistant', content: 'imported' });
    store.close();

    // Roll the database back to before the ledger existed.
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE spend_ledger_models; DROP TABLE spend_ledger;');
    raw.close();

    store = new CloudStore(dbPath);
    const r = buildSpendReport(store.spend, u.id, 'all', 0, Date.now());
    expect(r.totals.runs).toBe(1);
    expect(r.totals.spentUsd).toBeCloseTo(0.07, 9);
    expect(r.totals.savedUsd).toBeCloseTo(0.3, 9);
    expect(r.totals.tokens).toBe(500);
    expect(r.tiers.map((t) => [t.tier, t.models[0]!.model])).toEqual([['T1', 'anthropic:big'], ['T3', 'openai:mini']]);

    // Only once: a later boot does not count the same replies again.
    store.close();
    store = new CloudStore(dbPath);
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals.runs).toBe(1);
  });

  it('measures an old CLI\'s next sync from the total it last sent before the upgrade', () => {
    const u = user('upgraded-cli');
    const c = store.createConversation(u.id, 'From before');
    for (const total of [0.01, 0.03]) store.addMessage({ conversationId: c.id, role: 'assistant', content: 'a', costUsd: total });
    store.close();
    // Roll back to before the ledger and the kept total existed.
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE spend_ledger_models; DROP TABLE spend_ledger; ALTER TABLE conversations DROP COLUMN legacy_cli_total;');
    raw.close();
    store = new CloudStore(dbPath);
    // The newest reply is deleted after the upgrade, then the old CLI syncs again.
    const newest = store.getMessages(c.id).filter((m) => m.role === 'assistant').at(-1)!;
    store.deleteMessageSubtree(c.id, u.id, newest.id);
    store.appendTurn(c.id, u.id, { userContent: 'q', assistant: { content: 'a', costUsd: 0.06 } });
    // 0.01 + 0.02 (back-filled) + 0.03: not 0.05 measured from the older 0.01.
    expect(buildSpendReport(store.spend, u.id, 'all', 0, Date.now()).totals.spentUsd).toBeCloseTo(0.06, 9);
  });

  it('back-fills an old CLI\'s replies by what each run added, chat by chat', () => {
    const u = user('old-cli');
    const first = store.createConversation(u.id, 'Session one');
    const second = store.createConversation(u.id, 'Session two');
    // Running totals, as the old CLI sent them; the second chat's went down
    // part-way because a new session began.
    for (const total of [0.01, 0.03, 0.06]) store.addMessage({ conversationId: first.id, role: 'assistant', content: 'a', costUsd: total });
    for (const total of [0.08, 0.1, 0.01]) store.addMessage({ conversationId: second.id, role: 'assistant', content: 'a', costUsd: total });
    // A hosted reply in the first chat carries its own /why and its own cost.
    store.addMessage({ conversationId: first.id, role: 'assistant', content: 'a', costUsd: 0.5, why: JSON.stringify({ totalTokens: 10 }) });
    store.close();

    const raw = new Database(dbPath);
    raw.exec('DROP TABLE spend_ledger_models; DROP TABLE spend_ledger;');
    raw.close();

    store = new CloudStore(dbPath);
    const r = buildSpendReport(store.spend, u.id, 'all', 0, Date.now());
    expect(r.totals.runs).toBe(7);
    // 0.06 for the first session's three runs, 0.1 + 0.01 for the second
    // chat's two sessions — measured against its own totals, not the first
    // chat's — and the hosted run's 0.5.
    expect(r.totals.spentUsd).toBeCloseTo(0.06 + 0.11 + 0.5, 9);
  });
});
