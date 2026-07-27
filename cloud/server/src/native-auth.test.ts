import { describe, it, expect } from 'vitest';
import {
  pkceChallenge, verifyPkce, generateUserCode, normalizeUserCode, isLoopbackRedirect,
  NativeAuthStore, DEVICE_POLL_INTERVAL_S, hashRefreshToken, LOOPBACK_CODE_TTL_MS,
} from './native-auth.js';

describe('PKCE', () => {
  it('verifies a matching verifier and rejects a wrong one', () => {
    const verifier = 'a'.repeat(64);
    const challenge = pkceChallenge(verifier);
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce('b'.repeat(64), challenge)).toBe(false);
    expect(verifyPkce('', challenge)).toBe(false);
    expect(verifyPkce(verifier, '')).toBe(false);
  });
});

describe('user codes', () => {
  it('formats as XXXX-XXXX from the unambiguous alphabet', () => {
    const c = generateUserCode();
    expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    expect(c).not.toMatch(/[ILO01]/);
  });
  it('normalizes separators/case for lookup', () => {
    expect(normalizeUserCode('wxyz-1234')).toBe('WXYZ1234');
  });
});

describe('isLoopbackRedirect', () => {
  it('accepts loopback http hosts only', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:52123/cb')).toBe(true);
    expect(isLoopbackRedirect('http://localhost:8080/cb')).toBe(true);
    expect(isLoopbackRedirect('https://evil.com/cb')).toBe(false);
    expect(isLoopbackRedirect('http://169.254.169.254/cb')).toBe(false);
    expect(isLoopbackRedirect('not a url')).toBe(false);
  });
});

describe('NativeAuthStore — loopback', () => {
  it('round-trips pending state and a one-time code with PKCE', () => {
    const store = new NativeAuthStore();
    const verifier = 'verifier-123';
    const challenge = pkceChallenge(verifier);
    store.createPendingLoopback('state1', { challenge, redirect: 'http://127.0.0.1:5/cb', appState: 'app' });
    const pend = store.consumePendingLoopback('state1');
    expect(pend?.challenge).toBe(challenge);
    // consumed → gone
    expect(store.consumePendingLoopback('state1')).toBeNull();

    const code = store.createLoopbackCode({ userId: 'u1', challenge, redirect: 'http://127.0.0.1:5/cb' });
    expect(store.consumeLoopbackCode(code, 'wrong-verifier')).toBeNull(); // bad PKCE
    // consumed (single-use) even on failure → a retry with the right verifier also fails
    const code2 = store.createLoopbackCode({ userId: 'u1', challenge, redirect: 'http://127.0.0.1:5/cb' });
    expect(store.consumeLoopbackCode(code2, verifier)).toEqual({ userId: 'u1' });
    expect(store.consumeLoopbackCode(code2, verifier)).toBeNull(); // already used
  });

  it('expires pending state and codes', () => {
    let t = 1000;
    const store = new NativeAuthStore(() => t);
    store.createPendingLoopback('s', { challenge: 'c', redirect: 'r', appState: 'a' });
    t += 11 * 60 * 1000;
    expect(store.consumePendingLoopback('s')).toBeNull();
  });
});

describe('NativeAuthStore — device flow', () => {
  it('drives pending → approved → consumed with interval enforcement', () => {
    let t = 100_000; // realistic non-zero clock (Date.now() is never 0)
    const store = new NativeAuthStore(() => t);
    const { deviceCode, userCode } = store.createDevice();

    // First poll: pending.
    expect(store.pollDevice(deviceCode)).toEqual({ status: 'pending' });
    // Poll again immediately: too fast.
    expect(store.pollDevice(deviceCode).status).toBe('slow_down');

    // User approves on the web.
    expect(store.approveDevice(userCode, 'user-9')).toBe(true);

    // Poll after the interval → approved with the user.
    t += (DEVICE_POLL_INTERVAL_S + 1) * 1000;
    expect(store.pollDevice(deviceCode)).toEqual({ status: 'approved', userId: 'user-9' });
    // Second time: consumed → expired.
    t += (DEVICE_POLL_INTERVAL_S + 1) * 1000;
    expect(store.pollDevice(deviceCode).status).toBe('expired');
  });

  it('rejects approval of an unknown or expired code', () => {
    let t = 0;
    const store = new NativeAuthStore(() => t);
    expect(store.approveDevice('NOPE-NOPE', 'u')).toBe(false);
    const { userCode } = store.createDevice();
    t += 11 * 60 * 1000;
    expect(store.approveDevice(userCode, 'u')).toBe(false); // expired
  });
});

describe('hashRefreshToken', () => {
  it('is stable and content-sensitive', () => {
    expect(hashRefreshToken('tok')).toBe(hashRefreshToken('tok'));
    expect(hashRefreshToken('tok')).not.toBe(hashRefreshToken('tok2'));
  });
});

describe('NativeAuthStore — loopback artifacts survive a restart', () => {
  /** Stand-in for the DB: same contract, take() is read-and-delete. */
  function fakePersistence() {
    const rows = new Map<string, { data: string; expiresAt: number }>();
    return {
      rows,
      saveAuthFlow(kind: string, key: string, data: string, expiresAt: number) { rows.set(`${kind}:${key}`, { data, expiresAt }); },
      takeAuthFlow(kind: string, key: string) {
        const k = `${kind}:${key}`;
        const row = rows.get(k);
        rows.delete(k);
        if (!row || row.expiresAt <= Date.now()) return null;
        return row.data;
      },
      sweepAuthFlows(now: number) { for (const [k, v] of rows) if (v.expiresAt <= now) rows.delete(k); },
    };
  }

  it('redeems a code issued before the process restarted', () => {
    const p = fakePersistence();
    const verifier = 'a'.repeat(43);
    // First process: issue the code, then die.
    const before = new NativeAuthStore(() => Date.now(), p);
    const code = before.createLoopbackCode({ userId: 'u1', challenge: pkceChallenge(verifier), redirect: 'http://127.0.0.1:1234/cb' });

    // Fresh process — empty memory, same durable rows.
    const after = new NativeAuthStore(() => Date.now(), p);
    expect(after.consumeLoopbackCode(code, verifier)).toEqual({ userId: 'u1' });
  });

  it('keeps a restored code single-use', () => {
    const p = fakePersistence();
    const verifier = 'b'.repeat(43);
    const before = new NativeAuthStore(() => Date.now(), p);
    const code = before.createLoopbackCode({ userId: 'u1', challenge: pkceChallenge(verifier), redirect: 'http://127.0.0.1:1/cb' });

    const after = new NativeAuthStore(() => Date.now(), p);
    expect(after.consumeLoopbackCode(code, verifier)).toEqual({ userId: 'u1' });
    // Second attempt finds nothing in memory OR storage.
    expect(after.consumeLoopbackCode(code, verifier)).toBeNull();
    expect(p.rows.size).toBe(0);
  });

  it('still rejects a wrong PKCE verifier after a restart, and burns the code', () => {
    const p = fakePersistence();
    const code = new NativeAuthStore(() => Date.now(), p)
      .createLoopbackCode({ userId: 'u1', challenge: pkceChallenge('c'.repeat(43)), redirect: 'http://127.0.0.1:1/cb' });
    const after = new NativeAuthStore(() => Date.now(), p);
    expect(after.consumeLoopbackCode(code, 'wrong-verifier')).toBeNull();
    expect(p.rows.size).toBe(0);
  });

  it('carries the pending loopback state across a restart', () => {
    const p = fakePersistence();
    const before = new NativeAuthStore(() => Date.now(), p);
    before.createPendingLoopback('state-1', { challenge: 'ch', redirect: 'http://127.0.0.1:1/cb', appState: 'app-1' });

    const after = new NativeAuthStore(() => Date.now(), p);
    const rec = after.consumePendingLoopback('state-1');
    expect(rec?.appState).toBe('app-1');
    expect(rec?.redirect).toBe('http://127.0.0.1:1/cb');
    // Single-use here too.
    expect(after.consumePendingLoopback('state-1')).toBeNull();
  });

  it('does not resurrect an expired persisted code', () => {
    const p = fakePersistence();
    const verifier = 'd'.repeat(43);
    // Issue it "in the past" so its stored TTL has already lapsed.
    const past = Date.now() - LOOPBACK_CODE_TTL_MS - 1000;
    const before = new NativeAuthStore(() => past, p);
    const code = before.createLoopbackCode({ userId: 'u1', challenge: pkceChallenge(verifier), redirect: 'http://127.0.0.1:1/cb' });

    const after = new NativeAuthStore(() => Date.now(), p);
    expect(after.consumeLoopbackCode(code, verifier)).toBeNull();
  });

  it('works with no persistence at all (pure in-memory, unchanged)', () => {
    const verifier = 'e'.repeat(43);
    const s = new NativeAuthStore();
    const code = s.createLoopbackCode({ userId: 'u1', challenge: pkceChallenge(verifier), redirect: 'http://127.0.0.1:1/cb' });
    expect(s.consumeLoopbackCode(code, verifier)).toEqual({ userId: 'u1' });
    expect(s.consumeLoopbackCode(code, verifier)).toBeNull();
  });
});
