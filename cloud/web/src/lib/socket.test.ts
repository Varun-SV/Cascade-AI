import { describe, it, expect, vi, beforeEach } from 'vitest';

interface IoOptions { auth?: { clientId?: string } }

const io = vi.fn((_options?: IoOptions) => ({ close: vi.fn(), disconnect: vi.fn().mockReturnThis(), connect: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: (options?: IoOptions) => io(options) }));

// jsdom has no BroadcastChannel, and claimClientId degrades to the stored id
// without one — which is the path these tests exercise. The collision-and-
// rotation behaviour has its own tests in client-id.test.ts.
vi.stubGlobal('BroadcastChannel', undefined);

/** The options object `getSocket()` handed to socket.io on its Nth call. */
function optionsFromCall(n = 0): IoOptions {
  return io.mock.calls[n]?.[0] ?? {};
}

async function freshModule() {
  vi.resetModules();
  return import('./socket.js');
}

beforeEach(() => {
  io.mockClear();
  sessionStorage.clear();
});

describe('getSocket — per-tab identity', () => {
  it('sends a client id on the handshake', async () => {
    // Without this the server cannot tell a reconnect from another tab, and
    // refuses to hold runs at all — so the whole resume path is only as real
    // as this one option actually being passed.
    const { getSocket } = await freshModule();
    getSocket();

    expect(optionsFromCall().auth?.clientId).toEqual(expect.any(String));
    expect(optionsFromCall().auth?.clientId).toBeTruthy();
  });

  it('keeps the same id across a reload of the same tab', async () => {
    // A socket drop and a page reload often arrive together. An id regenerated
    // on reload would look like a different tab to the server, and the run it
    // was holding would never be adopted.
    const first = await freshModule();
    first.getSocket();
    const before = optionsFromCall().auth?.clientId;

    io.mockClear();
    const reloaded = await freshModule();
    reloaded.getSocket();
    const after = optionsFromCall().auth?.clientId;

    expect(after).toBe(before);
  });

  /**
   * A BroadcastChannel the test controls the timing of.
   *
   * `echoTakenFor` models the other tab answering DURING the claim — the
   * synchronous ordering. Leaving it unset lets the test deliver later
   * instead, which is what a real (async) BroadcastChannel does.
   */
  function installChannel(echoTakenFor?: string) {
    const listeners: Array<(e: MessageEvent) => void> = [];
    class FakeChannel {
      constructor(readonly name: string) {}
      set onmessage(fn: ((e: MessageEvent) => void) | null) { if (fn) listeners.push(fn); }
      postMessage(data: unknown) {
        const m = data as { type?: string; id?: string };
        if (echoTakenFor && m?.type === 'claim' && m.id === echoTakenFor) {
          for (const l of [...listeners]) l({ data: { type: 'taken', id: echoTakenFor } } as MessageEvent);
        }
      }
      close() { /* nothing to release */ }
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    return {
      deliver: (data: unknown) => { for (const l of [...listeners]) l({ data } as MessageEvent); },
    };
  }

  it('connects on the rotated id when the collision is known before the socket exists', async () => {
    // claimClientId can only report a collision; acting on it is this module's
    // job. Left unhandled, the duplicated tab keeps connecting on the id it
    // inherited while storage already holds a different one — the server still
    // sees two sockets as one resume owner, and nothing ever retries.
    const held = 'id-held-by-the-original-tab';
    installChannel(held);
    sessionStorage.setItem('cascade.clientId', held);

    // The original tab answers the claim while it is still being made, so the
    // rotation is already settled by the time the socket is built.
    const { getSocket } = await freshModule();
    getSocket();

    const rotated = sessionStorage.getItem('cascade.clientId');
    expect(rotated).not.toBe(held);
    // No reconnect needed in this ordering — it simply never connects on the
    // colliding id at all.
    expect(optionsFromCall().auth?.clientId).toBe(rotated);
  });

  it('moves a live connection onto the rotated id when the collision arrives later', async () => {
    // The ordering a real BroadcastChannel actually produces: delivery is
    // async, so the socket is already up on the inherited id. Rotating storage
    // alone would leave the LIVE connection on the colliding identity, which is
    // the one the server matches on.
    const channel = installChannel();
    const held = 'id-held-by-the-original-tab';
    sessionStorage.setItem('cascade.clientId', held);

    const { getSocket } = await freshModule();
    const created = getSocket() as unknown as {
      auth?: { clientId?: string };
      disconnect: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
    };
    expect(optionsFromCall().auth?.clientId).toBe(held);

    channel.deliver({ type: 'taken', id: held });

    const rotated = sessionStorage.getItem('cascade.clientId');
    expect(rotated).not.toBe(held);
    expect(created.auth?.clientId).toBe(rotated);
    expect(created.disconnect).toHaveBeenCalled();
    expect(created.connect).toHaveBeenCalled();
  });

  it('still connects when the id cannot be stored', async () => {
    // Private-mode / blocked storage must not break connecting; it only costs
    // that tab its resumability, which is the pre-existing behaviour.
    // setItem, not getItem: an id that cannot be READ is simply minted afresh,
    // and that tab is still resumable for as long as it stays connected. It is
    // the inability to PERSIST one that leaves it with no identity to return
    // on, which is the case worth pinning.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      const { getSocket } = await freshModule();
      expect(() => getSocket()).not.toThrow();
      expect(optionsFromCall().auth?.clientId).toBeUndefined();
    } finally {
      setItem.mockRestore();
    }
  });
});
