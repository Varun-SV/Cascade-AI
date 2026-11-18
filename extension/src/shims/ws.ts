// The `ws` WebSocket surface the device code uses, over the browser's own WebSocket.
//
// Frames arrive as Buffers, as from `ws`, so `String(raw)` and `raw.byteLength` read the
// same. The browser only lets a page or worker close with 1000 or 3000-4999; the device
// code's other codes (1009, 1011) are sent as 1000 with the reason kept.

import { Buffer } from './buffer.js';

type Listener = (...args: unknown[]) => void;

export class WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  private readonly socket: globalThis.WebSocket;
  private readonly listeners = new Map<string, { fn: Listener; once: boolean }[]>();

  constructor(url: string, _options?: unknown) {
    this.socket = new globalThis.WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => this.emit('open');
    this.socket.onmessage = (e: MessageEvent) => {
      const binary = typeof e.data !== 'string';
      this.emit('message', binary ? Buffer.from(e.data as ArrayBuffer) : Buffer.from(e.data as string), binary);
    };
    this.socket.onerror = () => this.emit('error', new Error('WebSocket error'));
    this.socket.onclose = (e: CloseEvent) => this.emit('close', e.code, Buffer.from(e.reason));
  }

  get readyState(): number { return this.socket.readyState; }
  get bufferedAmount(): number { return this.socket.bufferedAmount; }

  send(data: string | Uint8Array, cb?: (err?: Error) => void): void {
    try { this.socket.send(data); cb?.(); } catch (e) { if (cb) cb(e as Error); else throw e; }
  }

  close(code?: number, reason?: string): void {
    const allowed = code === 1000 || (code !== undefined && code >= 3000 && code <= 4999);
    // A close reason is at most 123 bytes.
    const why = reason ? Buffer.from(reason).slice(0, 120).toString() : undefined;
    try { this.socket.close(allowed ? code : 1000, why); } catch { this.socket.close(); }
  }

  terminate(): void { this.socket.close(); }

  on(event: string, fn: Listener): this { return this.add(event, fn, false); }
  addListener(event: string, fn: Listener): this { return this.add(event, fn, false); }
  once(event: string, fn: Listener): this { return this.add(event, fn, true); }

  off(event: string, fn: Listener): this {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter((l) => l.fn !== fn));
    return this;
  }
  removeListener(event: string, fn: Listener): this { return this.off(event, fn); }
  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event); else this.listeners.clear();
    return this;
  }

  private add(event: string, fn: Listener, once: boolean): this {
    const list = this.listeners.get(event) ?? [];
    list.push({ fn, once });
    this.listeners.set(event, list);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event);
    if (!list?.length) {
      // As with `ws`: an error nobody listens for is not swallowed silently.
      if (event === 'error') console.warn('[cascade relay] socket error with no listener');
      return;
    }
    this.listeners.set(event, list.filter((l) => !l.once));
    for (const l of list) l.fn(...args);
  }
}

export class WebSocketServer {
  constructor() { throw new Error('A browser extension serves no sockets.'); }
}

export default WebSocket;
