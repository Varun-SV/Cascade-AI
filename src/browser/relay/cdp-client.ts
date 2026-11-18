// ─────────────────────────────────────────────
//  Cascade AI — The device's own CDP connection
// ─────────────────────────────────────────────
//
//  The privileged channel the policy and the relay use. The agent never sees it.

import { WebSocket } from 'ws';

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  sessionId?: string;
}

export interface CdpClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  on(fn: (msg: CdpMessage) => void): void;
  onClose(fn: () => void): void;
  close(): void;
  readonly closed: boolean;
}

export const CDP_MAX_FRAME_BYTES = 512 * 1024 * 1024;

export async function connectCdp(url: string): Promise<CdpClient> {
  // A paused request's event carries its body, twice and base64-encoded, so a 32 MB upload
  // overran ws's default 100 MiB frame limit and dropped the policy's connection. Larger
  // frames are allowed; one past even this still drops the connection, which the
  // policy treats as lost: the proxy shuts and the lease ends.
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: CDP_MAX_FRAME_BYTES });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve(r: Record<string, unknown>): void; reject(e: Error): void }>();
  const listeners: ((m: CdpMessage) => void)[] = [];
  const closers: (() => void)[] = [];
  ws.on('error', () => { /* 'close' follows */ });
  ws.on('close', () => {
    closed = true;
    for (const p of pending.values()) p.reject(new Error('CDP connection closed'));
    pending.clear();
    for (const fn of closers) fn();
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as CdpMessage;
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
      else p.resolve(msg.result ?? {});
    } else for (const fn of listeners) fn(msg);
  });
  return {
    get closed() { return closed; },
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error('CDP connection closed'));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(fn) { listeners.push(fn); },
    onClose(fn) { closers.push(fn); },
    close() { ws.close(); },
  };
}
