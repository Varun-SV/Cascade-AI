import { describe, it, expect } from 'vitest';
import { createSessionToken, verifySessionToken, parseCookies } from './session.js';

describe('session tokens', () => {
  const secret = 'a-very-secret-test-value';

  it('round-trips a valid session token', () => {
    const token = createSessionToken({ userId: 'user-1' }, secret);
    const session = verifySessionToken(token, secret);
    expect(session).toEqual({ userId: 'user-1' });
  });

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken({ userId: 'user-1' }, secret);
    expect(verifySessionToken(token, 'wrong-secret')).toBeNull();
  });

  it('rejects garbage tokens', () => {
    expect(verifySessionToken('not-a-jwt', secret)).toBeNull();
  });

  it('rejects an alg:none forged token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId: 'attacker' })).toString('base64url');
    const forged = `${header}.${payload}.`;
    expect(verifySessionToken(forged, secret)).toBeNull();
  });
});

describe('parseCookies', () => {
  it('returns an empty object for an undefined header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('parses multiple cookies separated by "; "', () => {
    expect(parseCookies('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('URL-decodes cookie values', () => {
    expect(parseCookies('name=hello%20world')).toEqual({ name: 'hello world' });
  });

  it('ignores malformed segments without an "="', () => {
    expect(parseCookies('a=1; garbage; b=2')).toEqual({ a: '1', b: '2' });
  });
});
