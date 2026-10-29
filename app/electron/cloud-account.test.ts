import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountMismatch, isAccountChangedError, pinnedStore } from './cloud-account';
import { CloudAccountChangedError, CloudClient } from '../../src/cloud/client';

/** The session `CloudClient` keeps, as its store holds it. */
type CloudSession = Exclude<ReturnType<NonNullable<ConstructorParameters<typeof CloudClient>[2]>['load']>, null>;

describe('isAccountChangedError', () => {
  it('matches the client error by its code, and nothing else', () => {
    expect(isAccountChangedError(new CloudAccountChangedError())).toBe(true);
    expect(isAccountChangedError({ code: 'CLOUD_ACCOUNT_CHANGED' })).toBe(true);
    expect(isAccountChangedError(new Error('Signed in to another account.'))).toBe(false);
    expect(isAccountChangedError(undefined)).toBe(false);
  });
});

describe('accountMismatch', () => {
  const u1 = { userId: 'u1', serverUrl: 'https://cloud' };

  it('lets a request through for the account signed in now', () => {
    expect(accountMismatch(u1, 'u1', 'https://cloud')).toBe(false);
  });

  it('refuses one meant for another user, another server, or when signed out', () => {
    expect(accountMismatch(u1, 'u2', 'https://cloud')).toBe(true);
    expect(accountMismatch(u1, 'u1', 'https://other')).toBe(true);
    expect(accountMismatch(u1, undefined, 'https://cloud')).toBe(true);
  });

  it('refuses an account it cannot read, and does not check callers that name none', () => {
    expect(accountMismatch('u1', 'u1', 'https://cloud')).toBe(true);
    expect(accountMismatch({ userId: 1, serverUrl: 'https://cloud' }, '1', 'https://cloud')).toBe(true);
    expect(accountMismatch(undefined, 'u1', 'https://cloud')).toBe(false);
    expect(accountMismatch(null, undefined, 'https://cloud')).toBe(false);
  });
});

describe('a client on the store pinned to one account', () => {
  const session = (id: string): CloudSession => ({
    serverUrl: 'https://cloud', accessToken: `${id}-access`, accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: `${id}-refresh`, user: { id, email: null, name: null },
  } as unknown as CloudSession);
  const shared = (initial: CloudSession | null) => {
    let current = initial;
    return { load: () => current, save: (s: CloudSession) => { current = s; }, clear: () => { current = null; }, set: (s: CloudSession | null) => { current = s; } };
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not refresh and retry under an account that signed in while its request was out', async () => {
    const store = shared(session('u1'));
    const calls: Array<{ url: string; auth?: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, auth: (init.headers as Record<string, string> | undefined)?.['Authorization'], body: init.body as string });
      // u2 signs in while u1's request is out, which then answers 401.
      store.set(session('u2'));
      return new Response('', { status: 401 });
    }));
    const client = new CloudClient('https://cloud', undefined, pinnedStore(store, 'u1'));
    await expect(client.createConversation('u1 prompt')).rejects.toThrow();
    // One request, as u1; no refresh with u2's token and no retry as u2.
    expect(calls.map((c) => [c.url, c.auth])).toEqual([['https://cloud/api/conversations', 'Bearer u1-access']]);
    // u2's sign-in is left as it is.
    expect(store.load()?.user.id).toBe('u2');
  });

  it('refreshes and retries as usual while the account is still signed in', async () => {
    const store = shared(session('u1'));
    const auths: Array<string | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/api/native/refresh')) {
        return new Response(JSON.stringify({ access_token: 'u1-access-2', refresh_token: 'u1-refresh-2', expires_in: 3600 }), { status: 200 });
      }
      auths.push((init.headers as Record<string, string>)['Authorization']);
      return auths.length === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify({ conversation: { id: 'c1', title: 't' } }), { status: 200 });
    }));
    const client = new CloudClient('https://cloud', undefined, pinnedStore(store, 'u1'));
    await expect(client.createConversation('t')).resolves.toMatchObject({ id: 'c1' });
    expect(auths).toEqual(['Bearer u1-access', 'Bearer u1-access-2']);
    expect(store.load()?.accessToken).toBe('u1-access-2');
  });

  // The sign-in changes while the refresh itself is out: the refresh answers
  // with good tokens for u1, but nothing may be sent or retried with them.
  const pausedRefresh = (_store: ReturnType<typeof shared>, firstAnswer: 'expired' | 401) => {
    const calls: Array<{ url: string; auth?: string }> = [];
    let release!: () => void;
    const refreshStarted = new Promise<void>((started) => {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, auth: (init.headers as Record<string, string> | undefined)?.['Authorization'] });
        if (url.endsWith('/api/native/refresh')) {
          started();
          await new Promise<void>((r) => { release = r; });
          return new Response(JSON.stringify({ access_token: 'u1-access-2', refresh_token: 'u1-refresh-2', expires_in: 3600 }), { status: 200 });
        }
        if (firstAnswer === 401 && calls.filter((c) => !c.url.endsWith('/refresh')).length === 1) return new Response('', { status: 401 });
        return new Response(JSON.stringify({ conversation: { id: 'c1', title: 't' }, messages: [], recorded: true }), { status: 200 });
      }));
    });
    return { calls, refreshStarted, resolveRefresh: () => release() };
  };
  type Call = { url: string; auth?: string };
  const sends = (calls: Call[]): Call[] => calls.filter((c) => !c.url.endsWith('/api/native/refresh'));

  it.each([
    ['another account signs in', (): CloudSession | null => session('u2'), 'u2'],
    ['the account signs out', (): CloudSession | null => null, undefined],
  ] as Array<[string, () => CloudSession | null, string | undefined]>)('sends nothing more after a 401 when %s while the refresh is out', async (_what, next, left) => {
    const store = shared(session('u1'));
    const f = pausedRefresh(store, 401);
    const client = new CloudClient('https://cloud', undefined, pinnedStore(store, 'u1'));
    const done = client.appendTurn('c1', { userContent: 'u1 prompt', assistant: { content: 'r' } } as never);
    await f.refreshStarted;
    store.set(next());
    f.resolveRefresh();
    const err = await done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudAccountChangedError);
    expect(isAccountChangedError(err)).toBe(true);
    // Only u1's first request went out; no second append after the switch.
    expect(sends(f.calls).map((c) => c.auth)).toEqual(['Bearer u1-access']);
    expect(store.load()?.user.id).toBe(left);
  });

  it('sends nothing when a token expired before sending and another account signs in during its refresh', async () => {
    const store = shared({ ...session('u1'), accessExpiresAt: Date.now() - 1 });
    const f = pausedRefresh(store, 'expired');
    const client = new CloudClient('https://cloud', undefined, pinnedStore(store, 'u1'));
    const done = client.recordRunSpend({ conversationId: null, outcome: 'answered', costUsd: 0.01, why: 'w' });
    await f.refreshStarted;
    store.set(session('u2'));
    f.resolveRefresh();
    await expect(done).rejects.toBeInstanceOf(CloudAccountChangedError);
    expect(sends(f.calls)).toEqual([]);
    expect(store.load()).toMatchObject({ user: { id: 'u2' }, accessToken: 'u2-access' });
  });

  it('sends nothing when the same account signs in again during the refresh, and keeps the new sign-in', async () => {
    const store = shared(session('u1'));
    const f = pausedRefresh(store, 401);
    const client = new CloudClient('https://cloud', undefined, pinnedStore(store, 'u1'));
    const done = client.createConversation('u1 prompt');
    await f.refreshStarted;
    store.set({ ...session('u1'), accessToken: 'u1-again', refreshToken: 'u1-refresh-again' });
    f.resolveRefresh();
    await expect(done).rejects.toBeInstanceOf(CloudAccountChangedError);
    expect(sends(f.calls).map((c) => c.auth)).toEqual(['Bearer u1-access']);
    expect(store.load()?.refreshToken).toBe('u1-refresh-again');
  });

  it('does the same on an unpinned store (the CLI): no send under a session changed during the refresh', async () => {
    const store = shared(session('u1'));
    const f = pausedRefresh(store, 401);
    const client = new CloudClient('https://cloud', undefined, store);
    const done = client.createConversation('u1 prompt');
    await f.refreshStarted;
    store.set(session('u2'));
    f.resolveRefresh();
    await expect(done).rejects.toBeInstanceOf(CloudAccountChangedError);
    expect(sends(f.calls).map((c) => c.auth)).toEqual(['Bearer u1-access']);
    expect(store.load()?.user.id).toBe('u2');
  });

  it('reads as signed out while another account is signed in, and never saves over or clears it', () => {
    const store = shared(session('u2'));
    const pinned = pinnedStore(store, 'u1');
    expect(pinned.load()).toBeNull();
    pinned.save(session('u1'));
    pinned.clear();
    expect(store.load()?.user.id).toBe('u2');
  });
});
