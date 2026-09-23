import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  beginRun, browserSessionRefusal, checkBrowserSessionLimit, checkDailyLimit, checkPendingMediaCap, claimBrowserSession, EntitlementError, limitsForPlan,
  PENDING_MEDIA_TTL_MS, todayKey, _resetActiveRunsForTests,
} from './entitlements.js';
import { CloudStore } from './db.js';

describe('limitsForPlan', () => {
  it('gives free users a lower daily cap and concurrency than pro', () => {
    const free = limitsForPlan('free');
    const pro = limitsForPlan('pro');
    expect(free.dailyRuns).toBeLessThan(pro.dailyRuns);
    expect(free.maxConcurrentRuns).toBeLessThan(pro.maxConcurrentRuns);
  });

  it('falls back to free limits for an unrecognized plan value', () => {
    expect(limitsForPlan('not-a-real-plan')).toEqual(limitsForPlan('free'));
  });

  it('gives free users far more room for UNSAVED media than for saved files', () => {
    // Deliberate: unsaved media self-deletes within a day, so it is a burst
    // allowance rather than storage. On free — the plan whose 10 MB cap a
    // single generated video would blow through — it must be the larger of the
    // two, or "generating is free" would still be false in practice.
    const free = limitsForPlan('free');
    expect(free.pendingMediaBytes).toBeGreaterThan(free.storageBytes);
    // Every plan has room for several generated assets at once, and pro is
    // never worse off than free.
    for (const plan of ['free', 'pro']) {
      expect(limitsForPlan(plan).pendingMediaBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
      expect(limitsForPlan(plan).pendingMediaBytes).toBeGreaterThanOrEqual(limitsForPlan('free').pendingMediaBytes);
    }
  });
});

describe('checkPendingMediaCap', () => {
  it('lets an ordinary generation through and refuses only past the allowance', () => {
    const cap = limitsForPlan('free').pendingMediaBytes;
    expect(() => checkPendingMediaCap(0, 2 * 1024 * 1024, 'free')).not.toThrow();
    expect(() => checkPendingMediaCap(cap - 10, 10, 'free')).not.toThrow();
    expect(() => checkPendingMediaCap(cap - 10, 11, 'free')).toThrow(EntitlementError);
  });

  it('is not the storage quota: media far bigger than the plan cap still generates', () => {
    // The regression this whole change exists to prevent — a 12 MB clip on a
    // 10 MB free plan is fine to *make*, and only metered if they keep it.
    const twelveMb = 12 * 1024 * 1024;
    expect(twelveMb).toBeGreaterThan(limitsForPlan('free').storageBytes);
    expect(() => checkPendingMediaCap(0, twelveMb, 'free')).not.toThrow();
  });

  it('says how to recover, and that waiting is one of the ways', () => {
    const cap = limitsForPlan('free').pendingMediaBytes;
    expect(() => checkPendingMediaCap(cap, 1, 'free')).toThrow(/save what you want to keep/i);
    expect(() => checkPendingMediaCap(cap, 1, 'free')).toThrow(/24 hours/);
  });

  it('keeps the expiry window in the range the copy promises', () => {
    expect(PENDING_MEDIA_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('checkDailyLimit', () => {
  let dir: string;
  let store: CloudStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-entitlements-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not throw when usage is below the plan limit', () => {
    const user = store.upsertUser({ provider: 'dev', providerId: '1', email: null, name: null, avatar: null });
    store.incrementUsage(user.id, todayKey());
    expect(() => checkDailyLimit(store, user.id, 'free')).not.toThrow();
  });

  it('throws EntitlementError once usage reaches the plan limit', () => {
    const user = store.upsertUser({ provider: 'dev', providerId: '1', email: null, name: null, avatar: null });
    const limit = limitsForPlan('free').dailyRuns;
    for (let i = 0; i < limit; i++) store.incrementUsage(user.id, todayKey());
    expect(() => checkDailyLimit(store, user.id, 'free')).toThrow(EntitlementError);
  });

  it('a pro user is not blocked at the free plan\'s limit', () => {
    const user = store.upsertUser({ provider: 'dev', providerId: '1', email: null, name: null, avatar: null });
    const freeLimit = limitsForPlan('free').dailyRuns;
    for (let i = 0; i < freeLimit; i++) store.incrementUsage(user.id, todayKey());
    expect(() => checkDailyLimit(store, user.id, 'pro')).not.toThrow();
  });
});

describe('beginRun (in-memory concurrency gate)', () => {
  beforeEach(() => {
    _resetActiveRunsForTests();
  });

  it('allows a run up to the plan\'s concurrency limit', () => {
    expect(() => beginRun('user-1', 'free')).not.toThrow();
  });

  it('blocks a second concurrent run on the free plan (limit 1)', () => {
    beginRun('user-1', 'free');
    expect(() => beginRun('user-1', 'free')).toThrow(EntitlementError);
  });

  it('releasing a run frees the slot for the next one', () => {
    const release = beginRun('user-1', 'free');
    release();
    expect(() => beginRun('user-1', 'free')).not.toThrow();
  });

  it('is scoped per-user — one user\'s run does not block another\'s', () => {
    beginRun('alice', 'free');
    expect(() => beginRun('bob', 'free')).not.toThrow();
  });

  it('a double release is a no-op, not an over-release', () => {
    const release = beginRun('user-1', 'free');
    release();
    release(); // must not free a slot that was never held
    expect(() => beginRun('user-1', 'free')).not.toThrow();
    // Only one slot was ever actually consumed at a time — a second
    // concurrent attempt now (after the fresh beginRun above) should block.
    expect(() => beginRun('user-1', 'free')).toThrow(EntitlementError);
  });

  it('respects a higher concurrency limit on the pro plan', () => {
    beginRun('user-1', 'pro');
    expect(() => beginRun('user-1', 'pro')).not.toThrow();
  });
});

describe('the daily browser allowance', () => {
  // Sessions, because a session is what the provider bills for: Free 5, Pro 50.
  let dir: string;
  let store: CloudStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-browser-allowance-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const user = () => store.upsertUser({ provider: 'dev', providerId: 'browser-user', email: null, name: null, avatar: null });

  it('is 5 sessions a day on Free and 50 on Pro', () => {
    expect(limitsForPlan('free').dailyBrowserSessions).toBe(5);
    expect(limitsForPlan('pro').dailyBrowserSessions).toBe(50);
  });

  it('lets sessions open until the plan’s allowance is spent', () => {
    const { id } = user();
    for (let i = 0; i < 4; i++) store.incrementBrowserSessions(id, todayKey());
    expect(browserSessionRefusal(store, id, 'free'), 'four of five used').toBeUndefined();

    store.incrementBrowserSessions(id, todayKey());
    expect(browserSessionRefusal(store, id, 'free'), 'the fifth was the last').toBeTruthy();
  });

  it('says how many, on which plan, when it resets, and where more is', () => {
    const { id } = user();
    for (let i = 0; i < 5; i++) store.incrementBrowserSessions(id, todayKey());
    expect(browserSessionRefusal(store, id, 'free')).toBe(
      'Today’s browser sessions are used up (5 a day on the free plan). They reset at midnight UTC. Pro includes 50 a day.'.replace('’', "'"),
    );
  });

  it('does not offer Pro to someone already on it', () => {
    const { id } = user();
    for (let i = 0; i < 50; i++) store.incrementBrowserSessions(id, todayKey());
    const refusal = browserSessionRefusal(store, id, 'pro');
    expect(refusal).toContain('50 a day on the Pro plan');
    expect(refusal).not.toContain('Pro includes');
  });

  it('counts browser sessions apart from runs', () => {
    // One row per user per day carries both. A run is not a session: a
    // browser run that never opens the browser costs no allowance.
    const { id } = user();
    for (let i = 0; i < 20; i++) store.incrementUsage(id, todayKey());
    expect(store.getBrowserSessions(id, todayKey())).toBe(0);

    store.incrementBrowserSessions(id, todayKey());
    expect(store.getUsage(id, todayKey()), 'and a session is not a run').toBe(20);
    expect(store.getBrowserSessions(id, todayKey())).toBe(1);
  });

  it('is a fresh allowance each day', () => {
    const { id } = user();
    for (let i = 0; i < 5; i++) store.incrementBrowserSessions(id, '2000-01-01');
    expect(browserSessionRefusal(store, id, 'free'), 'yesterday’s sessions are not today’s').toBeUndefined();
  });

  it('claims sessions one at a time up to the allowance, then refuses in the same words', () => {
    const { id } = user();
    for (let i = 0; i < 5; i++) expect('giveBack' in claimBrowserSession(store, id, 'free'), `claim ${i + 1}`).toBe(true);
    const sixth = claimBrowserSession(store, id, 'free');
    expect('refusal' in sixth && sixth.refusal).toBe(browserSessionRefusal(store, id, 'free'));
    expect(store.getBrowserSessions(id, todayKey()), 'a refused claim takes nothing').toBe(5);
  });

  it('gives a claim back when no session came of it', () => {
    const { id } = user();
    const claim = claimBrowserSession(store, id, 'free');
    if (!('giveBack' in claim)) throw new Error('expected a claim');
    claim.giveBack();
    expect(store.getBrowserSessions(id, todayKey())).toBe(0);
  });

  it('gives it back to the day it was taken from, even after midnight', () => {
    // Otherwise a session claimed at 23:59 and abandoned at 00:01 would be
    // refunded from the NEW day, handing out one more than the allowance.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-23T23:59:30Z'));
      const { id } = user();
      const claim = claimBrowserSession(store, id, 'free');
      if (!('giveBack' in claim)) throw new Error('expected a claim');
      vi.setSystemTime(new Date('2026-09-24T00:00:30Z'));
      store.incrementBrowserSessions(id, '2026-09-24');
      claim.giveBack();
      expect(store.getBrowserSessions(id, '2026-09-23')).toBe(0);
      expect(store.getBrowserSessions(id, '2026-09-24'), 'today untouched').toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a browser run up front as an entitlement, like the daily run limit', () => {
    const { id } = user();
    for (let i = 0; i < 5; i++) store.incrementBrowserSessions(id, todayKey());
    expect(() => checkBrowserSessionLimit(store, id, 'free')).toThrow(EntitlementError);
  });
});
