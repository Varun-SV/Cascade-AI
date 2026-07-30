// ─────────────────────────────────────────────
//  Cascade AI — router OpenAI-compatible discovery
// ─────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CascadeRouter } from './index.js';
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

describe('CascadeRouter — GitHub Models wiring', () => {
  it('synthesizes a seed model and builds a GitHubModelsProvider for it', async () => {
    // GitHub Models has no static MODELS catalog entries (its catalog is served
    // live), so without a synthesized seed `detectAvailableProviders` would skip
    // the provider outright and it could never be probed or listed — the exact
    // failure openai-compatible/azure already carry a seed to avoid.
    const { GitHubModelsProvider } = await import('../../providers/github-models.js');
    const router = new CascadeRouter();
    const internals = router as unknown as Record<string, (...args: unknown[]) => unknown>;

    const seed = internals['getAnyModelForProvider']!('github-models') as { provider: string } | undefined;
    expect(seed).toBeDefined();
    expect(seed!.provider).toBe('github-models');

    const provider = internals['createProvider']!({ type: 'github-models', apiKey: 'ghp_test' }, seed);
    expect(provider).toBeInstanceOf(GitHubModelsProvider);
  });

  it('detectAvailableProviders marks it available/unavailable from the catalog probe', async () => {
    const { GitHubModelsProvider } = await import('../../providers/github-models.js');
    const router = new CascadeRouter();
    const detect = (router as unknown as Record<string, (...a: unknown[]) => Promise<Set<string>>>)['detectAvailableProviders']!;
    const cfgs = [{ type: 'github-models', apiKey: 'ghp_test' }];

    const ok = vi.spyOn(GitHubModelsProvider.prototype, 'isAvailable').mockResolvedValue(true);
    expect((await detect.call(router, cfgs)).has('github-models')).toBe(true);
    ok.mockResolvedValue(false);
    expect((await detect.call(router, cfgs)).has('github-models')).toBe(false);
    ok.mockRestore();
  });

  it('names the provider in the error when a github-models pin cannot be resolved', async () => {
    // A `tier: 'provider:model'` pin that can't resolve should say WHICH
    // provider is unreachable; an unrecognised prefix falls through to a
    // generic "could not be loaded" that gives the user nothing to act on.
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());

    await expect(router.init(makeConfig({
      providers: [{ type: 'github-models', apiKey: 'ghp_test' }],
      models: { t1: 'github-models:openai/gpt-4o' },
    }))).rejects.toThrow(/provider 'github-models' is not available/);
  });

  it('re-discovers the GitHub Models catalog on a live-data refresh', async () => {
    const { GitHubModelsProvider } = await import('../../providers/github-models.js');
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());
    const avail = vi.spyOn(GitHubModelsProvider.prototype, 'isAvailable').mockResolvedValue(true);
    const list = vi.spyOn(GitHubModelsProvider.prototype, 'listModels').mockResolvedValue([{
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'github-models',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    }]);

    await router.init(makeConfig({ providers: [{ type: 'github-models', apiKey: 'ghp_test' }] }));
    // Availability is only consulted inside discovery, so mark it directly the
    // way a successful probe would have.
    (router as unknown as { selector: { markProviderAvailable(p: string): void } }).selector
      .markProviderAvailable('github-models');
    await (router as unknown as Record<string, () => Promise<void>>)['discoverProviderModels']!();

    expect(list).toHaveBeenCalled();
    expect(router.getAvailableModels().some((m) => m.id === 'openai/gpt-4o' && m.provider === 'github-models')).toBe(true);
    avail.mockRestore();
    list.mockRestore();
  });

  it('fills an Auto tier AND binds a real provider when GitHub Models is the only configured provider', async () => {
    // Regression (Codex P1): relying solely on the background refreshLiveData()
    // path left every tier permanently empty for a github-models-only config —
    // Auto tier fill in init() ran before any catalog model was registered, and
    // applyLivePricing() (the background path's only tier-refresh point) only
    // refreshes a tier model that ALREADY exists, never fills one that was
    // never set. Even reaching a model via the selector's live "any available"
    // fallback at generate() time wasn't enough on its own: that fallback never
    // calls ensureProvider(), so getProvider(model) would return undefined and
    // generate() would throw "No provider for model ...". A real init() +
    // real generate() exercises both halves end to end.
    const { GitHubModelsProvider } = await import('../../providers/github-models.js');
    const avail = vi.spyOn(GitHubModelsProvider.prototype, 'isAvailable').mockResolvedValue(true);
    const list = vi.spyOn(GitHubModelsProvider.prototype, 'listModels').mockResolvedValue([{
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'github-models',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    }]);
    const stream = vi.spyOn(GitHubModelsProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'pong', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);

    const router = new CascadeRouter();
    await router.init(makeConfig({ providers: [{ type: 'github-models', apiKey: 'ghp_test' }] }));

    const t1 = router.getModelForTier('T1');
    expect(t1?.provider).toBe('github-models');
    expect(t1?.id).toBe('openai/gpt-4o');

    const result = await router.generate('T1', { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('pong');
    expect(stream).toHaveBeenCalled();

    avail.mockRestore();
    list.mockRestore();
    stream.mockRestore();
  });

  it('picks up a config.rateLimits.providerTpm override through real schema validation', async () => {
    // Regression (Codex P2): rateLimits wasn't declared on CascadeConfigSchema,
    // so a config-file override for github-models' conservative default was
    // silently stripped before the router ever saw it. Parse through the REAL
    // schema (not a hand-built object) so this fails again if that stripping
    // regresses.
    const raw = {
      providers: [{ type: 'github-models', apiKey: 'ghp_test' }],
      rateLimits: { providerTpm: { 'github-models': 50_000 } },
    };
    const parsed = CascadeConfigSchema.parse(raw) as unknown as CascadeConfig;
    expect(parsed.rateLimits?.providerTpm?.['github-models']).toBe(50_000); // schema didn't strip it

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());
    await router.init(parsed);

    const limiter = (router as unknown as { tpmLimiter: TpmLimiter }).tpmLimiter;
    expect(limiter.snapshot()['github-models']!.tokensPerMinute).toBe(50_000);
  });

  it('falls back to the conservative default when no override is configured', async () => {
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set());
    await router.init(makeConfig({ providers: [{ type: 'github-models', apiKey: 'ghp_test' }] }));

    const limiter = (router as unknown as { tpmLimiter: TpmLimiter }).tpmLimiter;
    expect(limiter.snapshot()['github-models']!.tokensPerMinute).toBe(DEFAULT_PROVIDER_TPM['github-models']);
  });
});
