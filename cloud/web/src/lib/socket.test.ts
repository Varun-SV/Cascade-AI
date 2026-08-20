import { describe, it, expect, vi, beforeEach } from 'vitest';

interface IoOptions { auth?: { clientId?: string } }

type Handler = (...args: unknown[]) => void;

const created = {
  auth: undefined as { clientId?: string } | undefined,
  handlers: new Map<string, Handler>(),
  on(event: string, fn: Handler) { created.handlers.set(event, fn); return created; },
  close: vi.fn(),
};
const io = vi.fn((_options?: IoOptions) => created);
vi.mock('socket.io-client', () => ({ io: (options?: IoOptions) => io(options) }));

async function freshModule() {
  vi.resetModules();
  return import('./socket.js');
}

function optionsFromCall(n = 0): IoOptions {
  return io.mock.calls[n]?.[0] ?? {};
}

/** Read through a call so control flow does not narrow it from the reset below. */
function currentAuth(): { clientId?: string } | undefined {
  return created.auth;
}

beforeEach(() => {
  io.mockClear();
  created.handlers.clear();
  created.auth = undefined;
  sessionStorage.clear();
});

describe('getSocket — resume identity', () => {
  it('sends a client id on the handshake', async () => {
    // Without one the server cannot match a held run to a returning client at
    // all, so the whole resume path is only as real as this option being sent.
    const { getSocket } = await freshModule();
    getSocket();

    expect(optionsFromCall().auth?.clientId).toEqual(expect.any(String));
    expect(sessionStorage.getItem('cascade.clientId')).toBe(optionsFromCall().auth?.clientId);
  });

  it('keeps the same id across a reload of the same tab', async () => {
    // A socket drop and a page reload often arrive together. An id regenerated
    // on reload would look like a different tab, and the run being held for it
    // would never be adopted.
    const first = await freshModule();
    first.getSocket();
    const before = optionsFromCall().auth?.clientId;

    io.mockClear();
    const reloaded = await freshModule();
    reloaded.getSocket();

    expect(optionsFromCall().auth?.clientId).toBe(before);
  });

  it('adopts the identity the server issues on a collision', async () => {
    // Issued when this connection was found colliding with a live one.
    // Persisting it is what stops the same collision recurring on the next
    // reload, since the copied value in storage is what would come back.
    const { getSocket } = await freshModule();
    getSocket();
    const original = optionsFromCall().auth?.clientId;

    created.handlers.get('run:resumed')?.({ active: 0, finished: [], clientId: 'assigned-by-server' });

    expect(sessionStorage.getItem('cascade.clientId')).toBe('assigned-by-server');
    expect(currentAuth()?.clientId).toBe('assigned-by-server');
    expect(original).not.toBe('assigned-by-server');
  });

  it('leaves the identity alone on an ordinary resume', async () => {
    const { getSocket } = await freshModule();
    getSocket();
    const original = optionsFromCall().auth?.clientId;

    created.handlers.get('run:resumed')?.({ active: 1, finished: [] });

    expect(sessionStorage.getItem('cascade.clientId')).toBe(original);
  });

  it('still connects when no identity can be stored', async () => {
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
