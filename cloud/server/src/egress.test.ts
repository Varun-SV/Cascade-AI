import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CloudStore } from './db.js';
import {
  buildEgressGate,
  forgetGovernor,
  registerRunGate,
  unregisterRunGate,
  resolveRunEgress,
  suspendedMessage,
} from './egress.js';
import { checkNotSuspended, EntitlementError } from './entitlements.js';

describe('cloud egress gate', () => {
  let dir: string;
  let store: CloudStore;
  let userId: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-egress-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    userId = store.upsertUser({ provider: 'github', providerId: 'e1', email: null, name: null, avatar: null }).id;
    forgetGovernor(userId);
  });

  afterEach(async () => {
    forgetGovernor(userId);
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('allows ordinary requests and records nothing', () => {
    const gate = buildEgressGate({ store, userId, plan: 'free' });
    expect(gate('https://docs.example/a').allow).toBe(true);
    expect(gate('https://docs.example/b').allow).toBe(true);
    expect(store.getAbuseRecord(userId)).toBeNull();
    expect(store.isUserSuspended(userId)).toBe(false);
  });

  it('records a strike on a blocked request', () => {
    // A tiny per-host cap so the third request to one host is blocked.
    const gate = buildEgressGate({ store, userId, plan: 'free', policy: { windowMs: 1_000, threshold: 100 } });
    // Drive the governor to its default per-host cap by reusing one host a lot.
    // Simpler: use the denylist path via a scheme refusal, which always blocks.
    const v = gate('file:///etc/passwd');
    expect(v.allow).toBe(false);
    const rec = store.getAbuseRecord(userId);
    expect(rec).not.toBeNull();
    expect(JSON.parse(rec!).strikes.length).toBe(1);
  });

  it('suspends after enough strikes and then refuses everything', () => {
    const strikes: string[] = [];
    const suspended: string[] = [];
    const gate = buildEgressGate({
      store, userId, plan: 'free',
      policy: { windowMs: 60_000, threshold: 3 },
      onStrike: (c) => strikes.push(c),
      onSuspended: (c) => suspended.push(c),
    });
    gate('file:///1');
    gate('file:///2');
    const third = gate('file:///3'); // trips suspension
    expect(suspended.length).toBe(1);
    expect(third.allow).toBe(false);
    expect(third.allow === false && third.reason).toBe(suspendedMessage());
    expect(store.isUserSuspended(userId)).toBe(true);
    expect(strikes.length).toBe(3);

    // Even a perfectly fine URL is now refused, and no second suspension fires.
    const after = gate('https://ok.example/');
    expect(after.allow).toBe(false);
    expect(suspended.length).toBe(1);
  });

  it('admission refuses a suspended user', () => {
    const gate = buildEgressGate({ store, userId, plan: 'free', policy: { windowMs: 60_000, threshold: 1 } });
    gate('file:///x'); // one strike, threshold 1 → suspended
    expect(store.isUserSuspended(userId)).toBe(true);
    expect(() => checkNotSuspended(store, userId)).toThrow(EntitlementError);
  });

  it('isolates one user from another', () => {
    const other = store.upsertUser({ provider: 'github', providerId: 'e2', email: null, name: null, avatar: null }).id;
    forgetGovernor(other);
    const g1 = buildEgressGate({ store, userId, plan: 'free', policy: { windowMs: 60_000, threshold: 1 } });
    g1('file:///x'); // suspends userId only
    expect(store.isUserSuspended(userId)).toBe(true);
    expect(store.isUserSuspended(other)).toBe(false);
    forgetGovernor(other);
  });
});

describe('per-run egress resolver', () => {
  it('uses a registered run gate and falls open for an unknown run', () => {
    registerRunGate('run-1', () => ({ allow: false, code: 'host-rate', reason: 'nope' }));
    expect(resolveRunEgress('https://a/', 'run-1').allow).toBe(false);
    // Unknown run: allowed (the tool path still meters that user).
    expect(resolveRunEgress('https://a/', 'run-unknown').allow).toBe(true);
    unregisterRunGate('run-1');
    expect(resolveRunEgress('https://a/', 'run-1').allow).toBe(true);
  });
});
