// The shims stand in for Node inside the extension. What they make has to be read by
// the real thing on the server, and the other way round.

import * as node from 'node:crypto';
import nodeNet from 'node:net';
import { describe, expect, it } from 'vitest';
import * as shim from './shims/crypto.js';
import { Buffer as ShimBuffer } from './shims/buffer.js';
import { isIPv4, isIPv6 } from './shims/net.js';

const msg = new Uint8Array(Buffer.from('cascade-relay-grant\n{"a":1}'));

describe('the crypto shim agrees with Node', () => {
  it('a key made by the shim is read by Node, and its signatures verify there', () => {
    const { privateKey, publicKey } = shim.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const spki = publicKey.export({ type: 'spki', format: 'der' }) as Uint8Array;
    const nodePriv = node.createPrivateKey(pem);
    const nodePub = node.createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
    expect(Buffer.from(node.createPublicKey(nodePriv).export({ type: 'spki', format: 'der' }))).toEqual(Buffer.from(spki));
    const sig = shim.sign(null, msg, privateKey);
    expect(node.verify(null, msg, nodePub, sig)).toBe(true);
  });

  it('a key made by Node is read by the shim, and Node signatures verify in it', () => {
    const { privateKey, publicKey } = node.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const sPub = shim.createPublicKey({ key: new Uint8Array(spki), format: 'der', type: 'spki' });
    const sig = node.sign(null, msg, privateKey);
    expect(shim.verify(null, msg, sPub, sig)).toBe(true);
    expect(shim.sign(null, msg, shim.createPrivateKey(pem))).toEqual(ShimBuffer.from(sig));
  });

  it('a tampered message, a tampered signature or a wrong key does not verify', () => {
    const a = shim.generateKeyPairSync('ed25519');
    const b = shim.generateKeyPairSync('ed25519');
    const sig = shim.sign(null, msg, a.privateKey);
    const changed = msg.slice(); changed[0] ^= 1;
    const badSig = sig.slice(); badSig[5] ^= 1;
    expect(shim.verify(null, changed, a.publicKey, sig)).toBe(false);
    expect(shim.verify(null, msg, a.publicKey, badSig)).toBe(false);
    expect(shim.verify(null, msg, b.publicKey, sig)).toBe(false);
    expect(shim.verify(null, msg, a.publicKey, sig.slice(0, 63))).toBe(false);
  });

  it('refuses keys that are not Ed25519', () => {
    const rsa = node.generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(() => shim.createPrivateKey(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)).toThrow();
    expect(() => shim.createPublicKey({ key: new Uint8Array(rsa.publicKey.export({ type: 'spki', format: 'der' })), format: 'der', type: 'spki' })).toThrow();
  });

  it('SHA-256 in base64url is what Node gives', () => {
    expect(shim.createHash('sha256').update(msg).digest('base64url')).toBe(node.createHash('sha256').update(msg).digest('base64url'));
  });
});

describe('the Buffer shim', () => {
  it('base64url, base64, hex and UTF-8 round-trip as Node does', () => {
    const bytes = node.randomBytes(37);
    for (const enc of ['base64url', 'base64', 'hex'] as const) {
      expect(ShimBuffer.from(bytes).toString(enc)).toBe(bytes.toString(enc));
      expect(Buffer.from(ShimBuffer.from(bytes.toString(enc), enc))).toEqual(bytes);
    }
    expect(ShimBuffer.from('héllo ✓').toString()).toBe('héllo ✓');
    expect(ShimBuffer.from('héllo ✓').byteLength).toBe(Buffer.byteLength('héllo ✓'));
  });
});

describe('the net shim', () => {
  it('reads addresses as Node does', () => {
    for (const s of ['127.0.0.1', '10.0.0.256', '1.2.3', '::1', '::ffff:127.0.0.1', 'fe80::1', '64:ff9b::7f00:1', 'example.com', '1::2::3', '']) {
      expect([s, isIPv4(s), isIPv6(s)]).toEqual([s, nodeNet.isIPv4(s), nodeNet.isIPv6(s)]);
    }
  });
});
