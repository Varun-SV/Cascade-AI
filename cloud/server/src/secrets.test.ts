import { describe, it, expect } from 'vitest';
import { encryptAtRest, decryptAtRest } from './secrets.js';

describe('at-rest secret encryption', () => {
  const secret = 'a-sufficiently-long-server-secret';

  it('round-trips plaintext', () => {
    const blob = encryptAtRest('{"access_token":"xyz"}', secret);
    expect(blob).not.toContain('xyz'); // ciphertext, not plaintext
    expect(decryptAtRest(blob, secret)).toBe('{"access_token":"xyz"}');
  });

  it('fails to decrypt with a different key', () => {
    const blob = encryptAtRest('secret-data', secret);
    expect(() => decryptAtRest(blob, 'a-different-server-secret-value')).toThrow();
  });

  it('fails on a tampered ciphertext (GCM auth tag)', () => {
    const blob = encryptAtRest('secret-data', secret);
    const [iv, tag, ct] = blob.split('.');
    const flipped = ct.slice(0, -2) + (ct.endsWith('A') ? 'B' : 'A') + ct.slice(-1);
    expect(() => decryptAtRest(`${iv}.${tag}.${flipped}`, secret)).toThrow();
  });
});
