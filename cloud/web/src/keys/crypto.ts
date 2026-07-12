// WebCrypto AES-GCM + PBKDF2 — encrypts provider keys client-side before
// they ever leave the browser for Google Drive appData sync. The server and
// Google both only ever see ciphertext; the passphrase and derived key never
// leave this module.

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
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(data: unknown, passphrase: string): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext);
  return { ciphertext: toBase64(ciphertext), salt: toBase64(salt), iv: toBase64(iv) };
}

/** Throws (AES-GCM auth-tag check fails) on a wrong passphrase or tampered ciphertext. */
export async function decryptJSON<T>(blob: EncryptedBlob, passphrase: string): Promise<T> {
  const salt = fromBase64(blob.salt);
  const iv = fromBase64(blob.iv);
  const key = await deriveKey(passphrase, salt);
  const ciphertext = fromBase64(blob.ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
