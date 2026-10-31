import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountMismatch, isAccountChangedError, isSyncOffError, pinnedStore, sendGate, SyncOffError } from './cloud-account';
import { fileSyncConsent } from './cloud-sync-consent';
import { CloudAccountChangedError, CloudClient } from '../../src/cloud/client';
import { CloudMirror, mirrorAndConfirm } from '../src/lib/cloud-mirror';

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

  // The refresh's headers have arrived; its body is still being read when the
  // sign-in changes. Nothing may be saved over the newer sign-in, or sent.
  const pausedBody = (firstAnswer: 'expired' | 401, refreshStatus = 200) => {
    const calls: Call[] = [];
    let release!: () => void;
    const bodyStarted = new Promise<void>((started) => {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, auth: (init.headers as Record<string, string> | undefined)?.['Authorization'] });
        if (url.endsWith('/api/native/refresh')) {
          const body = { access_token: 'u1-access-2', refresh_token: 'u1-refresh-2', expires_in: 3600 };
          if (refreshStatus !== 200) { started(); return new Response('', { status: refreshStatus }); }
          return { ok: true, status: 200, json: async () => { started(); await new Promise<void>((r) => { release = r; }); return body; } } as unknown as Response;
        }
        if (firstAnswer === 401 && sends(calls).length === 1) return new Response('', { status: 401 });
        return new Response(JSON.stringify({ conversation: { id: 'c1', title: 't' }, messages: [], recorded: true }), { status: 200 });
      }));
    });
    return { calls, bodyStarted, releaseBody: () => release?.() };
  };

  it.each([
    ['the same account signs in again', (): CloudSession => ({ ...session('u1'), accessToken: 'u1-again', refreshToken: 'u1-refresh-again' })],
    ['another account signs in', (): CloudSession => session('u2')],
  ] as Array<[string, () => CloudSession]>)('saves nothing and sends nothing when %s while the refresh body is read', async (_what, next) => {
    for (const pinned of [true, false]) {
      for (const first of [401, 'expired'] as const) {
        const store = shared(first === 'expired' ? { ...session('u1'), accessExpiresAt: Date.now() - 1 } : session('u1'));
        const f = pausedBody(first);
        const client = new CloudClient('https://cloud', undefined, pinned ? pinnedStore(store, 'u1') : store);
        const done = client.appendTurn('c1', { userContent: 'u1 prompt', assistant: { content: 'r' } } as never);
        await f.bodyStarted;
        const newer = next();
        store.set(newer);
        f.releaseBody();
        await expect(done).rejects.toBeInstanceOf(CloudAccountChangedError);
        // No append after the change; only the first 401'd one, if any.
        expect(sends(f.calls).map((c) => c.auth)).toEqual(first === 401 ? ['Bearer u1-access'] : []);
        // The newer sign-in is left exactly as it was: not overwritten by A's rotated tokens.
        expect(store.load()).toEqual(newer);
      }
    }
  });

  it('a refresh refused while the sign-in changed neither clears the newer sign-in nor sends', async () => {
    const store = shared(session('u1'));
    const f = pausedBody(401, 401);
    // The refusal arrives after u1 signed in again: the check runs before any clear.
    const client = new CloudClient('https://cloud', undefined, pinnedStore(store, 'u1'));
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init: RequestInit = {}) => {
      f.calls.push({ url: String(url), auth: (init.headers as Record<string, string> | undefined)?.['Authorization'] });
      if (String(url).endsWith('/api/native/refresh')) {
        store.set({ ...session('u1'), refreshToken: 'u1-refresh-again' });
        return new Response('', { status: 401 });
      }
      return new Response('', { status: 401 });
    });
    await expect(client.createConversation('u1 prompt')).rejects.toBeInstanceOf(CloudAccountChangedError);
    expect(sends(f.calls).map((c) => c.auth)).toEqual(['Bearer u1-access']);
    expect(store.load()?.refreshToken).toBe('u1-refresh-again');
  });

  it('the pinned store replaces only the session a refresh started from', () => {
    const store = shared(session('u1'));
    const pinned = pinnedStore(store, 'u1');
    const rotated = { ...session('u1'), refreshToken: 'u1-refresh-2' };
    expect(pinned.replace!(session('u1'), rotated)).toBe(true);
    expect(store.load()?.refreshToken).toBe('u1-refresh-2');
    // Started from the old token: the newer one stays.
    expect(pinned.replace!(session('u1'), { ...session('u1'), refreshToken: 'stale' })).toBe(false);
    expect(store.load()?.refreshToken).toBe('u1-refresh-2');
    store.set(session('u2'));
    expect(pinned.replace!(session('u2'), session('u2'))).toBe(false);
  });

  it('reads as signed out while another account is signed in, and never saves over or clears it', () => {
    const store = shared(session('u2'));
    const pinned = pinnedStore(store, 'u1');
    expect(pinned.load()).toBeNull();
    pinned.save(session('u1'));
    pinned.clear();
    expect(store.load()?.user.id).toBe('u2');
  });

  // Two clients on one sign-in (the desktop builds one per request) whose
  // token runs out together. The server rotates refresh tokens and refuses a
  // spent one, as a real one does. Its refresh answers are held until released.
  describe('two clients refreshing the same sign-in at once', () => {
    const rotatingServer = (opts: { refreshStatus?: number; firstAccess?: 'expired' | 401 } = {}) => {
      const calls: Call[] = [];
      const bodies: string[] = [];
      let live = 'u1-refresh';
      const held: Array<() => void> = [];
      let refreshes = 0;
      let notifyRefresh: () => void = () => {};
      const refreshSeen = () => new Promise<void>((r) => { if (refreshes > 0) r(); else notifyRefresh = r; });
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        const auth = (init.headers as Record<string, string> | undefined)?.['Authorization'];
        calls.push({ url, auth });
        if (url.endsWith('/api/native/refresh')) {
          refreshes++;
          notifyRefresh();
          const sent = (JSON.parse(String(init.body)) as { refresh_token: string }).refresh_token;
          await new Promise<void>((r) => { held.push(r); });
          if (opts.refreshStatus && opts.refreshStatus !== 200) return new Response('', { status: opts.refreshStatus });
          if (sent !== live) return new Response('', { status: 401 }); // a spent token
          live = `${sent}-2`;
          return new Response(JSON.stringify({ access_token: 'u1-access-2', refresh_token: live, expires_in: 3600 }), { status: 200 });
        }
        if (auth !== 'Bearer u1-access-2') return new Response('', { status: 401 });
        if (init.body) bodies.push(String(init.body));
        if (url.endsWith('/api/conversations') && !init.method) return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
        return new Response(JSON.stringify({ conversation: { id: 'c1', title: 't' }, messages: [], recorded: true }), { status: 200 });
      }));
      const releaseAll = async () => {
        // Let any second refresh (the race this guards) reach the server first.
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
        while (held.length) held.shift()!();
      };
      return { calls, bodies, refreshSeen, releaseAll, refreshCount: () => refreshes };
    };
    const start = (first: 'expired' | 401) => shared(first === 'expired' ? { ...session('u1'), accessExpiresAt: Date.now() - 1 } : session('u1'));
    const two = (store: ReturnType<typeof shared>, beforeSend?: () => void) => [0, 1].map(() =>
      new CloudClient('https://cloud', undefined, pinnedStore(store, 'u1'), beforeSend ? { beforeSend } : undefined));
    const spend = { conversationId: null, outcome: 'answered' as const, costUsd: 0.01, why: 'w', runId: 'run-1' };

    it.each(['expired', 401] as const)('token %s: one rotation is shared, and both requests go out under it', async (first) => {
      const store = start(first);
      const srv = rotatingServer();
      const [a, b] = two(store);
      const listing = a.listConversations();
      const spending = b.recordRunSpend(spend);
      await srv.refreshSeen();
      await srv.releaseAll();
      await expect(listing).resolves.toEqual([]);
      await expect(spending).resolves.toMatchObject({ recorded: true });
      // One refresh with the old token; the second client never spent it again.
      expect(srv.refreshCount()).toBe(1);
      expect(srv.bodies.filter((x) => x.includes('run-1'))).toHaveLength(1);
      expect(store.load()).toMatchObject({ user: { id: 'u1' }, accessToken: 'u1-access-2', refreshToken: 'u1-refresh-2' });
    });

    it('a refused refresh fails both as an expired sign-in, not as an account change, and sends nothing', async () => {
      const store = start('expired');
      const srv = rotatingServer({ refreshStatus: 401 });
      const [a, b] = two(store);
      const done = [a.listConversations(), b.recordRunSpend(spend)].map((p) => p.catch((e: unknown) => e));
      await srv.refreshSeen();
      await srv.releaseAll();
      for (const err of await Promise.all(done)) {
        expect(err).toBeInstanceOf(Error);
        expect(isAccountChangedError(err)).toBe(false);
        expect((err as Error).message).toMatch(/session expired/i);
      }
      expect(srv.refreshCount()).toBe(1);
      expect(sends(srv.calls)).toEqual([]);
      expect(store.load()).toBeNull();
    });

    it.each([
      ['another account signs in', (): CloudSession => session('u2')],
      ['the same account signs in again', (): CloudSession => ({ ...session('u1'), accessToken: 'u1-again', refreshToken: 'u1-refresh-again' })],
    ] as Array<[string, () => CloudSession]>)('when %s during the shared refresh, neither client sends and the newer sign-in stays', async (_what, next) => {
      const store = start('expired');
      const srv = rotatingServer();
      const [a, b] = two(store);
      const done = [a.recordRunSpend(spend), b.appendTurn('c1', { userContent: 'u1 prompt', assistant: { content: 'r' } } as never)]
        .map((p) => p.catch((e: unknown) => e));
      await srv.refreshSeen();
      const newer = next();
      store.set(newer);
      await srv.releaseAll();
      for (const err of await Promise.all(done)) expect(err).toBeInstanceOf(CloudAccountChangedError);
      expect(sends(srv.calls)).toEqual([]);
      expect(store.load()).toEqual(newer);
    });

    it('an opt-out kept during the shared refresh stops both clients\' requests', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-gate-'));
      try {
        const consent = fileSyncConsent(path.join(dir, 'cloud-sync.json'));
        consent.adoptLegacy(false);
        const store = start('expired');
        const srv = rotatingServer();
        const [a, b] = two(store, sendGate(() => consent.allowed()));
        const done = [a.recordRunSpend(spend), b.createConversation('t')].map((p) => p.catch((e: unknown) => e));
        await srv.refreshSeen();
        consent.setOptedOut(true);
        await srv.releaseAll();
        for (const err of await Promise.all(done)) expect(err).toBeInstanceOf(SyncOffError);
        expect(sends(srv.calls)).toEqual([]);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('a run report sent while another request refreshes is delivered once and only then confirmed', async () => {
      const store = start('expired');
      const srv = rotatingServer();
      const [other, mine] = two(store);
      // The run mirror's bridge, answering as the desktop's IPC handler does.
      const api = {
        status: async () => ({ signedIn: true, user: { id: 'u1' }, serverUrl: 'https://cloud' }),
        recordRunSpend: async (run: Parameters<CloudClient['recordRunSpend']>[0]) => {
          try { return { ok: true, ...(await mine.recordRunSpend(run)) }; }
          catch (err) { return isAccountChangedError(err) ? { ok: false, accountChanged: true } : { ok: false, error: (err as Error).message }; }
        },
      };
      const mirror = new CloudMirror(() => api, () => false, { get: () => undefined, set: () => {}, delete: () => {} });
      const confirmed: string[] = [];
      const listing = other.listConversations();
      const report = mirrorAndConfirm(mirror, {
        id: 'run-0001', sessionId: 's1', outcome: 'stopped', prompt: 'q', output: '', copyTurn: true, sync: true,
        cloud: { costUsd: 0.01, why: 'w' }, account: { userId: 'u1', serverUrl: 'https://cloud' },
      } as never, (id) => confirmed.push(id));
      await srv.refreshSeen();
      await srv.releaseAll();
      await expect(listing).resolves.toEqual([]);
      await expect(report).resolves.toBe('delivered');
      expect(srv.bodies.filter((x) => x.includes('run-0001'))).toHaveLength(1);
      expect(confirmed).toEqual(['run-0001']);
    });
  });

  describe('the sync opt-out, checked as each request leaves', () => {
    let dir: string;
    const consentFile = () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-gate-'));
      const c = fileSyncConsent(path.join(dir, 'cloud-sync.json'));
      c.adoptLegacy(false); // on, as a run ended
      return c;
    };
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

    it.each([
      ['appendTurn under a nearly expired token', 'expired' as const, (c: CloudClient) => c.appendTurn('c1', { userContent: 'u1 prompt', assistant: { content: 'r' } } as never)],
      ['appendTurn retried after a 401', 401 as const, (c: CloudClient) => c.appendTurn('c1', { userContent: 'u1 prompt', assistant: { content: 'r' } } as never)],
      ['createConversation retried after a 401', 401 as const, (c: CloudClient) => c.createConversation('u1 prompt')],
      ['recordRunSpend under a nearly expired token', 'expired' as const, (c: CloudClient) => c.recordRunSpend({ conversationId: null, outcome: 'answered', costUsd: 0.01, why: 'w' })],
    ])('%s: no request leaves after an opt-out kept while the refresh was out', async (_what, first, op) => {
      const consent = consentFile();
      const store = shared(first === 'expired' ? { ...session('u1'), accessExpiresAt: Date.now() - 1 } : session('u1'));
      const f = pausedRefresh(store, first);
      const client = new CloudClient('https://cloud', undefined, pinnedStore(store, 'u1'), { beforeSend: sendGate(() => consent.allowed()) });
      const done = op(client);
      await f.refreshStarted;
      const before = sends(f.calls).length;
      consent.setOptedOut(true);
      f.resolveRefresh();
      const err = await done.catch((e: unknown) => e);
      // Refused as sync-off (skipped, not retried), and nothing more was sent.
      expect(err).toBeInstanceOf(SyncOffError);
      expect(isSyncOffError(err)).toBe(true);
      expect(isAccountChangedError(err)).toBe(false);
      expect(sends(f.calls).length).toBe(before);
      expect(before).toBe(first === 401 ? 1 : 0);
    });

    it('lets requests through while syncing stays on, and treats a consent it cannot read as off', async () => {
      const consent = consentFile();
      const store = shared(session('u1'));
      const f = pausedRefresh(store, 401);
      const client = new CloudClient('https://cloud', undefined, pinnedStore(store, 'u1'), { beforeSend: sendGate(() => consent.allowed()) });
      const done = client.createConversation('t');
      await f.refreshStarted;
      f.resolveRefresh();
      await expect(done).resolves.toMatchObject({ id: 'c1' });
      expect(sends(f.calls).map((c) => c.auth)).toEqual(['Bearer u1-access', 'Bearer u1-access-2']);
      expect(() => sendGate(() => { throw new Error('io'); })()).toThrow(SyncOffError);
    });
  });
});
