// `node:crypto` for the extension: Ed25519 keys, signatures and SHA-256, the only
// parts the device code uses. Synchronous, as Node's are: WebCrypto's Ed25519 is
// async, and the device code signs and verifies inline. @noble/curves is audited and
// has no dependencies beyond @noble/hashes.
//
// Keys travel in the same formats Node uses (PKCS#8 PEM for the private key, SPKI DER
// for the public one), so a key made here is read by the server exactly as a key made
// by Node is. The tests check both directions.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from './buffer.js';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  bytes.length === prefix.length + 32 && prefix.every((b, i) => bytes[i] === b);

export class KeyObject {
  constructor(readonly type: 'public' | 'private', readonly raw: Uint8Array) {}
  get asymmetricKeyType(): string { return 'ed25519'; }

  export(opts: { type: 'pkcs8' | 'spki'; format: 'pem' | 'der' }): string | Buffer {
    if (this.type === 'private' && opts.type === 'pkcs8') {
      const der = Buffer.concat([PKCS8_PREFIX, this.raw]);
      if (opts.format === 'der') return der;
      return `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`;
    }
    if (this.type === 'public' && opts.type === 'spki' && opts.format === 'der') return Buffer.concat([SPKI_PREFIX, this.raw]);
    throw new Error(`export of a ${this.type} key as ${opts.type}/${opts.format} is not supported here`);
  }
}

export function generateKeyPairSync(kind: 'ed25519'): { publicKey: KeyObject; privateKey: KeyObject } {
  if (kind !== 'ed25519') throw new Error('only ed25519');
  const seed = ed25519.utils.randomPrivateKey();
  return { privateKey: new KeyObject('private', seed), publicKey: new KeyObject('public', ed25519.getPublicKey(seed)) };
}

export function createPrivateKey(pem: string): KeyObject {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64');
  if (!startsWith(der, PKCS8_PREFIX)) throw new Error('not an Ed25519 private key');
  return new KeyObject('private', der.slice(PKCS8_PREFIX.length));
}

export function createPublicKey(from: KeyObject | { key: Uint8Array; format: 'der'; type: 'spki' }): KeyObject {
  if (from instanceof KeyObject) {
    return from.type === 'public' ? from : new KeyObject('public', ed25519.getPublicKey(from.raw));
  }
  if (from.format !== 'der' || from.type !== 'spki' || !startsWith(from.key, SPKI_PREFIX)) throw new Error('not an Ed25519 public key');
  const raw = from.key.slice(SPKI_PREFIX.length);
  // A point that isn't on the curve is refused as Node refuses it.
  ed25519.ExtendedPoint.fromHex(raw);
  return new KeyObject('public', raw);
}

export function sign(_algorithm: null, data: Uint8Array, key: KeyObject): Buffer {
  if (key.type !== 'private') throw new Error('signing needs a private key');
  return Buffer.from(ed25519.sign(data, key.raw));
}

export function verify(_algorithm: null, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean {
  if (key.type !== 'public') throw new Error('verifying needs a public key');
  if (signature.length !== 64) return false;
  try {
    // RFC 8032's strict rules, as OpenSSL applies them: no ZIP-215 leniency.
    return ed25519.verify(signature, data, key.raw, { zip215: false });
  } catch {
    return false;
  }
}

export function createHash(algorithm: 'sha256') {
  if (algorithm !== 'sha256') throw new Error('only sha256');
  const h = sha256.create();
  return {
    update(data: Uint8Array | string) { h.update(typeof data === 'string' ? Buffer.from(data) : data); return this; },
    digest(encoding?: 'base64url' | 'hex' | 'base64') {
      const out = Buffer.from(h.digest());
      return encoding ? out.toString(encoding) : out;
    },
  };
}

export function randomBytes(n: number): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
}
