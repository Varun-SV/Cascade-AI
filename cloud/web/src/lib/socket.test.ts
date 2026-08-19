import { describe, it, expect, vi, beforeEach } from 'vitest';

interface IoOptions { autoConnect?: boolean; auth?: { clientId?: string } }

const created = { auth: undefined as { clientId?: string } | undefined, connect: vi.fn(), close: vi.fn() };
const io = vi.fn((_options?: IoOptions) => created);
vi.mock('socket.io-client', () => ({ io: (options?: IoOptions) => io(options) }));

async function freshModule() {
  vi.resetModules();
  return import('./socket.js');
}

function optionsFromCall(n = 0): IoOptions {
  return io.mock.calls[n]?.[0] ?? {};
}

/**
 * The auth the module set, read through a call so TypeScript does not narrow
 * it to `undefined` from the reset in `beforeEach` — the assignment that
 * matters happens inside the module under test, which control flow cannot see.
 */
function currentAuth(): { clientId?: string } | undefined {
  return created.auth;
}

/** Let the claim promise settle before asserting on the connection. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  io.mockClear();
  created.connect.mockClear();
  created.auth = undefined;
  sessionStorage.clear();
  vi.stubGlobal('BroadcastChannel', undefined);
});

describe('getSocket — per-tab identity', () => {
  it('does not connect until the identity has settled', async () => {
    // The server treats a socket arriving on an existing resume key as that
    // client coming back and moves its runs over at once. Connecting first and
    // correcting the identity afterwards therefore hands another tab's work to
    // this one inside that window — so the connection has to wait.
    const { getSocket } = await freshModule();
    getSocket();

    expect(optionsFromCall().autoConnect).toBe(false);
    expect(created.connect).not.toHaveBeenCalled();

    await flush();
    expect(created.connect).toHaveBeenCalledTimes(1);
  });

  it('connects with the settled client id on the handshake', async () => {
    // Without this the server cannot tell a reconnect from a stranger and
    // refuses to hold runs at all, so the whole resume path is only as real as
    // this option actually being passed.
    const { getSocket } = await freshModule();
    getSocket();
    await flush();

    expect(currentAuth()?.clientId).toEqual(expect.any(String));
    expect(sessionStorage.getItem('cascade.clientId')).toBe(currentAuth()?.clientId);
  });

  it('keeps the same id across a reload of the same tab', async () => {
    // A socket drop and a page reload often arrive together. An id regenerated
    // on reload would look like a different tab, and the run being held for it
    // would never be adopted.
    const first = await freshModule();
    first.getSocket();
    await flush();
    const before = currentAuth()?.clientId;

    created.auth = undefined;
    const reloaded = await freshModule();
    reloaded.getSocket();
    await flush();

    expect(currentAuth()?.clientId).toBe(before);
  });

  it('still connects when no identity can be established', async () => {
    // Losing resumability must not lose the connection.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      const { getSocket } = await freshModule();
      expect(() => getSocket()).not.toThrow();
      await flush();
      expect(created.connect).toHaveBeenCalledTimes(1);
      expect(currentAuth()?.clientId).toBeUndefined();
    } finally {
      setItem.mockRestore();
    }
  });
});
