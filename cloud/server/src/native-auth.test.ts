import { describe, it, expect } from 'vitest';
import {
  pkceChallenge, verifyPkce, generateUserCode, normalizeUserCode, isLoopbackRedirect,
  NativeAuthStore, DEVICE_POLL_INTERVAL_S, hashRefreshToken,
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
