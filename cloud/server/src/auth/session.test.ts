import { describe, it, expect } from 'vitest';
import { createSessionToken, verifySessionToken, parseCookies, bearerToken } from './session.js';

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

describe('bearerToken', () => {
  it('reads the token, however the header is spaced or cased', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('BEARER\tabc')).toBe('abc');
    expect(bearerToken('  Bearer   abc  ')).toBe('abc');
    // The old regex captured everything after the separator, spaces included.
    expect(bearerToken('Bearer abc def')).toBe('abc def');
  });

  it('refuses anything that is not a bearer header', () => {
    for (const header of [undefined, '', '   ', 'Bearer', 'Bearerabc', 'Basic abc', 'Bearer ', 'Bearer \t ']) {
      expect(bearerToken(header), String(header)).toBeNull();
    }
    // A CR/LF in the value is refused, as it was before — `.` never crossed a
    // newline. (Node rejects such a header first; this is belt and braces.)
    expect(bearerToken('Bearer a\nb')).toBeNull();
  });

  it('stays linear on a long whitespace run that cannot match', () => {
    // The regression this shape exists to prevent: `/^Bearer\s+(.+)$/` made the
    // engine explore every split of a space run between `\s+` and `.+`, so a
    // failing header cost O(n²) — on a code path every unauthenticated request
    // reaches for free. Quadratic at this size takes seconds; linear is instant.
    // The run has to survive `.trim()` (so it needs trailing content) and the
    // value has to be UNMATCHABLE (a newline `.` cannot cross), which is what
    // forces the engine through every split instead of succeeding on the first.
    const hostile = `Bearer${' '.repeat(120_000)}x\ny`;
    const started = Date.now();
    expect(bearerToken(hostile)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
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
