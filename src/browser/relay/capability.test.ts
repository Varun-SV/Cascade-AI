import { fork } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_LIFETIME_MS, StoreOutcomeUnknown, StoreUnavailable, canonicalJson, claimAtServer, createDeviceApprovals, createIdentity,
  createMemoryNonceStore, grantHash, issueGrant, verifyGrant,
  type ApprovalPayload, type GrantPayload, type IssuedRun, type NonceStore, type Signed,
} from './capability.js';
import { POLICY_VERSION } from './command-policy.js';
import { acquireLease, createTabLease } from './tab-lease.js';

const T0 = 1_800_000_000_000;
// These leases have times around T0. On the system clock that's past Node's timer limit, which
// fires at once and ended a lease early. Expiry itself is tested in tab-lease.test.ts.
const TEST_CLOCK = { now: () => T0, setTimer: () => () => {} };
const scope = { tabTargetId: 'tab-1', allowedOrigins: ['https://ok.test'], privateOrigins: [] };

function world(now = { t: T0 }) {
  const server = createIdentity('server');
  const deviceA = createIdentity('device-a');
  const deviceB = createIdentity('device-b');
  const issued = new Map<string, IssuedRun>();
  const store = createMemoryNonceStore(() => now.t);
  const keys = new Map([[deviceA.id, deviceA.publicKey], [deviceB.id, deviceB.publicKey]]);
  const grantFor = (userId: string, deviceId: string, runId = 'run-1') => {
    const g = issueGrant(server, { userId, deviceId, runId, ttlMs: 600_000, now: now.t });
    issued.set(g.payload.nonce, { userId, deviceId, runId });
    return g;
  };
  const approvals = (device = deviceA) => createDeviceApprovals({ device, serverId: server.id, serverKey: server.publicKey, now: () => now.t });
  const claim = (grant: Signed<GrantPayload>, approval: Signed<ApprovalPayload>, s: NonceStore = store) => claimAtServer({
    server, store: s, grant, approval, now: now.t,
    deviceKey: (id) => keys.get(id) ?? null, issued: (n) => issued.get(n) ?? null,
  });
  return { now, server, deviceA, deviceB, grantFor, approvals, claim, store };
}
const approved = (a: ReturnType<ReturnType<typeof createDeviceApprovals>['approve']>): Signed<ApprovalPayload> => {
  if ('refused' in a) throw new Error(a.refused);
  return a;
};

describe('canonicalJson', () => {
  it('sorts keys at every depth, whatever order they were written', () => {
    expect(canonicalJson({ b: 1, a: { d: ['x'], c: 2 } })).toBe('{"a":{"c":2,"d":["x"]},"b":1}');
  });
  it('refuses what it cannot sign exactly', () => {
    for (const v of [1.5, NaN, null, undefined, true]) expect(() => canonicalJson(v), String(v)).toThrow();
  });
});

describe('the two-party flow', () => {
  it('a run the server issued and the device approved is claimed once', async () => {
    const w = world();
    const grant = w.grantFor('user-a', 'device-a');
    const a = approved(w.approvals().approve(grant, scope, 60_000));
    expect(await w.claim(grant, a)).toEqual({ outcome: 'claimed' });
    expect(await w.claim(grant, a)).toEqual({ outcome: 'replay' });
  });
  it('a second approval of a claimed grant is still a replay', async () => {
    const w = world();
    const grant = w.grantFor('user-a', 'device-a');
    const d = w.approvals();
    expect(await w.claim(grant, approved(d.approve(grant, scope, 60_000)))).toEqual({ outcome: 'claimed' });
    expect(await w.claim(grant, approved(d.approve(grant, scope, 60_000)))).toEqual({ outcome: 'replay' });
  });
});

describe('O1: a capability stays on its own user and device', () => {
  it('a grant for user A cannot be approved by user B\'s device', () => {
    const w = world();
    expect(w.approvals(w.deviceB).approve(w.grantFor('user-a', 'device-a'), scope, 60_000)).toEqual({ refused: 'grant for another device' });
  });
  it('an approval signed by another user\'s device is refused', async () => {
    const w = world();
    const grant = w.grantFor('user-a', 'device-a');
    const forged = approved(w.approvals().approve(grant, scope, 60_000));
    const signedByB = { payload: { ...forged.payload }, sig: w.deviceB.sign(Buffer.from('x')) };
    expect(await w.claim(grant, signedByB)).toMatchObject({ outcome: 'refused', reason: 'bad approval signature' });
  });
  it('device B\'s approval of its own grant cannot be used for device A\'s grant', async () => {
    const w = world();
    const grantA = w.grantFor('user-a', 'device-a');
    const grantB = w.grantFor('user-b', 'device-b');
    const fromB = approved(w.approvals(w.deviceB).approve(grantB, scope, 60_000));
    expect((await w.claim(grantA, fromB)).outcome).toBe('refused');
  });
  it('a grant the server never issued is refused, even when correctly signed', async () => {
    const w = world();
    const stray = issueGrant(w.server, { userId: 'u', deviceId: 'device-a', runId: 'r', ttlMs: 60_000, now: T0 });
    const a = approved(w.approvals().approve(stray, scope, 60_000));
    expect(await w.claim(stray, a)).toMatchObject({ outcome: 'refused', reason: 'grant was not issued here' });
  });
  it('an unregistered device is refused', async () => {
    const w = world();
    const stranger = createIdentity('device-x');
    const grant = w.grantFor('user-x', 'device-x');
    const a = approved(w.approvals(stranger).approve(grant, scope, 60_000));
    expect(await w.claim(grant, a)).toMatchObject({ outcome: 'refused', reason: 'device is not registered' });
  });
});

describe('forgery', () => {
  it('a grant signed by anyone but the server is refused by the device', () => {
    const w = world();
    const attacker = createIdentity('server');
    const forged = issueGrant(attacker, { userId: 'u', deviceId: 'device-a', runId: 'r', ttlMs: 60_000, now: T0 });
    expect(w.approvals().approve(forged, scope, 60_000)).toEqual({ refused: 'bad grant signature' });
  });
  it('a changed field breaks the signature', () => {
    const w = world();
    const g = w.grantFor('user-a', 'device-a');
    const changed = { ...g, payload: { ...g.payload, runId: 'other' } };
    expect(verifyGrant(changed, w.server.publicKey, { serverId: 'server', deviceId: 'device-a' }, T0)).toEqual({ ok: false, reason: 'bad grant signature' });
  });
  it('widening an approved scope breaks its signature', async () => {
    const w = world();
    const grant = w.grantFor('user-a', 'device-a');
    const a = approved(w.approvals().approve(grant, scope, 60_000));
    const wider = { ...a, payload: { ...a.payload, allowedOrigins: ['https://evil.test'] } };
    expect(await w.claim(grant, wider)).toMatchObject({ outcome: 'refused', reason: 'bad approval signature' });
  });
  it('one object cannot pass as the other, because the domain string differs', async () => {
    const w = world();
    const grant = w.grantFor('user-a', 'device-a');
    const a = approved(w.approvals().approve(grant, scope, 60_000));
    const asGrant = { payload: a.payload as unknown as GrantPayload, sig: a.sig };
    expect(verifyGrant(asGrant, w.deviceA.publicKey, { serverId: 'server', deviceId: 'device-a' }, T0).ok).toBe(false);
    const sameFields = { payload: grant.payload, sig: w.deviceA.sign(Buffer.from(`cascade.relay.approval.v1\n${canonicalJson(grant.payload)}`)) };
    expect(verifyGrant(sameFields, w.deviceA.publicKey, { serverId: 'server', deviceId: 'device-a' }, T0)).toEqual({ ok: false, reason: 'bad grant signature' });
  });
  it('an unknown field or a missing one is refused', async () => {
    const w = world();
    const g = w.grantFor('user-a', 'device-a');
    const extra = { ...g, payload: { ...g.payload, scope: 'all' } as GrantPayload };
    expect(verifyGrant(extra, w.server.publicKey, { serverId: 'server', deviceId: 'device-a' }, T0)).toEqual({ ok: false, reason: 'malformed grant' });
  });
  it('a mismatched policy version is refused, not negotiated', () => {
    const w = world();
    const g = issueGrant(w.server, { userId: 'u', deviceId: 'device-a', runId: 'r', ttlMs: 60_000, now: T0 });
    expect(g.payload.policyVersion).toBe(POLICY_VERSION);
    const old = createDeviceApprovals({ device: w.deviceA, serverId: 'server', serverKey: w.server.publicKey, now: () => T0 });
    const stale = { ...g, payload: { ...g.payload, policyVersion: POLICY_VERSION + 1 } };
    expect('refused' in old.approve(stale, scope, 1000)).toBe(true);
  });
});

describe('O3: expiry and single use on the device', () => {
  it('an expired grant and an expired approval are refused', async () => {
    const now = { t: T0 };
    const w = world(now);
    const grant = w.grantFor('user-a', 'device-a');
    const d = w.approvals();
    const a = approved(d.approve(grant, scope, 60_000));
    now.t = T0 + 60_001;
    expect(d.admit(a)).toEqual({ ok: false, reason: 'approval expired' });
    expect(await w.claim(grant, a)).toMatchObject({ outcome: 'refused', reason: 'expired' });
    now.t = T0 + 600_001;
    expect(d.approve(grant, scope, 1000)).toEqual({ refused: 'expired' });
  });
  it('no grant may live longer than the limit', () => {
    const w = world();
    const g = issueGrant(w.server, { userId: 'u', deviceId: 'device-a', runId: 'r', ttlMs: MAX_LIFETIME_MS * 5, now: T0 });
    expect(g.payload.exp - g.payload.iat).toBe(MAX_LIFETIME_MS);
  });
  it('the device refuses a burned approval even if a compromised server says it is fine', () => {
    const w = world();
    const d = w.approvals();
    const a = approved(d.approve(w.grantFor('user-a', 'device-a'), scope, 60_000));
    expect(d.admit(a).ok).toBe(true);
    d.burn(a.payload.nonce);
    expect(d.admit(a)).toEqual({ ok: false, reason: 'approval already used' });
  });
  it('the device enforces its own record, not the payload the server hands back', () => {
    const w = world();
    const d = w.approvals();
    const a = approved(d.approve(w.grantFor('user-a', 'device-a'), scope, 60_000));
    const wider = { ...a, payload: { ...a.payload, allowedOrigins: ['https://evil.test'] } };
    const r = d.admit(wider);
    expect(r.ok && r.scope.allowedOrigins).toEqual(['https://ok.test']);
  });
  it('changing the caller\'s scope or an admission result changes nothing the device enforces', () => {
    const w = world();
    const d = w.approvals();
    const mine = { tabTargetId: 'tab-1', allowedOrigins: ['https://ok.test'], privateOrigins: ['http://192.168.1.1'] };
    const a = approved(d.approve(w.grantFor('user-a', 'device-a'), mine, 60_000));
    mine.allowedOrigins.push('https://evil.test');
    mine.privateOrigins.push('http://10.0.0.1');
    const first = d.admit(a);
    expect(first.ok && first.scope.allowedOrigins).toEqual(['https://ok.test']);
    if (first.ok) {
      try { first.scope.allowedOrigins.push('https://evil.test'); } catch { /* frozen */ }
      try { first.scope.privateOrigins.push('http://10.0.0.1'); } catch { /* frozen */ }
    }
    const second = d.admit(a);
    expect(second.ok && second.scope).toEqual({ tabTargetId: 'tab-1', allowedOrigins: ['https://ok.test'], privateOrigins: ['http://192.168.1.1'] });
  });
  it('an approval this device never gave is refused', () => {
    const w = world();
    const other = w.approvals(w.deviceB);
    const a = approved(other.approve(w.grantFor('user-b', 'device-b'), scope, 60_000));
    expect(w.approvals().admit(a)).toEqual({ ok: false, reason: 'not an approval this device gave' });
  });
  it('binds an approval to its grant', () => {
    const w = world();
    const grant = w.grantFor('user-a', 'device-a');
    expect(approved(w.approvals().approve(grant, scope, 60_000)).payload.grantHash).toBe(grantHash(grant));
  });
});

describe('when the store fails', () => {
  it('a definite failure is retryable, and an unknown one is not treated as success', async () => {
    const w = world();
    const grant = w.grantFor('user-a', 'device-a');
    const a = approved(w.approvals().approve(grant, scope, 60_000));
    const down: NonceStore = { claimOnce: async () => { throw new StoreUnavailable(); } };
    const lost: NonceStore = { claimOnce: async () => { throw new StoreOutcomeUnknown(); } };
    expect(await w.claim(grant, a, down)).toEqual({ outcome: 'unavailable' });
    expect(await w.claim(grant, a, lost)).toEqual({ outcome: 'unknown' });
    expect(await w.claim(grant, a)).toEqual({ outcome: 'claimed' });
  });
});

describe('the whole path: grant, approval, claim, lease', () => {
  const flow = (w: ReturnType<typeof world>, d: ReturnType<ReturnType<typeof world>['approvals']>, lease: ReturnType<typeof createTabLease>, grant: Signed<GrantPayload>, a: Signed<ApprovalPayload>, store?: NonceStore) => acquireLease({
    lease,
    admit: () => d.admit(a),
    claim: () => w.claim(grant, a, store),
    burn: () => d.burn(a.payload.nonce),
  });

  it('after a disconnect, only a fresh grant and approval get the tab back', async () => {
    const w = world();
    const d = w.approvals();
    const lease = createTabLease(TEST_CLOCK);
    const grant = w.grantFor('user-a', 'device-a');
    const a = approved(d.approve(grant, scope, 60_000));
    const first = await flow(w, d, lease, grant, a);
    expect(first.outcome).toBe('leased');
    lease.revoke('the connection dropped');
    // The same approval, and a new approval of the same grant, both fail.
    expect(await flow(w, d, lease, grant, a)).toMatchObject({ outcome: 'refused', reusable: false });
    const again = approved(d.approve(grant, scope, 60_000));
    expect(await flow(w, d, lease, grant, again)).toMatchObject({ outcome: 'refused', reusable: false });
    expect(lease.state()).toBe('idle');
    const grant2 = w.grantFor('user-a', 'device-a', 'run-2');
    const fresh = await flow(w, d, lease, grant2, approved(d.approve(grant2, scope, 60_000)));
    expect(fresh.outcome).toBe('leased');
    if (first.outcome === 'leased' && fresh.outcome === 'leased') {
      expect(fresh.fence.generation).toBeGreaterThan(first.fence.generation);
      expect(lease.isCurrent(first.fence)).toBe(false);
    }
  });
  it('an approval refused only because the tab is leased stays usable', async () => {
    const w = world();
    const d = w.approvals();
    const lease = createTabLease(TEST_CLOCK);
    const g1 = w.grantFor('user-a', 'device-a', 'run-1');
    const g2 = w.grantFor('user-a', 'device-a', 'run-2');
    const a1 = approved(d.approve(g1, scope, 60_000));
    const a2 = approved(d.approve(g2, scope, 60_000));
    expect((await flow(w, d, lease, g1, a1)).outcome).toBe('leased');
    expect(await flow(w, d, lease, g2, a2)).toEqual({ outcome: 'tab-leased' });
    lease.revoke('run ended');
    expect((await flow(w, d, lease, g2, a2)).outcome).toBe('leased');
  });
  it('with the store down: refused and retryable, then fine when it recovers', async () => {
    const w = world();
    const d = w.approvals();
    const lease = createTabLease(TEST_CLOCK);
    const grant = w.grantFor('user-a', 'device-a');
    const a = approved(d.approve(grant, scope, 60_000));
    const down: NonceStore = { claimOnce: async () => { throw new StoreUnavailable(); } };
    expect(await flow(w, d, lease, grant, a, down)).toMatchObject({ outcome: 'refused', reusable: true });
    expect((await flow(w, d, lease, grant, a)).outcome).toBe('leased');
  });
  it('an unknown store result burns the approval: the user is asked again', async () => {
    const w = world();
    const d = w.approvals();
    const lease = createTabLease(TEST_CLOCK);
    const grant = w.grantFor('user-a', 'device-a');
    const a = approved(d.approve(grant, scope, 60_000));
    const lost: NonceStore = { claimOnce: async () => { throw new StoreOutcomeUnknown(); } };
    expect(await flow(w, d, lease, grant, a, lost)).toMatchObject({ outcome: 'refused', reusable: false });
    expect(d.admit(a)).toEqual({ ok: false, reason: 'approval already used' });
  });
});

/**
 * The contract any production store must pass. The in-memory store is one process
 * by nature; this runs against a file-backed test store with N real processes, so
 * the contract exists before stage 2 needs a real one.
 */
describe('NonceStore contract', () => {
  it('in one process: exactly one of many concurrent claims wins', async () => {
    const store = createMemoryNonceStore(() => T0);
    const wins = (await Promise.all(Array.from({ length: 50 }, () => store.claimOnce('k', T0 + 1)))).filter(Boolean);
    expect(wins).toHaveLength(1);
    expect(await store.claimOnce('other', T0 + 1)).toBe(true);
  });
  it('across processes: exactly one of N processes wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nonce-store-'));
    try {
      const script = join(dir, 'contender.cjs');
      writeFileSync(script, `
        const fs = require('node:fs');
        process.on('message', ({ path }) => {
          let won = false;
          try { fs.closeSync(fs.openSync(path, 'wx')); won = true; } catch {}
          process.send({ won });
          process.disconnect();
        });
        process.send({ ready: true });
      `);
      const path = join(dir, 'nonce-key');
      const children = Array.from({ length: 8 }, () => fork(script));
      await Promise.all(children.map((c) => new Promise<void>((r) => c.once('message', () => r()))));
      const results = children.map((c) => new Promise<boolean>((r) => c.once('message', (m: { won: boolean }) => r(m.won))));
      children.forEach((c) => c.send({ path }));
      expect((await Promise.all(results)).filter(Boolean)).toHaveLength(1);
      closeSync(openSync(join(dir, 'done'), 'wx'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
});
