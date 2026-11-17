// ─────────────────────────────────────────────
//  Cascade Cloud — At-rest secret encryption
// ─────────────────────────────────────────────
//
// Symmetric AES-256-GCM used to encrypt secrets we must be able to read back on
// the server (MCP OAuth access/refresh tokens obtained on the user's behalf, so
// runs can call the MCP server). The key is derived from a server secret with a
// domain-separating salt, so this is NOT the session-signing key directly.
// Defense-in-depth for the persistent volume — a leaked DB file is ciphertext.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const KEY_CACHE = new Map<string, Buffer>();

/**
 * One key per purpose, so a blob made for one use never decrypts as another's. MCP
 * tokens keep the salt they were first written with.
 */
export type AtRestPurpose = 'cascade-mcp-oauth-v1' | 'cascade-browser-endpoint-v1';

function keyFor(secret: string, purpose: AtRestPurpose): Buffer {
  const id = `${purpose}\u0000${secret}`;
  let k = KEY_CACHE.get(id);
  if (!k) { k = scryptSync(secret, purpose, 32); KEY_CACHE.set(id, k); }
  return k;
}

/** Encrypt UTF-8 plaintext → `iv.tag.ciphertext` (all base64). */
export function encryptAtRest(plaintext: string, secret: string, purpose: AtRestPurpose = 'cascade-mcp-oauth-v1'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

/** Decrypt an `iv.tag.ciphertext` blob. Throws on tamper / wrong key. */
export function decryptAtRest(blob: string, secret: string, purpose: AtRestPurpose = 'cascade-mcp-oauth-v1'): string {
  const [ivB, tagB, ctB] = blob.split('.');
  if (!ivB || !tagB || !ctB) throw new Error('Malformed encrypted blob');
  const dec = createDecipheriv('aes-256-gcm', keyFor(secret, purpose), Buffer.from(ivB, 'base64'));
  dec.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([dec.update(Buffer.from(ctB, 'base64')), dec.final()]).toString('utf-8');
}
