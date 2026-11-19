import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gracefulShutdown } from './index.js';

describe('gracefulShutdown', () => {
  it('ends relay leases, sockets, the HTTP server and the database, once', async () => {
    const order: string[] = [];
    const httpServer = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const port = (httpServer.address() as AddressInfo).port;
    const shutdown = gracefulShutdown({
      httpServer,
      io: { close: (cb?: () => void) => { order.push('sockets'); cb?.(); } },
      store: { close: () => { order.push('database'); } },
      stopMediaSweeper: () => { order.push('sweeper'); },
      browserRelay: { close: async () => { order.push('relay'); } },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const first = shutdown('SIGTERM');
    expect(shutdown('SIGTERM')).toBe(first);
    await first;

    // Paired browsers are told first (the relay sends them "restarting"); the
    // database is closed last, after nothing can write to it any more.
    expect(order).toEqual(['sweeper', 'relay', 'sockets', 'database']);
    expect(httpServer.listening).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('cuts a request still open rather than waiting for it, so the database is closed (Codex on 7ecb40e)', async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((r) => { started = r; });
    // Answers never: a slow download or upload that outlasts the shutdown timeout.
    const httpServer = http.createServer(() => { started(); });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const port = (httpServer.address() as AddressInfo).port;
    const pending = fetch(`http://127.0.0.1:${port}/slow`).catch(() => 'cut');
    await requestStarted;
    const closed = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // As Socket.IO does: its close closes the HTTP server and calls back once that has.
    const done = gracefulShutdown({
      httpServer,
      io: { close: (cb?: () => void) => { httpServer.close(() => cb?.()); } },
      store: { close: closed },
      stopMediaSweeper: () => {},
    })('SIGTERM');
    const outcome = await Promise.race([done.then(() => 'done'), new Promise((r) => setTimeout(() => r('stuck'), 2000))]);
    expect(outcome).toBe('done');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(await pending).toBe('cut');
  });

  it('still closes the rest when the relay fails to close', async () => {
    const httpServer = http.createServer();
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const closed = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await gracefulShutdown({
      httpServer,
      io: { close: (cb?: () => void) => cb?.() },
      store: { close: closed },
      stopMediaSweeper: () => {},
      browserRelay: { close: async () => { throw new Error('boom'); } },
    })('SIGTERM');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(httpServer.listening).toBe(false);
  });
});
