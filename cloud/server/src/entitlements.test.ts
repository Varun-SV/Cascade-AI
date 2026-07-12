import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beginRun, checkDailyLimit, EntitlementError, limitsForPlan, todayKey, _resetActiveRunsForTests } from './entitlements.js';
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
