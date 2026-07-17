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
