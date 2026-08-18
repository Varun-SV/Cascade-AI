// ─────────────────────────────────────────────
//  Cascade AI — router OpenAI-compatible discovery
// ─────────────────────────────────────────────

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CascadeRouter, credentialIdentityKeys, discoveryCacheKey } from './index.js';
import crypto from 'node:crypto';
import type { CascadeConfig } from '../../types.js';
import { CascadeConfigSchema } from '../../config/schema.js';
import { DEFAULT_PROVIDER_TPM, TpmLimiter } from './tpm-limiter.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-llama', object: 'model' }] }));
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function makeConfig(overrides: Partial<CascadeConfig> = {}): CascadeConfig {
  return { providers: [], models: {}, tools: { allowedTools: [] }, ...overrides } as unknown as CascadeConfig;
}

describe('CascadeRouter — OpenAI-compatible discovery', () => {
  it('discovers real models even when the separate isAvailable() probe reports the provider unavailable', async () => {
    // Regression: discovery used to run only `if (availableProviders.has('openai-compatible'))`,
    // gating it behind a second, independent network probe. A flaky/slow first
    // connection there could strand a perfectly reachable endpoint as
    // "unavailable" for the whole session — even though discovery itself (this
    // very call) succeeds moments later. Simulate that flaky first probe by
    // stubbing detectAvailableProviders() to report nothing available, and
    // confirm the model is still discovered and selectable.
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());

    await router.init(makeConfig({
      providers: [{ type: 'openai-compatible', baseUrl }],
    }));

    const models = router.getAvailableModels();
    expect(models.some((m) => m.id === 'local-llama' && m.provider === 'openai-compatible')).toBe(true);
  });

  it('does not attempt discovery when no openai-compatible baseUrl is configured', async () => {
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());

    await router.init(makeConfig({ providers: [] }));

    expect(router.getAvailableModels().some((m) => m.provider === 'openai-compatible')).toBe(false);
  });
});

describe('CascadeRouter — Azure deployment trust (probe-independent)', () => {
  it('a single configured deployment fills EVERY tier even when the probe reports nothing available', async () => {
    // The reported bug: setting an Azure deployment other than one that happens
    // to collide with a catalog id gave "No model available for tier T1". Root
    // cause: registration + tier-fill were gated on the flaky isAvailable()
    // probe. A user who entered an endpoint, key, and deployment name has told
    // us the deployment exists — one deployment must serve all three tiers.
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set()); // probe finds nothing (cold start / 429 / filtered ping)

    await router.init(makeConfig({
      providers: [{
        type: 'azure',
        deploymentName: 'my-company-gpt', // opaque name — collides with no catalog id
        apiKey: 'sk-azure-test',
        baseUrl: 'https://example.openai.azure.com',
      }],
    }));

    // The deployment is registered under its callable name…
    expect(router.getAvailableModels().some((m) => m.id === 'my-company-gpt' && m.provider === 'azure')).toBe(true);
    // …and every tier resolves to it, so no tier can hard-fail at generate time.
    for (const tier of ['T1', 'T2', 'T3'] as const) {
      expect(router.getModelForTier(tier)?.id).toBe('my-company-gpt');
    }
  });

  it('does not register azure when no deployment name is configured', async () => {
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());

    await router.init(makeConfig({ providers: [{ type: 'azure', apiKey: 'sk-x', baseUrl: 'https://x.openai.azure.com' }] }));

    expect(router.getAvailableModels().some((m) => m.provider === 'azure')).toBe(false);
  });
});

describe('CascadeRouter — explicit per-tier pin overrides Cascade Auto', () => {
  it('uses the pinned model for a pinned tier instead of re-selecting per subtask', async () => {
    // Reported bug: T3 pinned to a local openai-compatible model in Settings,
    // but with Cascade Auto ON the per-subtask router re-selected (e.g. Gemini)
    // and ignored the pin. An explicit pin must always win.
    const router = new CascadeRouter();
    const pinned = {
      id: 'C:\\llama\\models\\gpt-oss-20b-F16.gguf', name: 'GPT-OSS 20B', provider: 'openai-compatible',
      contextWindow: 32_000, isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
      maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
    };
    const internals = router as unknown as Record<string, unknown>;
    internals['config'] = { cascadeAuto: true };
    internals['tierModels'] = new Map([['T3', pinned]]);
    internals['explicitTierModels'] = new Set(['T3']);

    const chosen = await router.selectModelForSubtask('T3', 'Design and implement a new image format');
    expect(chosen?.id).toBe(pinned.id);
    expect(chosen?.provider).toBe('openai-compatible');
  });
});

describe('CascadeRouter — rate-limit failover retry', () => {
  it('clears a rate-limited per-call model pin before retrying, so the bound fallback is actually used', async () => {
    // Regression (Codex P1): a subtask pinned via options.model (Cascade
    // Auto's per-subtask override) that hits a 429 used to retry with the
    // SAME unchanged options. Since `options.model ?? this.tierModels.get(tier)`
    // resolves options.model first, the recursive call re-selected the SAME
    // now-rate-limited pinned model — ignoring the fallback that
    // failover.getFallbackModel() had just bound — and would keep retrying
    // the same dead pin indefinitely rather than using the fallback.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    const openaiStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('429 Too Many Requests'));
    const anthropicStream = vi.spyOn(AnthropicProvider.prototype, 'generateStream')
      .mockResolvedValue({
        content: 'from fallback', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
      } as never);

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['openai', 'anthropic']));

    await router.init(makeConfig({
      providers: [
        { type: 'openai', apiKey: 'sk-test' },
        { type: 'anthropic', apiKey: 'sk-ant-test' },
      ],
    }));

    const pinnedModel = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    expect(pinnedModel).toBeDefined();

    const result = await router.generate('T1', {
      messages: [{ role: 'user', content: 'hi' }],
      model: pinnedModel,
    });

    expect(result.content).toBe('from fallback');
    // The bug would keep re-selecting the pinned openai model and calling it
    // again on every retry; the fix clears the pin so the very next attempt
    // resolves to the bound fallback instead.
    expect(openaiStream).toHaveBeenCalledTimes(1);
    expect(anthropicStream).toHaveBeenCalledTimes(1);

    openaiStream.mockRestore();
    anthropicStream.mockRestore();
  });
});

describe('CascadeRouter — live-discovered provider wiring (openai-compatible)', () => {
  it('synthesizes a seed model and builds a GitHubModelsProvider for it', async () => {
    // openai-compatible has no static MODELS catalog entries (its models are
    // served live by whatever endpoint the user pointed at), so without a synthesized seed `detectAvailableProviders` would skip
    // the provider outright and it could never be probed or listed — the exact
    // failure the synthesized seed exists to avoid.
    const { OpenAICompatibleProvider } = await import('../../providers/openai-compatible.js');
    const router = new CascadeRouter();
    const internals = router as unknown as Record<string, (...args: unknown[]) => unknown>;

    const seed = internals['getAnyModelForProvider']!('openai-compatible') as { provider: string } | undefined;
    expect(seed).toBeDefined();
    expect(seed!.provider).toBe('openai-compatible');

    const provider = internals['createProvider']!({ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/v1' }, seed);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('detectAvailableProviders marks it available/unavailable from the catalog probe', async () => {
    const { OpenAICompatibleProvider } = await import('../../providers/openai-compatible.js');
    const router = new CascadeRouter();
    const detect = (router as unknown as Record<string, (...a: unknown[]) => Promise<Set<string>>>)['detectAvailableProviders']!;
    const cfgs = [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/v1' }];

    const ok = vi.spyOn(OpenAICompatibleProvider.prototype, 'isAvailable').mockResolvedValue(true);
    expect((await detect.call(router, cfgs)).has('openai-compatible')).toBe(true);
    ok.mockResolvedValue(false);
    expect((await detect.call(router, cfgs)).has('openai-compatible')).toBe(false);
    ok.mockRestore();
  });

  it('names the provider in the error when a pin cannot be resolved', async () => {
    // A `tier: 'provider:model'` pin that can't resolve should say WHICH
    // provider is unreachable; an unrecognised prefix falls through to a
    // generic "could not be loaded" that gives the user nothing to act on.
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());

    await expect(router.init(makeConfig({
      providers: [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/v1' }],
      models: { t1: 'openai-compatible:openai/gpt-4o' },
    }))).rejects.toThrow(/provider 'openai-compatible' is not available/);
  });

  it('re-discovers a live provider model list on a live-data refresh', async () => {
    const { OpenAICompatibleProvider } = await import('../../providers/openai-compatible.js');
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());
    const avail = vi.spyOn(OpenAICompatibleProvider.prototype, 'isAvailable').mockResolvedValue(true);
    const list = vi.spyOn(OpenAICompatibleProvider.prototype, 'listModels').mockResolvedValue([{
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'openai-compatible',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    }]);

    await router.init(makeConfig({ providers: [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/v1' }] }));
    // Availability is only consulted inside discovery, so mark it directly the
    // way a successful probe would have.
    (router as unknown as { selector: { markProviderAvailable(p: string): void } }).selector
      .markProviderAvailable('openai-compatible');
    await (router as unknown as Record<string, () => Promise<void>>)['discoverProviderModels']!();

    expect(list).toHaveBeenCalled();
    expect(router.getAvailableModels().some((m) => m.id === 'openai/gpt-4o' && m.provider === 'openai-compatible')).toBe(true);
    avail.mockRestore();
    list.mockRestore();
  });

  it('fills an Auto tier AND binds a real provider when a live-discovered provider is the only one configured', async () => {
    // Regression (Codex P1): relying solely on the background refreshLiveData()
    // path left every tier permanently empty for a live-discovery-only config —
    // Auto tier fill in init() ran before any catalog model was registered, and
    // applyLivePricing() (the background path's only tier-refresh point) only
    // refreshes a tier model that ALREADY exists, never fills one that was
    // never set. Even reaching a model via the selector's live "any available"
    // fallback at generate() time wasn't enough on its own: that fallback never
    // calls ensureProvider(), so getProvider(model) would return undefined and
    // generate() would throw "No provider for model ...". A real init() +
    // real generate() exercises both halves end to end.
    const { OpenAICompatibleProvider } = await import('../../providers/openai-compatible.js');
    const avail = vi.spyOn(OpenAICompatibleProvider.prototype, 'isAvailable').mockResolvedValue(true);
    const list = vi.spyOn(OpenAICompatibleProvider.prototype, 'listModels').mockResolvedValue([{
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'openai-compatible',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    }]);
    const stream = vi.spyOn(OpenAICompatibleProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'pong', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);

    const router = new CascadeRouter();
    await router.init(makeConfig({ providers: [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/v1' }] }));

    const t1 = router.getModelForTier('T1');
    expect(t1?.provider).toBe('openai-compatible');
    expect(t1?.id).toBe('openai/gpt-4o');

    const result = await router.generate('T1', { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('pong');
    expect(stream).toHaveBeenCalled();

    avail.mockRestore();
    list.mockRestore();
    stream.mockRestore();
  });

  it('binds a real provider for a vision model reached only through selectVisionModel()', async () => {
    // Regression (Codex): selectVisionModel()'s "widen past the static
    // catalog" fallback lets it return a live-discovered model that was never
    // the tier-fill winner — here, two live-discovered entries are
    // discovered, so init()'s tier-fill (which only binds ONE model per tier)
    // binds the non-vision model, leaving the vision-capable one unbound.
    // requireVision=true then resolves to that unbound model via
    // selectVisionModel(), and generate() used to call getProvider(model)
    // without ever having called ensureProvider() for it on this path —
    // throwing "No provider for model ..." even though the provider config
    // was perfectly valid.
    const { OpenAICompatibleProvider } = await import('../../providers/openai-compatible.js');
    const avail = vi.spyOn(OpenAICompatibleProvider.prototype, 'isAvailable').mockResolvedValue(true);
    const list = vi.spyOn(OpenAICompatibleProvider.prototype, 'listModels').mockResolvedValue([
      {
        id: 'meta/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', provider: 'openai-compatible',
        contextWindow: 8_000, isVisionCapable: false,
        inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
        maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
      },
      {
        id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'openai-compatible',
        contextWindow: 8_000, isVisionCapable: true,
        inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
        maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
      },
    ]);
    const stream = vi.spyOn(OpenAICompatibleProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'i see it', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);

    const router = new CascadeRouter();
    await router.init(makeConfig({ providers: [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/v1' }] }));

    // Tier-fill bound the non-vision model, not the vision-capable one.
    expect(router.getModelForTier('T1')?.id).toBe('meta/Llama-3.3-70B-Instruct');

    const result = await router.generate(
      'T1',
      { messages: [{ role: 'user', content: 'what is in this image?' }] },
      undefined,
      true, // requireVision
    );
    expect(result.content).toBe('i see it');
    expect(stream).toHaveBeenCalled();

    avail.mockRestore();
    list.mockRestore();
    stream.mockRestore();
  });

  it('caps the TPM reservation at the model maxOutputTokens, not an uncapped per-call override', async () => {
    // Regression (Codex P2): the reservation was `options.maxTokens ??
    // model.maxOutputTokens`, so an explicit per-call maxTokens ABOVE the
    // model's own cap (T1's final compilation step asks for 8,000, while an
    // endpoint's listModels() may report a much lower real per-request ceiling) inflated the TPM reservation past what the provider's
    // generateStream() override will actually clamp the request down to —
    // silently reserving the bucket's ENTIRE 8,000-token default budget for
    // one call instead of the intended ~4,512, exactly the invariant
    // DEFAULT_PROVIDER_TPM['openai-compatible']'s own comment documents.
    const { OpenAICompatibleProvider } = await import('../../providers/openai-compatible.js');
    const avail = vi.spyOn(OpenAICompatibleProvider.prototype, 'isAvailable').mockResolvedValue(true);
    const list = vi.spyOn(OpenAICompatibleProvider.prototype, 'listModels').mockResolvedValue([{
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'openai-compatible',
      contextWindow: 8_000, isVisionCapable: false,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    }]);
    const stream = vi.spyOn(OpenAICompatibleProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);

    const router = new CascadeRouter();
    await router.init(makeConfig({ providers: [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/v1' }] }));

    const limiter = (router as unknown as { tpmLimiter: TpmLimiter }).tpmLimiter;
    const acquire = vi.spyOn(limiter, 'acquire');

    await router.generate('T1', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8_000 });

    // Asserted on the first two arguments rather than the whole call: acquire
    // also takes the run's abort signal now, and this test is about the token
    // reservation, not the arity.
    expect(acquire.mock.calls[0]?.slice(0, 2)).toEqual(['openai-compatible', 4_512]); // min(8000, 4000) + 512, not 8000 + 512

    avail.mockRestore();
    list.mockRestore();
    stream.mockRestore();
    acquire.mockRestore();
  });

  it('picks up a config.rateLimits.providerTpm override through real schema validation', async () => {
    // Regression (Codex P2): rateLimits wasn't declared on CascadeConfigSchema,
    // so a config-file override for a provider's default was
    // silently stripped before the router ever saw it. Parse through the REAL
    // schema (not a hand-built object) so this fails again if that stripping
    // regresses.
    const raw = {
      providers: [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/v1' }],
      rateLimits: { providerTpm: { 'openai-compatible': 50_000 } },
    };
    const parsed = CascadeConfigSchema.parse(raw) as unknown as CascadeConfig;
    expect(parsed.rateLimits?.providerTpm?.['openai-compatible']).toBe(50_000); // schema didn't strip it

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());
    await router.init(parsed);

    const limiter = (router as unknown as { tpmLimiter: TpmLimiter }).tpmLimiter;
    expect(limiter.snapshot()['openai-compatible']!.tokensPerMinute).toBe(50_000);
  });

  it('falls back to the conservative default when no override is configured', async () => {
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());
    await router.init(makeConfig({ providers: [{ type: 'openai-compatible', apiKey: 'k', baseUrl: 'http://127.0.0.1:9999/v1' }] }));

    const limiter = (router as unknown as { tpmLimiter: TpmLimiter }).tpmLimiter;
    expect(limiter.snapshot()['openai-compatible']!.tokensPerMinute).toBe(DEFAULT_PROVIDER_TPM['openai-compatible']);
  });
});

describe('CascadeRouter — a failed probe explains itself', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('records why each configured provider was rejected', async () => {
    // The reported symptom was two messages that together said nothing: the
    // router guessing "bad key, wrong endpoint/deployment, or unreachable",
    // then the CLI telling a user who had just entered a working key to add
    // one. The reason the API gave has to survive to the surface.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { message: 'API key not valid. Please pass a valid API key.' } }),
    })) as unknown as typeof fetch);

    const router = new CascadeRouter();
    await router.init(makeConfig({ providers: [{ type: 'gemini', apiKey: 'bad-key' }] }));

    const failures = router.providerProbeFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.provider).toBe('gemini');
    expect(failures[0]!.reason).toContain('API key not valid');
  });

  it('reports nothing when the probe passes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [{
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          inputTokenLimit: 1_000_000,
          outputTokenLimit: 8192,
          supportedGenerationMethods: ['generateContent'],
        }],
      }),
    })) as unknown as typeof fetch);

    const router = new CascadeRouter();
    await router.init(makeConfig({ providers: [{ type: 'gemini', apiKey: 'good-key' }] }));

    expect(router.providerProbeFailures()).toEqual([]);
    // And the provider is genuinely usable, which is the point of the probe.
    expect(router.getAvailableModels().some((m) => m.provider === 'gemini')).toBe(true);
  });

  it('is cleared by a later init, so a fixed key does not keep reporting the old failure', async () => {
    const router = new CascadeRouter();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}),
    })) as unknown as typeof fetch);
    await router.init(makeConfig({ providers: [{ type: 'gemini', apiKey: 'bad' }] }));
    expect(router.providerProbeFailures()).toHaveLength(1);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ models: [] }),
    })) as unknown as typeof fetch);
    await router.init(makeConfig({ providers: [{ type: 'gemini', apiKey: 'good' }] }));
    expect(router.providerProbeFailures()).toEqual([]);
  });
});

describe('CascadeRouter — a transient probe failure does not erase a provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the provider enabled when the probe hits a 503', async () => {
    // The same reasoning already written out in init() for Azure deployments
    // and openai-compatible endpoints: a momentary blip must not cost a user
    // their only provider for the whole session. A genuinely broken one still
    // fails loudly at generate time with its own concrete error.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}),
    })) as unknown as typeof fetch);

    const router = new CascadeRouter();
    await router.init(makeConfig({ providers: [{ type: 'gemini', apiKey: 'fine' }] }));

    expect(router.getAvailableModels().some((m) => m.provider === 'gemini')).toBe(true);
    // And it is not reported as a reason no model is available, because one is.
    expect(router.providerProbeFailures()).toEqual([]);
  });

  it('still drops the provider when the key is genuinely rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, statusText: 'Forbidden',
      json: async () => ({ error: { message: 'API key not valid' } }),
    })) as unknown as typeof fetch);

    const router = new CascadeRouter();
    await router.init(makeConfig({ providers: [{ type: 'gemini', apiKey: 'bad' }] }));

    expect(router.getAvailableModels().some((m) => m.provider === 'gemini')).toBe(false);
    expect(router.providerProbeFailures()[0]?.reason).toContain('API key not valid');
  });
});

describe('CascadeRouter — a bearer-only Anthropic gateway is validated too', () => {
  let gw: http.Server;
  let gwUrl: string;
  const authSeen: string[] = [];

  beforeAll(async () => {
    gw = http.createServer((req, res) => {
      authSeen.push(String(req.headers['authorization'] ?? ''));
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'gw-claude-a', display_name: 'GW A' }] }));
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
    gwUrl = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => gw.close(() => r())));

  it('registers the gateway catalogue for a provider configured with only authToken', async () => {
    // validateCloudProviderModels() required `cfg.apiKey`, so a bearer-only
    // gateway never had its catalogue validated: the availability probe uses
    // listModels() as a boolean and discards the models, leaving AUTO routing
    // pinned to the BUNDLED public Anthropic catalogue — free to pick a model
    // the gateway does not serve and fail the first real request.
    authSeen.length = 0;
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['anthropic']));

    await router.init(makeConfig({
      providers: [{ type: 'anthropic', authToken: 'gw-token', baseUrl: gwUrl }],
    }));

    expect(router.getAvailableModels().some((m) => m.id === 'gw-claude-a')).toBe(true);
    // And it authenticated as a bearer, not with an empty x-api-key.
    expect(authSeen.some((a) => a === 'Bearer gw-token')).toBe(true);
  });
});

describe('discoveryCacheKey', () => {
  const cfg = (over: Record<string, unknown>) => ({ type: 'anthropic', ...over }) as never;

  it('separates credentials, and is stable for the same configured entry', () => {
    // Identity is per CONFIG ENTRY: the router passes the same object from
    // `config.providers.find(...)` on every call, and the desktop mutates that
    // object in place across settings saves, so this is the shape that decides
    // whether the cache hits.
    const entryA = cfg({ apiKey: 'sk-a' });
    const entryB = cfg({ apiKey: 'sk-b' });
    const a = discoveryCacheKey('anthropic', entryA);
    expect(a).not.toBe(discoveryCacheKey('anthropic', entryB));
    expect(discoveryCacheKey('anthropic', entryA)).toBe(a);
  });

  it('expires an identity once its TTL is up, however small the map is', async () => {
    // The sweep used to run only when the map grew past a threshold, so in the
    // ordinary case — a handful of credentials — nothing ever expired and a
    // rotated key stayed a raw Map key for the life of the process. That is
    // exactly the retention the expiry exists to end.
    vi.useFakeTimers();
    try {
      const before = discoveryCacheKey('anthropic', cfg({ apiKey: 'sk-ttl' }));
      vi.advanceTimersByTime(16 * 60 * 1000); // past the 15-minute TTL
      expect(discoveryCacheKey('anthropic', cfg({ apiKey: 'sk-ttl' }))).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is stable for an EQUIVALENT config rebuilt from scratch', () => {
    // The hosted server rebuilds its config for every chat run
    // (cloud/server/src/runs.ts → buildCloudConfig), so identity keyed on the
    // object missed the cache on every request: each run re-listed every
    // provider's models and appended another entry to a cache that was never
    // evicted.
    const a = discoveryCacheKey('anthropic', cfg({ apiKey: 'sk-a', baseUrl: 'https://gw' }));
    const b = discoveryCacheKey('anthropic', cfg({ apiKey: 'sk-a', baseUrl: 'https://gw' }));
    expect(b).toBe(a);
  });

  it('changes the moment the entry\'s credential is rotated in place', () => {
    // The security property, and the one an init-time prune could not deliver:
    // a settings save mutates the provider object and never re-initialises the
    // router, so the replacement has to be noticed here, on the next call.
    const entry = cfg({ apiKey: 'sk-old' }) as { apiKey: string };
    const before = discoveryCacheKey('anthropic', entry as never);
    entry.apiKey = 'sk-new';
    const after = discoveryCacheKey('anthropic', entry as never);
    expect(after).not.toBe(before);
    // …and it does not flap: the new secret keeps its own identity.
    expect(discoveryCacheKey('anthropic', entry as never)).toBe(after);
  });

  it('separates two bearers at the same endpoint', () => {
    // Two gateways on one URL serve different catalogues. Keying on apiKey
    // alone collapsed every bearer-only config onto one entry, so switching
    // credentials was answered from the previous one's cache.
    const url = 'https://gw.internal';
    const entry = cfg({ authToken: 'tok-a', baseUrl: url }) as { authToken: string };
    const a = discoveryCacheKey('anthropic', entry as never);
    entry.authToken = 'tok-b';
    expect(discoveryCacheKey('anthropic', entry as never)).not.toBe(a);
  });

  it('carries nothing derived from the credential', () => {
    // The security property. The key used to be sha256(apiKey) — the artifact
    // an offline guess is tested against, anywhere it surfaced (heap dump,
    // crash report, a future log of cache keys). The credential is now used
    // only for an equality lookup, so the key can neither contain it nor be
    // reproduced from it.
    const secret = 'sk-a-very-secret';
    const baseUrl = 'https://gw.internal';
    const key = discoveryCacheKey('anthropic', cfg({ apiKey: secret, baseUrl }));
    expect(key).not.toContain(secret);

    // The exact construction this used to have. Reproducing it here is what
    // makes the assertion bite: an earlier version of this test hashed the
    // secret ALONE, which never matched the tuple the code actually digested,
    // so it passed against the very implementation it was meant to reject.
    const previous = crypto.createHash('sha256')
      .update(`anthropic|${secret}||${baseUrl}`).digest('hex');
    expect(key).not.toBe(previous.slice(0, 24));
    expect(key).not.toContain(previous.slice(0, 16));

    // …and nothing else obvious either.
    for (const algo of ['sha256', 'sha1', 'md5']) {
      for (const input of [secret, `anthropic|${secret}`, `${secret}|${baseUrl}`]) {
        const digest = crypto.createHash(algo).update(input).digest('hex');
        expect(key).not.toContain(digest.slice(0, 16));
      }
    }
  });

  it('tells an apiKey and an authToken of the same value apart', () => {
    // The identity of a secret is the same whichever field holds it — the map
    // is keyed by the secret — but the two occupy different SLOTS in the key,
    // so a value used as an API key never collides with the same value used as
    // a bearer.
    const asKey = discoveryCacheKey('anthropic', cfg({ apiKey: 'same' }));
    const asToken = discoveryCacheKey('anthropic', cfg({ authToken: 'same' }));
    expect(asKey).not.toBe(asToken);
  });

  it('treats an absent credential as its own case, not as a collision', () => {
    const bare = cfg({ baseUrl: 'https://gw' });
    const none = discoveryCacheKey('anthropic', bare);
    expect(none).toBe(discoveryCacheKey('anthropic', bare));
    expect(none).not.toBe(discoveryCacheKey('anthropic', cfg({ apiKey: 'k', baseUrl: 'https://gw' })));
  });
});

describe('discoveryCacheKey — a rotated credential is not retained', () => {
  it('survives a settings save that never re-initialises the router', async () => {
    // The path an init-time prune could not reach, and the ordinary way a
    // credential is replaced: DashboardServer's config:update mutates the
    // provider entry and persists it without calling init(). The replacement
    // has to be noticed on the next call, not at some later lifecycle event.
    const entry = { type: 'anthropic', apiKey: 'old-key' };
    const before = discoveryCacheKey('anthropic', entry as never);

    const { applyProviderApiKey } = await import('../../config/index.js');
    applyProviderApiKey([entry], 'anthropic', 'rotated-key');

    expect(discoveryCacheKey('anthropic', entry as never)).not.toBe(before);
  });

  it('keeps the identity of a credential that did not change, so the cache still hits', async () => {
    const entry = { type: 'anthropic', apiKey: 'kept-key' };
    const before = discoveryCacheKey('anthropic', entry as never);

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());
    await router.init(makeConfig({ providers: [entry] }));

    expect(discoveryCacheKey('anthropic', entry as never)).toBe(before);
  });

});

describe('credential identity retention is capped, not slid', () => {
  // The comment above this code said that refreshing an entry on lookup would
  // let a credential in occasional use keep its identity for ever — and the
  // line below it did exactly that (`held.at = now`). Any secret used at least
  // once per TTL window therefore stayed a raw Map key for the life of the
  // process, which is precisely the retention the expiry exists to end.
  const TTL_MS = 15 * 60 * 1000;

  afterEach(() => { vi.useRealTimers(); });

  it('does not let repeated use extend how long a raw secret is held', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const cfg = { type: 'anthropic' as const, apiKey: 'secret-value' };
    const first = discoveryCacheKey('anthropic', cfg);

    // Used steadily, well inside the window each time — the traffic pattern
    // that used to pin the entry open indefinitely.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(TTL_MS / 3);
      discoveryCacheKey('anthropic', cfg);
    }

    // Past the TTL measured from FIRST use, the identity must have rotated:
    // the original entry was not kept alive by the lookups.
    vi.advanceTimersByTime(TTL_MS);
    expect(discoveryCacheKey('anthropic', cfg)).not.toBe(first);
  });

  it('never holds the raw secret, even with no later lookup to sweep it', () => {
    // Dropping the sliding refresh capped retention only in the sense that a
    // FUTURE lookup would evict the entry — `sweepExpired()` runs from nowhere
    // else. An idle process that inserted a credential and then made no further
    // identity lookup kept the raw string as a Map key for its whole lifetime.
    // Not storing the raw value at all removes the question instead of bounding
    // it, and no amount of advancing the clock can reintroduce it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));

    const secret = 'sk-raw-secret-value-should-never-be-retained';
    discoveryCacheKey('anthropic', { type: 'anthropic', apiKey: secret });

    // No further call — exactly the idle case the finding describes.
    vi.advanceTimersByTime(TTL_MS * 4);

    expect(credentialIdentityKeys().join('|')).not.toContain(secret);
    // …and the entry IS still there, so this is not passing because the map
    // happened to be empty.
    expect(credentialIdentityKeys().length).toBeGreaterThan(0);
  });

  it('is stable within one window, so the discovery cache still hits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));

    const cfg = { type: 'anthropic' as const, apiKey: 'another-secret' };
    const first = discoveryCacheKey('anthropic', cfg);
    vi.advanceTimersByTime(TTL_MS / 2);
    expect(discoveryCacheKey('anthropic', cfg)).toBe(first);
  });
});
