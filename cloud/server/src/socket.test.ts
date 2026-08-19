import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { attachSocket, RebindableTransport } from './socket.js';
import { CloudStore } from './db.js';
import type { CloudEnv } from './env.js';
import { createSessionToken, SESSION_COOKIE_NAME } from './auth/session.js';
import { startStubOpenAIServer, type StubOpenAIServer } from './test-support/stub-openai-server.js';

describe('attachSocket', () => {
  let dir: string;
  let store: CloudStore;
  let httpServer: http.Server;
  let baseUrl: string;
  let env: CloudEnv;
  let stub: StubOpenAIServer | undefined;
  const clients: ClientSocket[] = [];

  function connect(cookie?: string): ClientSocket {
    const client = ioClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: cookie ? { Cookie: cookie } : undefined,
    });
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-socket-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    env = {
      PORT: 0,
      SESSION_SECRET: 'socket-test-secret-value',
      DATA_DIR: dir,
      WEB_ORIGIN: 'http://localhost:5173',
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:8787',
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      CLOUD_DEV_BYPASS: false,
      MAX_COST_PER_RUN_USD: 1,
    };
    httpServer = http.createServer();
    attachSocket(httpServer, env, store);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    store.close();
    await new Promise((resolve) => httpServer.close(resolve));
    // The SDK's fire-and-forget perf/benchmark saves may still be flushing into
    // DATA_DIR as we tear down — retry the cleanup to dodge the ENOTEMPTY race.
    for (let i = 0; i < 4; i++) {
      try { await fs.rm(dir, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    await stub?.close();
    stub = undefined;
  });

  it('rejects a connection with no session cookie', async () => {
    const client = connect();
    const err = await new Promise<Error>((resolve) => client.on('connect_error', resolve));
    expect(err.message).toMatch(/unauthorized/);
  });

  it('rejects a connection with a forged/invalid session cookie', async () => {
    const client = connect(`${SESSION_COOKIE_NAME}=not-a-real-token`);
    const err = await new Promise<Error>((resolve) => client.on('connect_error', resolve));
    expect(err.message).toMatch(/unauthorized/);
  });

  it('authenticates via the session cookie and error-acks an invalid chat:run payload', async () => {
    const user = store.upsertUser({ provider: 'dev', providerId: 'sock', email: null, name: 'Sock', avatar: null });
    const token = createSessionToken({ userId: user.id }, env.SESSION_SECRET);
    const client = connect(`${SESSION_COOKIE_NAME}=${token}`);
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });

    const ack = await new Promise<{ error?: string }>((resolve) => {
      client.emit('chat:run', { prompt: '', providers: [] }, resolve);
    });
    expect(ack.error).toBeTruthy();
  });

  it('runs a real chat:run against the stub provider and acks the result', async () => {
    stub = await startStubOpenAIServer();
    const user = store.upsertUser({ provider: 'dev', providerId: 'sock-run', email: null, name: 'Runner', avatar: null });
    const token = createSessionToken({ userId: user.id }, env.SESSION_SECRET);
    const client = connect(`${SESSION_COOKIE_NAME}=${token}`);
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });

    const streamEvents: unknown[] = [];
    client.on('stream:token', (e) => streamEvents.push(e));

    const ack = await new Promise<{ conversationId?: string; output?: string; error?: string }>((resolve) => {
      client.emit(
        'chat:run',
        { prompt: 'hello', providers: [{ type: 'openai-compatible', baseUrl: stub!.url, apiKey: 'test-key', model: 'stub-model' }] },
        resolve,
      );
    });

    expect(ack.error).toBeUndefined();
    expect(ack.output).toContain('Hello from the stub model.');
    expect(streamEvents.length).toBeGreaterThan(0);
  }, 30_000);

  it('rejects an overlapping chat:run on the same connection', async () => {
    stub = await startStubOpenAIServer();
    const user = store.upsertUser({ provider: 'dev', providerId: 'sock-overlap', email: null, name: 'Overlap', avatar: null });
    const token = createSessionToken({ userId: user.id }, env.SESSION_SECRET);
    const client = connect(`${SESSION_COOKIE_NAME}=${token}`);
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });

    const payload = { prompt: 'hello', providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }] };

    // Fire both without awaiting the first — checkDailyLimit/beginRun
    // (entitlements.ts) run synchronously before Cascade's first `await`,
    // so the second call reliably observes the per-user concurrency guard
    // regardless of timing.
    const firstAck = new Promise((resolve) => client.emit('chat:run', payload, resolve));
    const secondAck = await new Promise<{ error?: string }>((resolve) => client.emit('chat:run', payload, resolve));

    expect(secondAck.error).toMatch(/run\(s\) in progress/);
    await firstAck;
  }, 30_000);
});

describe('attachSocket — a dropped connection does not kill the run', () => {
  // Reported symptom: "I tried stopping it myself, navigating outside the page,
  // and leaving it to run, and in all three cases the response just died."
  // Only the first of those is a cancellation. `disconnect` also fires on a
  // missed heartbeat and on a proxy idle-timeout, and it aborted the run
  // outright — so a run that took longer than one network hiccup could not
  // finish, however healthy it was. The client reconnects, but as a NEW socket,
  // so nothing revived the run.
  let dir: string;
  let store: CloudStore;
  let httpServer: http.Server;
  let baseUrl: string;
  let env: CloudEnv;
  let stub: StubOpenAIServer | undefined;
  const clients: ClientSocket[] = [];

  async function start(graceMs: number): Promise<void> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-grace-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    env = {
      PORT: 0,
      SESSION_SECRET: 'socket-grace-secret-value',
      DATA_DIR: dir,
      WEB_ORIGIN: 'http://localhost:5173',
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:8787',
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      CLOUD_DEV_BYPASS: false,
      MAX_COST_PER_RUN_USD: 1,
    };
    httpServer = http.createServer();
    attachSocket(httpServer, env, store, { reconnectGraceMs: graceMs });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  }

  function connect(cookie: string): ClientSocket {
    const client = ioClient(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Cookie: cookie },
    });
    clients.push(client);
    return client;
  }

  const connected = (c: ClientSocket) =>
    new Promise<void>((resolve, reject) => { c.on('connect', () => resolve()); c.on('connect_error', reject); });

  /** The persisted assistant reply for a conversation, or '' if there is none. */
  function assistantReply(conversationId: string): string {
    const rows = store.getMessages(conversationId) as Array<{ role: string; content: string }>;
    return rows.filter((r) => r.role === 'assistant').map((r) => r.content).join('');
  }

  /** Poll until `predicate` holds or the budget runs out. */
  async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    store.close();
    await new Promise((resolve) => httpServer.close(resolve));
    for (let i = 0; i < 4; i++) {
      try { await fs.rm(dir, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    await stub?.close();
    stub = undefined;
  });

  it('finishes and persists a run whose socket dropped and came back', async () => {
    await start(5_000);
    stub = await startStubOpenAIServer({ delayMs: 1_200 });
    const user = store.upsertUser({ provider: 'dev', providerId: 'grace-ok', email: null, name: 'Grace', avatar: null });
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({ userId: user.id }, env.SESSION_SECRET)}`;

    const first = connect(cookie);
    await connected(first);

    let conversationId = '';
    first.emit(
      'chat:run',
      { prompt: 'hello', providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }] },
      (ack: { conversationId?: string }) => { conversationId = ack?.conversationId ?? ''; },
    );

    // Drop the connection while the provider is still streaming — the blip.
    await new Promise((r) => setTimeout(r, 300));
    first.close();

    // The client comes back, as Socket.IO's own reconnection does: a new socket.
    await new Promise((r) => setTimeout(r, 100));
    await connected(connect(cookie));

    // The run must still land. Its events went to the dead socket, but the
    // assistant message is persisted before any of them are emitted, so the
    // answer is on the conversation — which is what the reconnected client
    // re-reads.
    const conversations = store.listConversations(user.id) as Array<{ id: string }>;
    expect(conversations.length).toBe(1);
    const cid = conversationId || conversations[0]!.id;

    const landed = await until(() => assistantReply(cid).includes('Hello from the stub model.'), 15_000);
    expect(landed).toBe(true);
  }, 30_000);

  it('still abandons the run when nobody comes back', async () => {
    // The budget guarantee the original abort existed to provide. Holding a run
    // for a client that is genuinely gone would spend tokens nobody reads.
    await start(150);
    stub = await startStubOpenAIServer({ delayMs: 3_000 });
    const user = store.upsertUser({ provider: 'dev', providerId: 'grace-gone', email: null, name: 'Gone', avatar: null });
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({ userId: user.id }, env.SESSION_SECRET)}`;

    const only = connect(cookie);
    await connected(only);
    only.emit(
      'chat:run',
      { prompt: 'hello', providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }] },
      () => { /* the ack cannot arrive: this socket is about to go */ },
    );

    await new Promise((r) => setTimeout(r, 300));
    only.close();

    // Past the grace window with no reconnect, the run is aborted, so the
    // stub's full reply never makes it into the transcript.
    await new Promise((r) => setTimeout(r, 1_500));
    const conversations = store.listConversations(user.id) as Array<{ id: string }>;
    const reply = conversations.length ? assistantReply(conversations[0]!.id) : '';
    expect(reply).not.toContain('Hello from the stub model.');
  }, 30_000);

  it('lets the socket that replaced the original stop the run it inherited', async () => {
    // Holding the run across a blip is only half of it: the replacement socket
    // has to OWN it. Clearing the grace timer without moving the controllers
    // into the new connection's activeRuns left `chat:stop` with nothing to
    // abort, so the user's Stop button silently did nothing for the rest of
    // that run.
    await start(8_000);
    stub = await startStubOpenAIServer({ delayMs: 3_000 });
    const user = store.upsertUser({ provider: 'dev', providerId: 'grace-stop', email: null, name: 'Stop', avatar: null });
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({ userId: user.id }, env.SESSION_SECRET)}`;

    const first = connect(cookie);
    await connected(first);
    first.emit(
      'chat:run',
      { prompt: 'hello', providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }] },
      () => { /* bound to a socket that is about to go */ },
    );

    await new Promise((r) => setTimeout(r, 300));
    first.close();
    await new Promise((r) => setTimeout(r, 100));

    const second = connect(cookie);
    await connected(second);
    second.emit('chat:stop');

    // Past the stub's delay: a run that was genuinely stopped never gets the
    // reply written, and one the Stop missed does.
    await new Promise((r) => setTimeout(r, 3_500));
    const conversations = store.listConversations(user.id) as Array<{ id: string }>;
    const reply = conversations.length ? assistantReply(conversations[0]!.id) : '';
    expect(reply).not.toContain('Hello from the stub model.');
  }, 30_000);

  it('re-arms the grace window when the replacement socket drops too', async () => {
    // The worse half of the same defect. A second disconnect saw an empty
    // activeRuns, returned early, and started NO timer — so a run that
    // survived one blip could then spend without any remaining way to stop it,
    // which is the exact guarantee the grace window was bounded to preserve.
    await start(800);
    stub = await startStubOpenAIServer({ delayMs: 3_000 });
    const user = store.upsertUser({ provider: 'dev', providerId: 'grace-again', email: null, name: 'Again', avatar: null });
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({ userId: user.id }, env.SESSION_SECRET)}`;

    const first = connect(cookie);
    await connected(first);
    first.emit(
      'chat:run',
      { prompt: 'hello', providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }] },
      () => { /* never arrives */ },
    );

    await new Promise((r) => setTimeout(r, 300));
    first.close();
    await new Promise((r) => setTimeout(r, 100));

    // Comes back — adopting the run — and then goes away for good.
    const second = connect(cookie);
    await connected(second);
    await new Promise((r) => setTimeout(r, 100));
    second.close();

    // Well past both the re-armed grace window and the stub's delay.
    await new Promise((r) => setTimeout(r, 3_800));
    const conversations = store.listConversations(user.id) as Array<{ id: string }>;
    const reply = conversations.length ? assistantReply(conversations[0]!.id) : '';
    expect(reply).not.toContain('Hello from the stub model.');
  }, 30_000);

  it('reports the inherited run and finishes it on the replacement socket', async () => {
    // The reconnect case that a one-shot transcript reload cannot cover: the
    // client comes back BEFORE the run ends. Every later emit — and the
    // terminal `session:complete` — was still addressed to the dead socket, so
    // the new page waited forever on a run that was talking to nobody. The ack
    // genuinely cannot be re-routed (it belongs to the original emit), which is
    // why `run:resumed` has to tell the client whether to keep waiting at all.
    await start(8_000);
    stub = await startStubOpenAIServer({ delayMs: 2_000 });
    const user = store.upsertUser({ provider: 'dev', providerId: 'grace-resume', email: null, name: 'Resume', avatar: null });
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({ userId: user.id }, env.SESSION_SECRET)}`;

    const first = connect(cookie);
    await connected(first);
    first.emit(
      'chat:run',
      { prompt: 'hello', providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }] },
      () => { /* bound to the socket that goes away */ },
    );

    await new Promise((r) => setTimeout(r, 300));
    first.close();
    await new Promise((r) => setTimeout(r, 100));

    const second = connect(cookie);
    const resumed: Array<{ active?: number }> = [];
    let completed = false;
    second.on('run:resumed', (e: { active?: number }) => { resumed.push(e); });
    second.on('session:complete', () => { completed = true; });
    await connected(second);

    const finished = await until(() => completed, 12_000);
    expect(finished).toBe(true);
    // And it was told to keep waiting rather than to give up.
    expect(resumed.at(-1)?.active).toBe(1);
  }, 30_000);

  it('tells a fresh connection there is nothing to wait for', async () => {
    // The other half of the same signal. A client that reconnects after its
    // run already finished must be able to stop showing a spinner, and this is
    // the only thing that says so — its ack died with the old socket.
    await start(8_000);
    const user = store.upsertUser({ provider: 'dev', providerId: 'grace-idle', email: null, name: 'Idle', avatar: null });
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({ userId: user.id }, env.SESSION_SECRET)}`;

    const client = connect(cookie);
    const seen: Array<{ active?: number }> = [];
    client.on('run:resumed', (e: { active?: number }) => { seen.push(e); });
    await connected(client);

    const arrived = await until(() => seen.length > 0, 5_000);
    expect(arrived).toBe(true);
    expect(seen[0]?.active).toBe(0);
  }, 20_000);
});

describe('RebindableTransport', () => {
  /** The two methods of Socket the transport actually drives, recorded. */
  function fakeSocket() {
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    return {
      emitted,
      handlerCount: (event: string) => handlers.get(event)?.size ?? 0,
      fire: (event: string, arg: unknown) => { for (const h of handlers.get(event) ?? []) h(arg); },
      socket: {
        emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); return true; },
        on: (event: string, listener: (...args: unknown[]) => void) => {
          let set = handlers.get(event);
          if (!set) { set = new Set(); handlers.set(event, set); }
          set.add(listener);
          return undefined;
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
          handlers.get(event)?.delete(listener);
          return undefined;
        },
      },
    };
  }

  it('moves emits and listeners to the replacement connection', () => {
    // The interactive gates are the reason listeners have to move, not just
    // emits: `context:decision` and `escalation:decide` are answers only the
    // page the user is LOOKING AT can give, and the run parks until one
    // arrives. Left on the dead socket, that answer had nowhere to land.
    const a = fakeSocket();
    const b = fakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new RebindableTransport(a.socket as any);

    const answers: unknown[] = [];
    const onDecision = (arg: unknown) => { answers.push(arg); };
    transport.on('escalation:decide', onDecision);
    transport.emit('tier:status', { tier: 'T2' });
    expect(a.emitted).toEqual([{ event: 'tier:status', payload: { tier: 'T2' } }]);
    expect(a.handlerCount('escalation:decide')).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport.rebind(b.socket as any);

    // The old connection is fully released — no stale listener, no more emits.
    expect(a.handlerCount('escalation:decide')).toBe(0);
    expect(b.handlerCount('escalation:decide')).toBe(1);
    transport.emit('session:complete', { ok: true });
    expect(a.emitted).toHaveLength(1);
    expect(b.emitted).toEqual([{ event: 'session:complete', payload: { ok: true } }]);

    // And the answer the run is waiting on now arrives from the live page.
    b.fire('escalation:decide', { approved: true });
    expect(answers).toEqual([{ approved: true }]);
  });

  it('drops emits while nothing is connected, and resumes on rebind', () => {
    const a = fakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new RebindableTransport(a.socket as any);
    const onDecision = () => {};
    transport.on('context:decision', onDecision);

    transport.rebind(null);
    expect(a.handlerCount('context:decision')).toBe(0);
    // Safe because runChatTurn persists the assistant message before it emits
    // anything — a dropped event never costs the answer.
    expect(() => transport.emit('stream:token', { token: 'x' })).not.toThrow();
    expect(a.emitted).toHaveLength(0);

    const b = fakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport.rebind(b.socket as any);
    expect(b.handlerCount('context:decision')).toBe(1);
    transport.emit('stream:token', { token: 'y' });
    expect(b.emitted).toEqual([{ event: 'stream:token', payload: { token: 'y' } }]);
  });

  it('stops forwarding a listener that was removed', () => {
    const a = fakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = new RebindableTransport(a.socket as any);
    const seen: unknown[] = [];
    const listener = (arg: unknown) => { seen.push(arg); };
    transport.on('context:decision', listener);
    transport.off('context:decision', listener);

    const b = fakeSocket();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport.rebind(b.socket as any);
    // runChatTurn removes its listeners in a finally; a rebind after that must
    // not resurrect them on the next connection.
    expect(b.handlerCount('context:decision')).toBe(0);
    b.fire('context:decision', { approved: true });
    expect(seen).toEqual([]);
  });
});
