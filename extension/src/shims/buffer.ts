// The slice of Node's Buffer the device code uses, for a service worker that has none:
// UTF-8 and base64url in and out, and byteLength. Installed as globalThis.Buffer by the
// build, before any device module runs.

type Encoding = 'utf8' | 'utf-8' | 'base64' | 'base64url' | 'hex' | undefined;

const enc = new TextEncoder();
const dec = new TextDecoder();

function fromBase64(text: string, url: boolean): Uint8Array {
  let s = url ? text.replace(/-/g, '+').replace(/_/g, '/') : text;
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array, url: boolean): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const s = btoa(bin);
  return url ? s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : s;
}

// @ts-expect-error -- Node's Buffer.from takes an encoding where Uint8Array.from takes a mapper.
export class Buffer extends Uint8Array {
  static from(value: string | ArrayLike<number> | ArrayBufferLike, encoding?: Encoding): Buffer {
    if (typeof value === 'string') {
      const bytes = encoding === 'base64' || encoding === 'base64url' ? fromBase64(value, encoding === 'base64url')
        : encoding === 'hex' ? Uint8Array.from(value.match(/../g) ?? [], (h) => parseInt(h, 16))
          : enc.encode(value);
      return Buffer.wrap(bytes);
    }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) return Buffer.wrap(new Uint8Array(value));
    return Buffer.wrap(Uint8Array.from(value as ArrayLike<number>));
  }

  private static wrap(bytes: Uint8Array): Buffer {
    const b = new Buffer(bytes.length);
    b.set(bytes);
    return b;
  }

  static isBuffer(value: unknown): value is Buffer { return value instanceof Buffer; }

  static byteLength(text: string): number { return enc.encode(text).length; }

  static concat(list: readonly Uint8Array[]): Buffer {
    const out = new Buffer(list.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of list) { out.set(b, at); at += b.length; }
    return out;
  }

  override toString(encoding?: Encoding): string {
    if (encoding === 'base64' || encoding === 'base64url') return toBase64(this, encoding === 'base64url');
    if (encoding === 'hex') return Array.from(this, (x) => x.toString(16).padStart(2, '0')).join('');
    return dec.decode(this);
  }
}
