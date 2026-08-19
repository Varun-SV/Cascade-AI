import { describe, it, expect, vi, beforeEach } from 'vitest';

interface IoOptions { auth?: { clientId?: string } }

const io = vi.fn((_options?: IoOptions) => ({ close: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: (options?: IoOptions) => io(options) }));

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

  it('still connects when the id cannot be stored', async () => {
    // Private-mode / blocked storage must not break connecting; it only costs
    // that tab its resumability, which is the pre-existing behaviour.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      const { getSocket } = await freshModule();
      expect(() => getSocket()).not.toThrow();
      expect(optionsFromCall().auth?.clientId).toBeUndefined();
    } finally {
      getItem.mockRestore();
    }
  });
});
