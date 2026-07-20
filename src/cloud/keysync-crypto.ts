// ─────────────────────────────────────────────
//  Cascade AI — Key-sync crypto (Node, web-compatible)
// ─────────────────────────────────────────────
//
// A byte-for-byte port of the web KeyVault's crypto (cloud/web/src/keys/crypto.ts)
// so a settings blob encrypted on one client decrypts on any other. Same WebCrypto
// primitives, same parameters: AES-256-GCM with a PBKDF2-SHA256 (210k) derived key,
// random 16-byte salt + 12-byte IV per encryption. The passphrase and derived key
// never leave the device; the server only ever relays the ciphertext.

import { webcrypto } from 'node:crypto';

const PBKDF2_ITERATIONS = 210_000; // OWASP 2023 minimum for PBKDF2-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedBlob {
  ciphertext: string; // base64
  salt: string; // base64
  iv: string; // base64
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<webcrypto.CryptoKey> {
  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(data: unknown, passphrase: string): Promise<EncryptedBlob> {
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { ciphertext: toBase64(ciphertext), salt: toBase64(salt), iv: toBase64(iv) };
}

/** Throws (AES-GCM auth-tag check fails) on a wrong passphrase or tampered ciphertext. */
export async function decryptJSON<T>(blob: EncryptedBlob, passphrase: string): Promise<T> {
  const salt = fromBase64(blob.salt);
  const iv = fromBase64(blob.iv);
  const key = await deriveKey(passphrase, salt);
  const ciphertext = fromBase64(blob.ciphertext);
  const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
