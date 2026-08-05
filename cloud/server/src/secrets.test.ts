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

    // Flip a bit in the decoded BYTES rather than editing the base64 text.
    //
    // Editing the text is not reliably tampering. `secret-data` is 11 bytes, so
    // its base64 is 16 characters ending in `=`; the last DATA character
    // carries only 4 significant bits, and the 2 low bits are padding that
    // decoding discards. An edit that lands only on those decodes to identical
    // bytes, GCM verifies happily, and nothing throws.
    //
    // The previous version did exactly that: it checked `ct.endsWith('A')` (the
    // last character, which is always `=`) but replaced the second-to-last, so
    // the replacement was always `A` — a no-op whenever the ciphertext's final
    // nibble was already zero. Measured at 1 run in 16, which is how it failed
    // CI on an unrelated PR.
    const bytes = Buffer.from(ct!, 'base64');
    bytes[0] ^= 0x01;
    expect(() => decryptAtRest(`${iv}.${tag}.${bytes.toString('base64')}`, secret)).toThrow();
  });
});
