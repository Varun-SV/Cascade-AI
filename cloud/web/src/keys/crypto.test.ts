import { describe, it, expect } from 'vitest';
import { encryptJSON, decryptJSON, type EncryptedBlob } from './crypto.js';

describe('crypto (WebCrypto AES-GCM + PBKDF2)', () => {
  it('round-trips arbitrary JSON through encrypt/decrypt with the right passphrase', async () => {
    const original = [
      { type: 'anthropic', apiKey: 'sk-ant-secret' },
      { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1' },
    ];
    const blob = await encryptJSON(original, 'correct horse battery staple');
    const restored = await decryptJSON<typeof original>(blob, 'correct horse battery staple');
    expect(restored).toEqual(original);
  });

  it('never leaks plaintext into the encrypted blob', async () => {
    const blob = await encryptJSON({ apiKey: 'sk-super-secret-value' }, 'a-passphrase');
    expect(blob.ciphertext).not.toContain('sk-super-secret-value');
    expect(JSON.stringify(blob)).not.toContain('sk-super-secret-value');
  });

  it('rejects a wrong passphrase instead of silently returning garbage', async () => {
    const blob = await encryptJSON({ secret: 'value' }, 'right-passphrase');
    await expect(decryptJSON(blob, 'wrong-passphrase')).rejects.toThrow();
  });

  it('rejects a tampered ciphertext (authentication, not just confidentiality)', async () => {
    const blob = await encryptJSON({ secret: 'value' }, 'a-passphrase');
    const tampered: EncryptedBlob = { ...blob, ciphertext: blob.ciphertext.slice(0, -4) + 'AAAA' };
    await expect(decryptJSON(tampered, 'a-passphrase')).rejects.toThrow();
  });

  it('uses a fresh salt and IV each time, so encrypting the same data twice differs', async () => {
    const a = await encryptJSON({ x: 1 }, 'pw');
    const b = await encryptJSON({ x: 1 }, 'pw');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});
