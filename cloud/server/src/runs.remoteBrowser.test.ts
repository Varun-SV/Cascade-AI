import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildCloudConfig, parseChatRunPayload, remoteBrowserControls, runChatTurn } from './runs.js';
import { CloudStore } from './db.js';
import { loadEnv } from './env.js';
import { sharedBrowserGeneration, resetSharedBrowser } from './remote-browser.js';
import { startStubOpenAIServer, type StubOpenAIServer } from './test-support/stub-openai-server.js';

class FakeSocket {
  events: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload: unknown): boolean { this.events.push({ event, payload }); return true; }
  on(): this { return this; }
  off(): this { return this; }
}

/** The operator's environment, minus whatever this test is varying. */
function baseEnv(dir: string): NodeJS.ProcessEnv {
  return {
    PORT: '8787',
    SESSION_SECRET: 'x'.repeat(20),
    DATA_DIR: dir,
    WEB_ORIGIN: 'http://localhost:5173',
    OAUTH_REDIRECT_BASE_URL: 'http://localhost:8787',
    MAX_COST_PER_RUN_USD: '1',
  };
}

// Everything here starts from `loadEnv` and ends at a controller actually being
// built, because that is the span the bug lived in.
//
// The capability shipped complete and inert: the provider adapters, the
// controller, the lease, the live view and the client panel all existed and
// were tested, and `attachRemoteBrowser` read `config.tools.remoteBrowser` —
// which nothing on the cloud side ever wrote. There was no env var, no field on
// `RunControls`, and no line in `buildCloudConfig`. Every test passed because
// every test handed `attachRemoteBrowser` a config it had built by hand.
//
// So a test that starts at the config is not enough to catch it a second time:
// the operator's environment is where a real deployment starts.
describe('the operator configures a browser for their deployment', () => {
  let dir = '';
  let store: CloudStore | undefined;
  let stub: StubOpenAIServer | undefined;

  afterEach(async () => {
    await resetSharedBrowser();
    store?.close();
    store = undefined;
    if (dir) {
      for (let i = 0; i < 4; i++) {
        try { await fs.rm(dir, { recursive: true, force: true }); break; }
        catch { await new Promise((r) => setTimeout(r, 50)); }
      }
    }
    await stub?.close();
    stub = undefined;
  });

  it('carries REMOTE_BROWSER_* from the environment into the run config', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rb-env-'));
    const env = loadEnv({
      ...baseEnv(dir),
      REMOTE_BROWSER_PROVIDER: 'cdp',
      REMOTE_BROWSER_URL: 'ws://browserless.internal:3000',
      REMOTE_BROWSER_MAX_SESSIONS: '3',
    });

    // THE mapping the run path performs, not a restatement of it. Rebuilding
    // the controls object here was the bug in this test: dropping `apiKey` or
    // `maxSessions` from the real mapping would have changed nothing it could
    // see, because it never called the real mapping at all.
    const config = buildCloudConfig([], env.MAX_COST_PER_RUN_USD, remoteBrowserControls(env));

    expect(config.tools?.remoteBrowser).toEqual({
      provider: 'cdp',
      url: 'ws://browserless.internal:3000',
      maxSessions: 3,
    });
  });

  it('leaves the config untouched when the operator configured nothing', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rb-off-'));
    const env = loadEnv(baseEnv(dir));
    expect(env.REMOTE_BROWSER_PROVIDER).toBeUndefined();

    const config = buildCloudConfig([], env.MAX_COST_PER_RUN_USD, remoteBrowserControls(env));

    // Not "present but disabled" — absent. `setRemoteBrowserController` gates on
    // the field, so the tool is never registered and the model never sees it.
    expect(config.tools?.remoteBrowser).toBeUndefined();
  });

  it('builds the deployment browser during a real run, from env alone', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rb-run-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    stub = await startStubOpenAIServer();
    await resetSharedBrowser();

    const env = loadEnv({
      ...baseEnv(dir),
      REMOTE_BROWSER_PROVIDER: 'cdp',
      // Never dialled: a CDP session is opened on the first browser ACTION, and
      // small talk takes none. What is under test is that the run reaches the
      // point of having a browser configured at all.
      REMOTE_BROWSER_URL: 'ws://127.0.0.1:9/devtools/browser/test',
    });
    const user = store.upsertUser({ provider: 'dev', providerId: 'tester', email: null, name: 'Tester', avatar: null });

    const before = sharedBrowserGeneration();
    const payload = parseChatRunPayload({
      prompt: 'hello',
      providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }],
    });
    const result = await runChatTurn(payload, {
      env, store, userId: user.id,
      socket: new FakeSocket() as unknown as import('socket.io').Socket,
    });

    expect(result.output).toContain('Hello from the stub model.');
    // A controller was built for this deployment. Asserting the run merely
    // succeeded would pass either way — it did before, with the feature inert.
    expect(sharedBrowserGeneration()).toBe(before + 1);
  }, 30_000);

  it('builds nothing when the operator configured no provider', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-rb-run-off-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    stub = await startStubOpenAIServer();
    await resetSharedBrowser();

    const env = loadEnv(baseEnv(dir));
    const user = store.upsertUser({ provider: 'dev', providerId: 'tester', email: null, name: 'Tester', avatar: null });

    const before = sharedBrowserGeneration();
    await runChatTurn(
      parseChatRunPayload({
        prompt: 'hello',
        providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }],
      }),
      { env, store, userId: user.id, socket: new FakeSocket() as unknown as import('socket.io').Socket },
    );

    expect(sharedBrowserGeneration()).toBe(before);
  }, 30_000);

  it('ignores a browser endpoint supplied by the caller', async () => {
    // The endpoint is a URL the SERVER opens a connection to. Accepting it from
    // a request body would let any signed-in user aim that connection at the
    // deployment's own network — the SSRF this whole design exists to avoid.
    // It is operator config or it is nothing.
    const payload = parseChatRunPayload({
      prompt: 'hi',
      providers: [{ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' }],
      remoteBrowser: { provider: 'cdp', url: 'ws://169.254.169.254/' },
      tools: { remoteBrowser: { provider: 'cdp', url: 'ws://169.254.169.254/' } },
    } as Record<string, unknown>);

    expect((payload as Record<string, unknown>).remoteBrowser).toBeUndefined();
    expect((payload as Record<string, unknown>).tools).toBeUndefined();
  });
});

// Every field, not just the two the end-to-end test happens to exercise. That
// one asserts a controller was built, which is true as soon as provider+url
// arrive — so a dropped `apiKey` or `maxSessions` line would sail past it.
describe('every REMOTE_BROWSER_* value reaches the run config', () => {
  it('carries the credential and the session cap, not only the endpoint', () => {
    const env = loadEnv({
      ...baseEnv('/tmp'),
      REMOTE_BROWSER_PROVIDER: 'steel',
      REMOTE_BROWSER_URL: 'https://api.steel.example',
      REMOTE_BROWSER_API_KEY: 'sk-operator-key',
      REMOTE_BROWSER_MAX_SESSIONS: '4',
    });

    expect(buildCloudConfig([], 1, remoteBrowserControls(env)).tools?.remoteBrowser).toEqual({
      provider: 'steel',
      url: 'https://api.steel.example',
      apiKey: 'sk-operator-key',
      maxSessions: 4,
    });
  });

  it('omits what the operator did not set, rather than sending empty strings', () => {
    // A blank `url` reaching a provider is worse than an absent one: the CDP
    // adapter refuses an unparseable endpoint by name, while Steel would fall
    // back to its default API base only if the field is genuinely missing.
    const env = loadEnv({
      ...baseEnv('/tmp'),
      REMOTE_BROWSER_PROVIDER: 'steel',
    });

    expect(buildCloudConfig([], 1, remoteBrowserControls(env)).tools?.remoteBrowser).toEqual({
      provider: 'steel',
      maxSessions: 1,
    });
  });
});
