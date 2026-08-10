import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ToolRegistry } from '#cascade-ai';
import { buildCloudConfig, buildMediaSink, parseChatRunPayload, runChatTurn, tenantScratchDir } from './runs.js';
import { CloudStore } from './db.js';
import { limitsForPlan, PENDING_MEDIA_TTL_MS } from './entitlements.js';
import type { CloudEnv } from './env.js';
import { startStubOpenAIServer, type StubOpenAIServer } from './test-support/stub-openai-server.js';

class FakeSocket {
  events: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload: unknown): boolean {
    this.events.push({ event, payload });
    return true;
  }
  // The run pipeline listens for the client's extended-context decision on the
  // socket; the stub never sends one, so these are inert no-ops.
  on(): this { return this; }
  off(): this { return this; }
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

  it('always disables generate_document, which a hosted run cannot deliver', () => {
    // It registers OUTSIDE the enabledTools allowlist (that list guards tools
    // reaching the machine; this one only writes into the run's own workspace),
    // so a hosted run got it regardless — with an ephemeral per-tenant scratch
    // dir and no route serving a file out of it. Its mere presence also made
    // the worker REQUIRE a file artifact (ARTIFACT_TOOLS), so a subtask naming
    // "report.docx" wrote one nobody could fetch and then failed verification,
    // ending as "Worker stalled waiting for artifact creation. Requesting
    // dynamic tool generation from T2 Manager" — a failed node for work done.
    expect(buildCloudConfig([], 0.5).tools?.disabledTools).toContain('generate_document');
  });

  it("keeps the user's own deselections alongside it, without duplicating", () => {
    const config = buildCloudConfig([], 0.5, { disabledTools: ['web_fetch', 'generate_document'] });
    const denied = config.tools?.disabledTools ?? [];
    expect(denied).toContain('web_fetch');
    expect(denied.filter((t) => t === 'generate_document')).toHaveLength(1);
  });

  it('disables telemetry and fact extraction, and passes the cost cap through', () => {
    const config = buildCloudConfig([], 1.23);
    expect(config.telemetry?.enabled).toBe(false);
    expect(config.knowledge?.factsExtraction).toBe(false);
    expect(config.budget?.maxCostPerRunUsd).toBe(1.23);
  });

  it('accepts a client-supplied cost cap within bounds and rejects out-of-range values', () => {
    // A user-set cap flows through parse → buildCloudConfig.
    const ok = parseChatRunPayload({
      prompt: 'hi', maxCostPerRunUsd: 5,
      providers: [{ type: 'openai', apiKey: 'k' }],
    });
    expect(ok.maxCostPerRunUsd).toBe(5);
    expect(buildCloudConfig([], ok.maxCostPerRunUsd!).budget?.maxCostPerRunUsd).toBe(5);
    // Bounds: below the floor and above the ceiling are rejected.
    expect(() => parseChatRunPayload({ prompt: 'hi', maxCostPerRunUsd: 0.01, providers: [{ type: 'openai', apiKey: 'k' }] })).toThrow();
    expect(() => parseChatRunPayload({ prompt: 'hi', maxCostPerRunUsd: 999, providers: [{ type: 'openai', apiKey: 'k' }] })).toThrow();
  });

  it('registers NO tools when webSearch is off (pure chat)', () => {
    const config = buildCloudConfig([], 0.5, { webSearch: false });
    const registry = new ToolRegistry(config.tools as ConstructorParameters<typeof ToolRegistry>[0], '/tmp');
    expect(registry.hasTool('web_search')).toBe(false);
    expect(registry.hasTool('web_fetch')).toBe(false);
  });

  it('re-enables web tools when webSearch is explicitly on', () => {
    const config = buildCloudConfig([], 0.5, { webSearch: true });
    const registry = new ToolRegistry(config.tools as ConstructorParameters<typeof ToolRegistry>[0], '/tmp');
    expect(registry.hasTool('web_search')).toBe(true);
    expect(registry.hasTool('web_fetch')).toBe(true);
  });

  it('passes a configured web-search backend through only when web search is on', () => {
    const backend = { braveApiKey: 'brave-key' };
    // On + configured → webSearch config is set.
    expect(buildCloudConfig([], 0.5, { webSearch: true, webSearchConfig: backend }).webSearch).toEqual({
      searxngUrl: undefined,
      braveApiKey: 'brave-key',
      tavilyApiKey: undefined,
    });
    // On but no backend configured → left unset (tool uses keyless fallback).
    expect(buildCloudConfig([], 0.5, { webSearch: true }).webSearch).toBeUndefined();
    expect(buildCloudConfig([], 0.5, { webSearch: true, webSearchConfig: {} }).webSearch).toBeUndefined();
    // Web search off → never pass a backend, even if configured.
    expect(buildCloudConfig([], 0.5, { webSearch: false, webSearchConfig: backend }).webSearch).toBeUndefined();
  });

  it('maps routing mode to Cascade Auto bias and pins the forced tier', () => {
    expect(buildCloudConfig([], 0.5, { routingMode: 'quality' }).autoBias).toBe('quality');
    expect(buildCloudConfig([], 0.5, { routingMode: 'fast' }).autoBias).toBe('cost');
    expect(buildCloudConfig([], 0.5, { routingMode: 'auto' }).autoBias).toBe('balanced');
    // Cascade Auto stays ON for every mode — the bias just tunes quality↔cost.
    expect(buildCloudConfig([], 0.5, { routingMode: 'fast' }).cascadeAuto).toBe(true);
    expect(buildCloudConfig([], 0.5, { forceTier: 'T2' }).routing?.forceTier).toBe('T2');
    expect(buildCloudConfig([], 0.5).routing?.forceTier).toBe('auto');
  });

  it('maps per-tier params to tierLimits, omitting unset knobs', () => {
    const cfg = buildCloudConfig([], 0.5, {
      tierParams: { t1: { maxTokens: 1000 }, t2: { temperature: 0.7 }, t3: { maxTokens: 512, temperature: 0.2 } },
    });
    expect(cfg.tierLimits).toEqual({
      t1MaxTokens: 1000,
      t2Temperature: 0.7,
      t3MaxTokens: 512,
      t3Temperature: 0.2,
    });
    // No tierParams at all → tierLimits stays unset (SDK defaults apply).
    expect(buildCloudConfig([], 0.5).tierLimits).toBeUndefined();
    // An empty tierParams object contributes nothing.
    expect(buildCloudConfig([], 0.5, { tierParams: {} }).tierLimits).toBeUndefined();
  });

  it('maps extended context only when enabled, defaulting the multiplier', () => {
    expect(buildCloudConfig([], 0.5).extendedContext).toBeUndefined();
    expect(buildCloudConfig([], 0.5, { extendedContext: { enabled: false } }).extendedContext).toBeUndefined();
    expect(buildCloudConfig([], 0.5, { extendedContext: { enabled: true } }).extendedContext).toEqual({
      enabled: true, maxMultiplier: 2,
    });
    expect(buildCloudConfig([], 0.5, { extendedContext: { enabled: true, maxMultiplier: 3 } }).extendedContext).toEqual({
      enabled: true, maxMultiplier: 3,
    });
  });

  it('wires the shared learning stats path and opt-out into routing', () => {
    const cfg = buildCloudConfig([], 0.5, { perfStatsPath: '/data/model-perf.json' });
    expect(cfg.routing?.perfStatsPath).toBe('/data/model-perf.json');
    // Default (contribute): learnFromOutcomes stays unset so the SDK default (true) applies.
    expect(cfg.routing?.learnFromOutcomes).toBeUndefined();
    // Only an explicit opt-out flows through as false.
    expect(buildCloudConfig([], 0.5, { learnFromOutcomes: false }).routing?.learnFromOutcomes).toBe(false);
    expect(buildCloudConfig([], 0.5, { learnFromOutcomes: true }).routing?.learnFromOutcomes).toBeUndefined();
  });

  it('points the live-benchmark cache at the given path when set', () => {
    expect(buildCloudConfig([], 0.5).benchmarks).toBeUndefined();
    expect(buildCloudConfig([], 0.5, { benchmarksCacheFile: '/data/benchmarks-cache.json' }).benchmarks)
      .toEqual({ cacheFile: '/data/benchmarks-cache.json' });
  });

  it('passes a max-tokens-per-run ceiling into the budget, keeping the cost cap', () => {
    expect(buildCloudConfig([], 0.5).budget?.maxTokensPerRun).toBeUndefined();
    const cfg = buildCloudConfig([], 0.5, { maxTokensPerRun: 500_000 });
    expect(cfg.budget?.maxTokensPerRun).toBe(500_000);
    expect(cfg.budget?.maxCostPerRunUsd).toBe(0.5);
  });
});

describe('tenantScratchDir', () => {
  it('scopes each user to their own subdirectory under DATA_DIR', () => {
    const env = { DATA_DIR: '/data' } as CloudEnv;
    expect(tenantScratchDir(env, 'alice')).toBe(path.resolve('/data', 'tenants', 'alice'));
    expect(tenantScratchDir(env, 'alice')).not.toBe(tenantScratchDir(env, 'bob'));
  });
});

describe('buildMediaSink', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = '';
  });

  const setup = async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-media-'));
    const store = new CloudStore(path.join(dir, 'cloud.db'));
    const env = { DATA_DIR: dir } as CloudEnv;
    const user = store.upsertUser({ provider: 'dev', providerId: 'media', email: null, name: null, avatar: null });
    const convo = store.createConversation(user.id);
    const socket = new FakeSocket();
    const sink = buildMediaSink({ env, store, userId: user.id, conversationId: convo.id, socket });
    return { store, env, user, convo, socket, sink };
  };

  const asset = {
    kind: 'image' as const,
    data: Buffer.from('\x89PNG\r\n\x1a\nfake-image-bytes'),
    mimeType: 'image/png',
    filename: 'cascade-1730000000.png',
    modelId: 'gpt-image-1',
  };

  it('returns a fetchable /api/files/:id path, not a bare filename', async () => {
    const { store, user, sink } = await setup();

    const location = await sink(asset as Parameters<typeof sink>[0]);

    // The model embeds this string as ![alt](location) and the client-side
    // exporter later fetches it. A bare filename resolves to nothing, which is
    // how a generated image vanishes from a .pptx. The URL shape is the SAME
    // for pending and saved media (and the id survives a save), so nothing
    // that renders the transcript has to know which state the asset is in.
    const [media] = store.listPendingMedia(user.id);
    expect(media).toBeDefined();
    expect(location).toBe(`/api/files/${media!.id}`);
    expect(location).not.toBe(asset.filename);
    // …and it matches the route the server actually serves (app.ts).
    expect(location).toMatch(/^\/api\/files\/[A-Za-z0-9._~%-]+$/);
  });

  it('writes the bytes to the tenant temp area and announces them as pending', async () => {
    const { store, env, user, convo, socket, sink } = await setup();

    const before = Date.now();
    const location = await sink(asset as Parameters<typeof sink>[0]);
    const id = location.slice('/api/files/'.length);

    // The locator points at a row that exists and at bytes on disk — a URL
    // shape alone would be a regression if it 404'd.
    expect(store.getPendingMedia(id, user.id)?.name).toBe(asset.filename);
    const onDisk = await fs.readFile(path.join(tenantScratchDir(env, user.id), 'tmp-media', id));
    expect(onDisk.equals(asset.data)).toBe(true);
    // Not in the permanent area at all — nothing to clean up if it expires.
    await expect(fs.readFile(path.join(tenantScratchDir(env, user.id), 'files', id))).rejects.toThrow();

    const events = socket.events.filter((e) => e.event === 'file:created');
    expect(events).toHaveLength(1);
    // Same event as a saved file, flagged so the client can badge it as
    // temporary instead of announcing storage the user never spent.
    expect(events[0]!.payload).toMatchObject({ conversationId: convo.id, pending: true });
    const { expiresAt } = events[0]!.payload as { expiresAt: number };
    expect(expiresAt).toBeGreaterThanOrEqual(before + PENDING_MEDIA_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + PENDING_MEDIA_TTL_MS);
  });

  // ── The bug this whole change exists to fix ──
  it('does NOT charge storage quota, or create a files row, at generation time', async () => {
    const { store, user, sink } = await setup();

    expect(store.sumUserFileBytes(user.id)).toBe(0);
    await sink(asset as Parameters<typeof sink>[0]);

    // Generating is not keeping. Until the user presses Save, their metered
    // storage is untouched and their Files list is empty — the old sink
    // charged them the instant the model produced a picture, with no opt-out.
    expect(store.sumUserFileBytes(user.id)).toBe(0);
    expect(store.listFiles(user.id)).toHaveLength(0);
    // The bytes are accounted for, just not against the quota.
    expect(store.sumUserPendingMediaBytes(user.id)).toBe(asset.data.length);
  });

  it('generates media LARGER than the whole free storage cap without failing', async () => {
    // The sharpest form of the regression: 12 MB against a 10 MB free plan.
    // While generation ran checkStorageQuota, this threw and the user got an
    // apology instead of their video — for an asset they had not asked to
    // keep. Quota is now the *save* button's business, so this must succeed
    // and still spend nothing.
    const { store, user, sink } = await setup();
    const huge = { ...asset, data: Buffer.alloc(12 * 1024 * 1024, 7), filename: 'clip.mp4', mimeType: 'video/mp4' };

    const location = await sink(huge as unknown as Parameters<typeof sink>[0]);

    expect(location).toMatch(/^\/api\/files\//);
    expect(store.sumUserFileBytes(user.id)).toBe(0);
    expect(limitsForPlan('free').storageBytes).toBeLessThan(huge.data.length);
  });

  it('still refuses to park unbounded unsaved bytes (the pending allowance)', async () => {
    // Self-expiry bounds how long unmetered bytes live, not how fast they
    // arrive, so there is one ceiling left. It is NOT the storage quota: it is
    // ~6x the free plan's, and nothing here is permanent.
    const { store, user, sink } = await setup();
    const cap = limitsForPlan('free').pendingMediaBytes;
    const big = { ...asset, data: Buffer.alloc(cap + 1, 3) };

    await expect(sink(big as unknown as Parameters<typeof sink>[0])).rejects.toThrow(/unsaved generated media/i);
    expect(store.listPendingMedia(user.id)).toHaveLength(0);
    expect(store.sumUserFileBytes(user.id)).toBe(0);
  });

  it('sweeps expired media before checking the allowance, so yesterday cannot block today', async () => {
    const { store, env, user, sink } = await setup();
    const cap = limitsForPlan('free').pendingMediaBytes;
    // An asset that filled the allowance yesterday and has already expired.
    const stale = store.addPendingMedia({
      userId: user.id, conversationId: null, name: 'old.png', mime: 'image/png',
      size: cap, expiresAt: Date.now() - 1000,
    });
    await fs.mkdir(path.join(tenantScratchDir(env, user.id), 'tmp-media'), { recursive: true });
    await fs.writeFile(path.join(tenantScratchDir(env, user.id), 'tmp-media', stale.id), Buffer.alloc(16));

    await expect(sink(asset as Parameters<typeof sink>[0])).resolves.toMatch(/^\/api\/files\//);

    // The stale asset and its bytes are gone, not merely ignored.
    expect(store.listExpiredPendingMedia(Date.now())).toHaveLength(0);
    await expect(fs.readFile(path.join(tenantScratchDir(env, user.id), 'tmp-media', stale.id))).rejects.toThrow();
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

  it('accepts a maximal real KeyVault config: 4 single-instance types plus 2 Azure deployments', () => {
    // Regression (Codex P2): KeyVault's SELECTABLE_TYPES offers single-instance
    // cloud types (anthropic, openai, gemini, openai-compatible) plus Azure,
    // which alone supports multiple deployments (one array entry each). The
    // plausible maximum is therefore 6 — a config KeyVault will happily save
    // but that used to fail every chat:run at this Zod gate before ever
    // reaching buildCloudConfig. This pins the bound to the real UI.
    const parsed = parseChatRunPayload({
      prompt: 'hi',
      providers: [
        { type: 'anthropic', apiKey: 'k' },
        { type: 'openai', apiKey: 'k' },
        { type: 'gemini', apiKey: 'k' },
        { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' },
        { type: 'azure', apiKey: 'k', baseUrl: 'https://a.openai.azure.com', deploymentName: 'dep-a' },
        { type: 'azure', apiKey: 'k', baseUrl: 'https://b.openai.azure.com', deploymentName: 'dep-b' },
      ],
    });
    expect(parsed.providers).toHaveLength(6);
  });

  it('still rejects a providers array beyond the raised bound', () => {
    const providers = Array.from({ length: 8 }, () => ({ type: 'openai' as const, apiKey: 'k' }));
    expect(() => parseChatRunPayload({ prompt: 'hi', providers })).toThrow();
  });

  it('accepts routing controls and rejects out-of-range values', () => {
    const parsed = parseChatRunPayload({
      prompt: 'hi',
      providers: [{ type: 'openai' }],
      routingMode: 'quality',
      forceTier: 'T3',
      webSearch: true,
    });
    expect(parsed.routingMode).toBe('quality');
    expect(parsed.forceTier).toBe('T3');
    expect(parsed.webSearch).toBe(true);
    expect(() =>
      parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }], forceTier: 'T9' }),
    ).toThrow();
    expect(() =>
      parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }], routingMode: 'turbo' }),
    ).toThrow();
  });

  it('accepts an on-device complexity hint and rejects an unknown level', () => {
    const parsed = parseChatRunPayload({
      prompt: 'hi',
      providers: [{ type: 'openai' }],
      complexityHint: 'Moderate',
    });
    expect(parsed.complexityHint).toBe('Moderate');
    // Absent by default, and 'Highly Complex' is not a valid client hint.
    expect(parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }] }).complexityHint).toBeUndefined();
    expect(() =>
      parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }], complexityHint: 'Highly Complex' }),
    ).toThrow();
  });

  it('accepts a fast-answer flag with an optional pinned model, and normalizes a blank model', () => {
    const parsed = parseChatRunPayload({
      prompt: 'hi',
      providers: [{ type: 'openai' }],
      fastAnswer: true,
      fastAnswerModel: 'gpt-4o-mini',
    });
    expect(parsed.fastAnswer).toBe(true);
    expect(parsed.fastAnswerModel).toBe('gpt-4o-mini');
    // Absent by default; a blank pinned model normalizes to undefined (auto-pick).
    expect(parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }] }).fastAnswer).toBeUndefined();
    expect(
      parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }], fastAnswer: true, fastAnswerModel: '' })
        .fastAnswerModel,
    ).toBeUndefined();
    expect(() =>
      parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }], fastAnswer: 'yes' }),
    ).toThrow();
  });

  it('accepts per-tier params and rejects out-of-range temperature', () => {
    const parsed = parseChatRunPayload({
      prompt: 'hi',
      providers: [{ type: 'openai' }],
      tierParams: { t2: { maxTokens: 2048, temperature: 0.6 } },
    });
    expect(parsed.tierParams?.t2).toEqual({ maxTokens: 2048, temperature: 0.6 });
    // temperature is bounded 0–2; maxTokens must be a positive int.
    expect(() =>
      parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }], tierParams: { t1: { temperature: 5 } } }),
    ).toThrow();
    expect(() =>
      parseChatRunPayload({ prompt: 'hi', providers: [{ type: 'openai' }], tierParams: { t3: { maxTokens: -1 } } }),
    ).toThrow();
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
    // The SDK persists model-perf stats into DATA_DIR with a fire-and-forget
    // save that can still be flushing as we tear down — retry the cleanup a few
    // times so that ENOTEMPTY race doesn't fail the test.
    if (dir) {
      for (let i = 0; i < 4; i++) {
        try { await fs.rm(dir, { recursive: true, force: true }); break; }
        catch { await new Promise((r) => setTimeout(r, 50)); }
      }
    }
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

    // "hello" is pure small talk: the server passes routingPrompt (the bare
    // user text, not the augmented prompt), the small-talk gate fires, and the
    // whole turn is ONE direct model call — no workers, no classifier.
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
    // Small talk must stay a single direct call — a second completion means a
    // worker/classifier snuck back into the greeting path.
    expect(stub.requestLog.filter((r) => r.includes('chat/completions')).length).toBe(1);
  }, 30_000);

  it('edits and regenerations create sibling branches, not overwrites', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-runs-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    stub = await startStubOpenAIServer();
    const env: CloudEnv = {
      PORT: 0, SESSION_SECRET: 'x'.repeat(20), DATA_DIR: dir, WEB_ORIGIN: 'http://localhost:5173',
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:8787', GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined,
      GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, CLOUD_DEV_BYPASS: false, MAX_COST_PER_RUN_USD: 1,
    };
    const user = store.upsertUser({ provider: 'dev', providerId: 'tester', email: null, name: 'Tester', avatar: null });
    const providers = [{ type: 'openai-compatible' as const, baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }];
    const run = (extra: Record<string, unknown>) =>
      runChatTurn(parseChatRunPayload({ providers, ...extra }), {
        env: env!, store: store!, userId: user.id, socket: new FakeSocket() as unknown as import('socket.io').Socket,
      });

    // 1. Initial turn → u1 + a1.
    const first = await run({ prompt: 'first prompt' });
    const cid = first.conversationId;
    const path1 = store.getActivePath(cid);
    expect(path1.map((m) => m.role)).toEqual(['user', 'assistant']);
    const [u1, a1] = path1;

    // 2. Edit u1 → a NEW sibling branch (u1b + a2). The original stays on disk.
    await run({ prompt: 'edited prompt', conversationId: cid, editOfMessageId: u1!.id });
    const path2 = store.getActivePath(cid);
    expect(path2.map((m) => m.content)).toEqual(['edited prompt', expect.stringContaining('Hello from the stub model.')]);
    expect(store.getSiblingIds(u1!.id)).toHaveLength(2); // original + edited, both roots
    expect(store.getMessageById(u1!.id)).not.toBeNull();  // original prompt preserved
    expect(store.getMessageById(a1!.id)).not.toBeNull();  // original answer preserved
    const u1b = path2[0]!;

    // 3. Regenerate the reply under the edited turn → assistant sibling a3.
    await run({ prompt: 'edited prompt', conversationId: cid, regenerateFromUserMessageId: u1b.id });
    const path3 = store.getActivePath(cid);
    // Still exactly one user turn on this branch, with a fresh (regenerated) reply.
    expect(path3.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(path3[0]!.id).toBe(u1b.id);                 // no new user message was created
    expect(store.getSiblingIds(path3[1]!.id)).toHaveLength(2); // two answers under the edited turn
  }, 30_000);

  it('marks the run cancelled and still persists partial output when the signal aborts', async () => {
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
    const payload = parseChatRunPayload({
      prompt: 'hello',
      providers: [{ type: 'openai-compatible', baseUrl: stub.url, apiKey: 'test-key', model: 'stub-model' }],
    });

    // Already-aborted signal: the run resolves (does not throw) with whatever
    // it had, and the result is flagged cancelled so the UI can label it.
    const controller = new AbortController();
    controller.abort();
    const result = await runChatTurn(payload, {
      env, store, userId: user.id, socket: socket as unknown as import('socket.io').Socket, signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    // A user turn is always persisted; the run never rejected.
    const messages = store.getMessages(result.conversationId);
    expect(messages[0]!.role).toBe('user');
    expect(socket.events.some((e) => e.event === 'session:error')).toBe(false);
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

describe('ChatRunPayloadSchema — a client that predates a provider removal', () => {
  it('ignores a retired provider instead of rejecting the whole run', () => {
    // A browser tab open across the rollout keeps sending its in-memory list
    // until the page is reloaded, and the localStorage migration only runs in
    // freshly loaded assets. Rejecting the payload breaks every run from that
    // tab even though it also carries a usable provider.
    const parsed = parseChatRunPayload({
      prompt: 'hi',
      providers: [
        { type: 'github-models', apiKey: 'dead' },
        { type: 'anthropic', apiKey: 'sk-real' },
      ],
    });
    expect(parsed.providers.map((p) => p.type)).toEqual(['anthropic']);
  });

  it('still rejects a payload whose only provider was retired', () => {
    // Filtering happens before .min(1), so "nothing usable left" is still an
    // error — the run genuinely has nothing to execute with.
    expect(() => parseChatRunPayload({
      prompt: 'hi',
      providers: [{ type: 'github-models', apiKey: 'dead' }],
    })).toThrow();
  });
});
