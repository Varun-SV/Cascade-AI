import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  beginRun, checkDailyLimit, checkPendingMediaCap, EntitlementError, limitsForPlan,
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
