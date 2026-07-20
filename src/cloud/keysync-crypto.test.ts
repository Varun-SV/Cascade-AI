import { describe, it, expect } from 'vitest';
import { pbkdf2Sync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { encryptJSON, decryptJSON, type EncryptedBlob } from './keysync-crypto.js';

// The whole point of this module is cross-client interop: a blob written by the
// web KeyVault (WebCrypto) must decrypt on the CLI/desktop and vice-versa. We
// can't run the browser here, so we prove the wire format is *exactly* standard
// PBKDF2-SHA256(210k) + AES-256-GCM by round-tripping against classic node:crypto
// (a wholly independent implementation of the same primitives the browser uses).

const b64 = (u: Uint8Array | Buffer) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');

/** Decrypt an EncryptedBlob with classic node:crypto (independent of WebCrypto). */
function classicDecrypt<T>(blob: EncryptedBlob, passphrase: string): T {
  const key = pbkdf2Sync(passphrase, unb64(blob.salt), 210_000, 32, 'sha256');
  const data = unb64(blob.ciphertext);
  const tag = data.subarray(data.length - 16); // WebCrypto appends the 16-byte GCM tag
  const ct = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(blob.iv));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString('utf-8')) as T;
}

/** Encrypt with classic node:crypto into the same wire format WebCrypto produces. */
function classicEncrypt(data: unknown, passphrase: string): EncryptedBlob {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, 210_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), 'utf-8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: b64(Buffer.concat([ct, tag])), salt: b64(salt), iv: b64(iv) };
}

describe('keysync-crypto', () => {
  const secret = { providers: [{ type: 'anthropic', apiKey: 'sk-xyz' }], prefs: { maxTokens: 4000 } };

  it('round-trips an object through encrypt/decrypt', async () => {
    const blob = await encryptJSON(secret, 'correct horse battery staple');
    const back = await decryptJSON(blob, 'correct horse battery staple');
    expect(back).toEqual(secret);
  });

  it('fails to decrypt with the wrong passphrase', async () => {
    const blob = await encryptJSON(secret, 'right');
    await expect(decryptJSON(blob, 'wrong')).rejects.toThrow();
  });

  it('produces blobs a plain PBKDF2/AES-GCM impl can read (web interop)', async () => {
    const blob = await encryptJSON(secret, 'pp');
    expect(classicDecrypt(blob, 'pp')).toEqual(secret); // WebCrypto blob → classic read
  });

  it('reads blobs a plain PBKDF2/AES-GCM impl produced (web interop)', async () => {
    const blob = classicEncrypt(secret, 'pp');
    expect(await decryptJSON(blob, 'pp')).toEqual(secret); // classic blob → WebCrypto read
  });
});
