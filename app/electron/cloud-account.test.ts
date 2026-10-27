import { describe, expect, it } from 'vitest';
import { accountMismatch } from './cloud-account';

describe('accountMismatch', () => {
  const u1 = { userId: 'u1', serverUrl: 'https://cloud' };

  it('lets a request through for the account signed in now', () => {
    expect(accountMismatch(u1, 'u1', 'https://cloud')).toBe(false);
  });

  it('refuses one meant for another user, another server, or when signed out', () => {
    expect(accountMismatch(u1, 'u2', 'https://cloud')).toBe(true);
    expect(accountMismatch(u1, 'u1', 'https://other')).toBe(true);
    expect(accountMismatch(u1, undefined, 'https://cloud')).toBe(true);
  });

  it('refuses an account it cannot read, and does not check callers that name none', () => {
    expect(accountMismatch('u1', 'u1', 'https://cloud')).toBe(true);
    expect(accountMismatch({ userId: 1, serverUrl: 'https://cloud' }, '1', 'https://cloud')).toBe(true);
    expect(accountMismatch(undefined, 'u1', 'https://cloud')).toBe(false);
    expect(accountMismatch(null, undefined, 'https://cloud')).toBe(false);
  });
});
