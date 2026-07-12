import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ToolRegistry } from '#cascade-ai';
import { buildCloudConfig, parseChatRunPayload, runChatTurn, tenantScratchDir } from './runs.js';
import { CloudStore } from './db.js';
import type { CloudEnv } from './env.js';
import { startStubOpenAIServer, type StubOpenAIServer } from './test-support/stub-openai-server.js';

class FakeSocket {
  events: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload: unknown): boolean {
    this.events.push({ event, payload });
    return true;
  }
}

describe('buildCloudConfig', () => {
  it('never enables shell/file/git — only web_search and web_fetch', () => {
    const config = buildCloudConfig([], 0.5);
    const registry = new ToolRegistry(config.tools as ConstructorParameters<typeof ToolRegistry>[0], '/tmp');
    expect(registry.hasTool('web_search')).toBe(true);
    expect(registry.hasTool('web_fetch')).toBe(true);
    for (const name of ['shell', 'file_read', 'file_write', 'file_edit', 'file_delete', 'git', 'github', 'run_code']) {
      expect(registry.hasTool(name), name).toBe(false);
    }
  });

  it('disables telemetry and fact extraction, and passes the cost cap through', () => {
    const config = buildCloudConfig([], 1.23);
    expect(config.telemetry?.enabled).toBe(false);
    expect(config.knowledge?.factsExtraction).toBe(false);
    expect(config.budget?.maxCostPerRunUsd).toBe(1.23);
  });
});

describe('tenantScratchDir', () => {
  it('scopes each user to their own subdirectory under DATA_DIR', () => {
    const env = { DATA_DIR: '/data' } as CloudEnv;
    expect(tenantScratchDir(env, 'alice')).toBe(path.resolve('/data', 'tenants', 'alice'));
    expect(tenantScratchDir(env, 'alice')).not.toBe(tenantScratchDir(env, 'bob'));
  });
});

describe('parseChatRunPayload', () => {
  it('rejects an empty providers array', () => {
    expect(() => parseChatRunPayload({ prompt: 'hi', providers: [] })).toThrow();
  });

  it('rejects an unknown provider type', () => {
    expect(() => parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'not-a-real-provider' }] })).toThrow();
  });

  it('accepts a minimal valid payload', () => {
    const parsed = parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }] });
    expect(parsed.prompt).toBe('hi');
  });

  it('normalizes blank optional provider fields to undefined, not empty strings', () => {
    // A KeyVault form left blank submits '' — some provider SDKs (e.g.
    // `new OpenAI({ apiKey: '' })`) throw on a defined-but-empty key where
    // they'd fall back gracefully on a genuinely absent one, so '' must
    // never reach createCascade as-is.
    const parsed = parseChatRunPayload({
      prompt: 'hi',
      providers: [{ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: '' }],
    });
    expect(parsed.providers[0]!.apiKey).toBeUndefined();
    expect(parsed.providers[0]!.model).toBeUndefined();
    expect(parsed.providers[0]!.baseUrl).toBe('http://127.0.0.1:1/v1');
  });
});

describe('runChatTurn (stub-provider integration)', () => {
  let dir: string;
  let store: CloudStore | undefined;
  let stub: StubOpenAIServer | undefined;

  afterEach(async () => {
    store?.close();
    store = undefined;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    await stub?.close();
    stub = undefined;
  });

  it('runs a full turn against a local OpenAI-compatible stub and persists the transcript', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-runs-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    stub = await startStubOpenAIServer();

    const env: CloudEnv = {
      PORT: 0,
      SESSION_SECRET: 'x'.repeat(20),
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
    const user = store.upsertUser({ provider: 'dev', providerId: 'tester', email: null, name: 'Tester', avatar: null });
    const socket = new FakeSocket();

    // "hello" hits Cascade's casual-greeting heuristic and routes straight to
    // T3 with no classifier call — keeps this test to a single stub round trip.
    const payload = parseChatRunPayload({
      prompt: 'hello',
      providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }],
    });

    const result = await runChatTurn(payload, { env, store, userId: user.id, socket: socket as unknown as import('socket.io').Socket });

    expect(result.conversationId).toBeTruthy();
    expect(result.output).toContain('Hello from the stub model.');

    const messages = store.getMessages(result.conversationId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.content).toBe('hello');
    expect(messages[1]!.content).toContain('Hello from the stub model.');

    expect(socket.events.some((e) => e.event === 'session:complete')).toBe(true);
    expect(socket.events.some((e) => e.event === 'session:error')).toBe(false);
    expect(socket.events.some((e) => e.event === 'stream:token')).toBe(true);

    // The stub server is the only place a key/prompt could have leaked to —
    // confirms the run actually went through the real provider HTTP client.
    expect(stub.requestLog.some((r) => r.includes('models'))).toBe(true);
    expect(stub.requestLog.some((r) => r.includes('chat/completions'))).toBe(true);
  }, 30_000);

  it('runs successfully when apiKey and model are left blank (KeyVault "optional" fields)', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-runs-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    stub = await startStubOpenAIServer();

    const env = { DATA_DIR: dir, MAX_COST_PER_RUN_USD: 1 } as CloudEnv;
    const user = store.upsertUser({ provider: 'dev', providerId: 'blank-fields', email: null, name: 'Blank', avatar: null });
    const socket = new FakeSocket();

    // Mirrors exactly what KeyVault used to send before it stopped
    // persisting empty strings: apiKey/model submitted as '' rather than
    // omitted, which made discovery throw and left T3 with no model.
    const payload = parseChatRunPayload({
      prompt: 'hello',
      providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: '', model: '' }],
    });

    const result = await runChatTurn(payload, { env, store, userId: user.id, socket: socket as unknown as import('socket.io').Socket });
    expect(result.output).toContain('Hello from the stub model.');
  }, 30_000);

  it('rejects a conversationId that does not belong to the caller', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-runs-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    const env = { DATA_DIR: dir, MAX_COST_PER_RUN_USD: 1 } as CloudEnv;

    const alice = store.upsertUser({ provider: 'dev', providerId: 'alice', email: null, name: 'Alice', avatar: null });
    const bob = store.upsertUser({ provider: 'dev', providerId: 'bob', email: null, name: 'Bob', avatar: null });
    const aliceConvo = store.createConversation(alice.id);

    const payload = parseChatRunPayload({
      conversationId: aliceConvo.id,
      prompt: 'hello',
      providers: [{ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }],
    });

    await expect(
      runChatTurn(payload, { env, store, userId: bob.id, socket: new FakeSocket() as unknown as import('socket.io').Socket }),
    ).rejects.toThrow(/Conversation not found/);
  });

  it('blocks a run once the daily limit is hit, without creating a conversation or a stray message', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-runs-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    const env = { DATA_DIR: dir, MAX_COST_PER_RUN_USD: 1 } as CloudEnv;
    const user = store.upsertUser({ provider: 'dev', providerId: 'quota-user', email: null, name: null, avatar: null });

    // free plan's daily cap — see entitlements.ts.
    for (let i = 0; i < 20; i++) store.incrementUsage(user.id, new Date().toISOString().slice(0, 10));

    const payload = parseChatRunPayload({
      prompt: 'hello',
      providers: [{ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }],
    });

    await expect(
      runChatTurn(payload, { env, store, userId: user.id, socket: new FakeSocket() as unknown as import('socket.io').Socket }),
    ).rejects.toThrow(/Daily run limit reached/);

    expect(store.listConversations(user.id)).toEqual([]);
  });
});
