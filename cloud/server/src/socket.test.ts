import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { attachSocket } from './socket.js';
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
});
