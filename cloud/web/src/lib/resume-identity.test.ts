import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The two halves of the resume identity, driven together: the claim and the
 * connection it gates. Kept out of socket.test.ts because the point here is
 * the ORDER the server observes, not either module's own contract.
 */

interface IoOptions { autoConnect?: boolean }

/** Every connection the "browser" made, in the order the server would see it. */
const handshakes: Array<{ clientId?: string }> = [];

const io = vi.fn((_options?: IoOptions) => {
  const sock = {
    auth: undefined as { clientId?: string } | undefined,
    connect: vi.fn(() => { handshakes.push({ clientId: sock.auth?.clientId }); return sock; }),
    disconnect: vi.fn(() => sock),
    close: vi.fn(),
  };
  return sock;
});
vi.mock('socket.io-client', () => ({ io: (options?: IoOptions) => io(options) }));

class FakeChannel {
  static live: FakeChannel[] = [];
  private handler: ((e: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { FakeChannel.live.push(this); }
  set onmessage(fn: ((e: MessageEvent) => void) | null) { this.handler = fn; }
  postMessage(data: unknown) {
    for (const other of FakeChannel.live) {
      if (other !== this && other.name === this.name) other.handler?.({ data } as MessageEvent);
    }
  }
  close() { FakeChannel.live = FakeChannel.live.filter((c) => c !== this); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // getSocket memoises one socket per module instance, so each case needs a
  // fresh module or the second one silently reuses the first's connection.
  vi.resetModules();
  handshakes.length = 0;
  io.mockClear();
  FakeChannel.live = [];
  sessionStorage.clear();
  vi.stubGlobal('BroadcastChannel', FakeChannel);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a duplicated tab never reaches the server on the original tab’s key', () => {
  it('connects only on its rotated identity', async () => {
    // The full sequence that made this a P1. The server treats a socket
    // arriving on an existing resume key as that client coming back, and moves
    // the runs over immediately — so if a duplicated tab ever connects on the
    // id it inherited, even briefly, it takes the original tab's in-flight run
    // and then carries it away when it rotates. The original is left connected
    // but evicted, its runs gone, and the grace timer eventually aborts them.
    //
    // The guarantee asserted here is the one that makes the server's immediate
    // takeover safe: no handshake is ever made on a copied id.
    const original = new FakeChannel('cascade.client-id');
    const held = 'id-held-by-the-original-tab';
    original.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; id: string };
      if (m?.type === 'claim' && m.id === held) original.postMessage({ type: 'taken', id: held });
    };

    // The duplicate comes up with the parent's session storage already copied in.
    sessionStorage.setItem('cascade.clientId', held);
    const { getSocket } = await import('./socket.js');
    getSocket();
    await flush();

    expect(handshakes).toHaveLength(1);
    expect(handshakes[0]?.clientId).not.toBe(held);
    expect(handshakes[0]?.clientId).toBe(sessionStorage.getItem('cascade.clientId'));
  });

  it('an uncontested tab connects on the id it stored', async () => {
    // The control: without another tab answering, the same flow must keep the
    // stored identity, or every reload would forfeit its resumable run.
    vi.useFakeTimers();
    try {
      sessionStorage.setItem('cascade.clientId', 'sole-owner');
      const { getSocket } = await import('./socket.js');
      getSocket();
      await vi.advanceTimersByTimeAsync(60);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    expect(handshakes).toHaveLength(1);
    expect(handshakes[0]?.clientId).toBe('sole-owner');
  });
});
