// ─────────────────────────────────────────────
//  Cascade AI — router OpenAI-compatible discovery
// ─────────────────────────────────────────────

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CascadeRouter, credentialIdentityKeys, discoveryCacheKey, resetCredentialIdentitiesForTest } from './index.js';
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

describe('CascadeRouter — exhausted quota is not a rate limit', () => {
  async function routerWithTwoProviders() {
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['openai', 'anthropic']));
    await router.init(makeConfig({
      providers: [
        { type: 'openai', apiKey: 'sk-test' },
        { type: 'anthropic', apiKey: 'sk-ant-test' },
      ],
    }));
    return router;
  }

  /** The FailoverManager the router built for itself. */
  function failoverOf(router: CascadeRouter) {
    return (router as unknown as { failover: {
      isProviderAvailable(p: string): boolean;
      isPermanentlyFailed(p: string): boolean;
      recordFailure(p: string, reason: string, opts?: Record<string, unknown>): void;
    } }).failover;
  }

  function selectorOf(router: CascadeRouter) {
    return (router as unknown as { selector: {
      selectForTier(t: string): { id: string } | null;
      getNextFallback(id: string, t: string): { id: string } | null;
    } }).selector;
  }

  it('does not hand an exhausted provider back after the backoff window', async () => {
    // The regression. `isRateLimitError` matches /quota/, so a spent wallet went
    // down the rate-limit path and earned a 30s→300s ladder built entirely on
    // the premise that the condition clears by itself. It does not: the provider
    // was re-enabled every window, called, and failed, for the rest of the run.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    const openaiStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(Object.assign(
        new Error('429 You exceeded your current quota, please check your plan and billing details'),
        { status: 429 },
      ));
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'from fallback', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);

    const router = await routerWithTwoProviders();
    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');

    await router.generate('T1', { messages: [{ role: 'user', content: 'hi' }], model: pinned });

    const failover = failoverOf(router);
    expect(failover.isPermanentlyFailed('openai')).toBe(true);

    // Real timers would need five minutes of wall clock; the verdict is read
    // through Date.now(), so move that instead and ask again.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 10 * 60 * 1000;
      expect(failover.isProviderAvailable('openai')).toBe(false);
    } finally {
      Date.now = realNow;
    }

    // And the exhausted provider was called exactly once — the point of the
    // verdict is that nothing goes back to ask it again.
    expect(openaiStream).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('still finishes the run on the other provider', async () => {
    // The chosen policy: a dead wallet on one account must not kill a long run
    // when another configured provider can serve the tier.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'from fallback', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);

    const router = await routerWithTwoProviders();
    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');

    const result = await router.generate('T1', { messages: [{ role: 'user', content: 'hi' }], model: pinned });

    expect(result.content).toBe('from fallback');
    vi.restoreAllMocks();
  });

  it('announces the dead account once, naming where the work went', async () => {
    // Continuing moves this user's spend onto a different account. Saying so is
    // the condition on which continuing is acceptable at all.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);

    const router = await routerWithTwoProviders();
    const seen: Array<Record<string, unknown>> = [];
    router.on('provider:exhausted', (e: Record<string, unknown>) => seen.push(e));

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    // Two calls: a concurrent T3 wave is many workers discovering the same fact.
    //
    // maxTokens is set only to keep the TpmLimiter out of the way. Left unset,
    // the reservation defaults to the model's whole maxOutputTokens (~32k for
    // opus), so the second call alone overruns anthropic's 40k/min bucket and
    // genuinely waits a full refill interval before it is allowed to proceed.
    await router.generate('T1', { messages: [{ role: 'user', content: 'a' }], model: pinned, maxTokens: 64 });
    await router.generate('T1', { messages: [{ role: 'user', content: 'b' }], model: pinned, maxTokens: 64 });

    expect(seen).toHaveLength(1);
    expect(seen[0]!['provider']).toBe('openai');
    expect(seen[0]!['kind']).toBe('quota_exhausted');
    expect(seen[0]!['failedOverTo']).toMatch(/^anthropic:/);
    expect(String(seen[0]!['message'])).toMatch(/billing/i);
    vi.restoreAllMocks();
  });

  it('a rate limit is still transient — it earns no permanent verdict', async () => {
    // Guard against over-reach. The ladder must keep working for the failure it
    // was built for, or this fix trades one bug for a worse one.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(Object.assign(new Error('429 Too Many Requests'), { status: 429 }));
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);

    const router = await routerWithTwoProviders();
    const seen: unknown[] = [];
    router.on('provider:exhausted', (e: unknown) => seen.push(e));

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    await router.generate('T1', { messages: [{ role: 'user', content: 'hi' }], model: pinned });

    expect(failoverOf(router).isPermanentlyFailed('openai')).toBe(false);
    expect(seen).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('refuses a LATER call on the dead provider without paying for it again', async () => {
    // Review finding, confirmed: `generate()` resolves
    // `options.model ?? this.tierModels.get(tier)` and neither arm consults the
    // selector, so marking the provider unavailable stopped future SELECTION
    // and nothing else. A single-provider run that met the quota during
    // complexity classification went straight on to call the same dead account
    // for every later tier — the verdict read correctly and stopped nothing.
    const { OpenAIProvider } = await import('../../providers/openai.js');

    const openaiStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['openai']));
    await router.init(makeConfig({ providers: [{ type: 'openai', apiKey: 'sk-test' }] }));

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    const call = () => router.generate('T1', { messages: [{ role: 'user', content: 'x' }], model: pinned, maxTokens: 64 });

    await expect(call()).rejects.toThrow(/will not recover on its own/);
    expect(openaiStream).toHaveBeenCalledTimes(1);

    // The second call must be refused from the verdict, not by asking again.
    await expect(call()).rejects.toThrow(/will not recover on its own/);
    expect(openaiStream).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it('hands the provider back at the next run boundary', async () => {
    // The verdict is RUN-scoped, and the router outlives a run in the REPL and
    // the desktop app. Without a clear at the boundary it would last the whole
    // process, so topping up an account would change nothing until restart.
    const { OpenAIProvider } = await import('../../providers/openai.js');

    const openaiStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['openai']));
    await router.init(makeConfig({ providers: [{ type: 'openai', apiKey: 'sk-test' }] }));

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    const call = () => router.generate('T1', { messages: [{ role: 'user', content: 'x' }], model: pinned, maxTokens: 64 });

    await expect(call()).rejects.toThrow();
    expect(openaiStream).toHaveBeenCalledTimes(1);

    // The account is topped up; the next run must actually try it again.
    openaiStream.mockResolvedValue({
      content: 'topped up', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);
    router.beginRun();

    await expect(call()).resolves.toMatchObject({ content: 'topped up' });
    expect(openaiStream).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it('one dead Azure resource still lets a separate resource serve the request', async () => {
    // Azure deliberately supports several deployments, each able to carry its
    // own resource, endpoint and key — ensureProvider() binds a config entry
    // per deployment for exactly that reason. Keying the verdict on the
    // provider enum made a quota failure on one resource disqualify every
    // healthy sibling as a fallback.
    // AzureOpenAIProvider inherits generateStream from OpenAIProvider, and each
    // deployment gets its own instance bound to its own model — so `this.model.id`
    // is the deployment, which is exactly the identity the verdict must key on.
    const { OpenAIProvider } = await import('../../providers/openai.js');

    const azureStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockImplementation(function (this: { model?: { id?: string } }) {
        if (this?.model?.id === 'dead-resource') {
          return Promise.reject(new Error('insufficient_quota: your credit balance is too low'));
        }
        return Promise.resolve({
          content: 'from the healthy resource',
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'stop',
        }) as never;
      } as never);

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['azure']));
    await router.init(makeConfig({
      providers: [
        { type: 'azure', deploymentName: 'dead-resource', apiKey: 'k1', baseUrl: 'https://a.openai.azure.com' },
        { type: 'azure', deploymentName: 'healthy-resource', apiKey: 'k2', baseUrl: 'https://b.openai.azure.com' },
      ],
    }));

    const dead = router.getAvailableModels().find((m) => m.id === 'dead-resource');
    const healthy = router.getAvailableModels().find((m) => m.id === 'healthy-resource');
    expect(dead).toBeDefined();
    expect(healthy).toBeDefined();

    const failover = failoverOf(router);
    await router.generate('T1', { messages: [{ role: 'user', content: 'x' }], model: dead, maxTokens: 64 })
      .catch(() => { /* whether it fails over or throws, the scoping is the subject */ });

    // The dead deployment is out; its sibling is untouched and still usable.
    expect(failover.isPermanentlyFailed('azure:https://a.openai.azure.com')).toBe(true);
    expect(failover.isPermanentlyFailed('azure:https://b.openai.azure.com')).toBe(false);

    const result = await router.generate('T1', {
      messages: [{ role: 'user', content: 'y' }], model: healthy, maxTokens: 64,
    });
    expect(result.content).toBe('from the healthy resource');

    azureStream.mockRestore();
    vi.restoreAllMocks();
  });

  it('a resource-scoped verdict takes that resource out of SELECTION', async () => {
    // A narrow verdict deliberately never calls markProviderUnavailable — that
    // would take the healthy siblings with it — so nothing in the selector
    // knows the deployment is out unless it is told. Asserted directly on the
    // selector, because going through generate() would repoint the tier via
    // the ordinary failover path and never exercise this.
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['azure']));
    await router.init(makeConfig({
      providers: [
        { type: 'azure', deploymentName: 'dead-resource', apiKey: 'k1', baseUrl: 'https://a.openai.azure.com' },
        { type: 'azure', deploymentName: 'healthy-resource', apiKey: 'k2', baseUrl: 'https://b.openai.azure.com' },
      ],
    }));

    const selector = selectorOf(router);
    // It is the tier's default pick to begin with — otherwise this proves nothing.
    expect(selector.selectForTier('T1')?.id).toBe('dead-resource');

    failoverOf(router).recordFailure('azure', 'quota exhausted', {
      permanent: true, scope: 'azure:https://a.openai.azure.com',
    });

    expect(selector.selectForTier('T1')?.id).toBe('healthy-resource');
    expect(selector.getNextFallback('dead-resource', 'T1')?.id).toBe('healthy-resource');
  });

  it('selection routes around a dead Azure resource without an explicit pin', async () => {
    // The case the model veto exists for, and the one the two tests above do
    // NOT reach: a deployment-scoped verdict never calls
    // markProviderUnavailable (that would take out the healthy siblings too),
    // so nothing in the selector knows the deployment is out unless the veto
    // tells it. Without one, selection hands the dead deployment straight back.
    const { OpenAIProvider } = await import('../../providers/openai.js');

    const azureStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockImplementation(function (this: { model?: { id?: string } }) {
        if (this?.model?.id === 'dead-resource') {
          return Promise.reject(new Error('insufficient_quota: your credit balance is too low'));
        }
        return Promise.resolve({
          content: 'from the healthy resource',
          usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
        }) as never;
      } as never);

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['azure']));
    await router.init(makeConfig({
      providers: [
        { type: 'azure', deploymentName: 'dead-resource', apiKey: 'k1', baseUrl: 'https://a.openai.azure.com' },
        { type: 'azure', deploymentName: 'healthy-resource', apiKey: 'k2', baseUrl: 'https://b.openai.azure.com' },
      ],
    }));

    const dead = router.getAvailableModels().find((m) => m.id === 'dead-resource');
    // Bind the tier to the deployment that is about to die, the way init's
    // Azure tier-fill does — then let the tier resolve on its own from here.
    (router as unknown as { tierModels: Map<string, unknown> }).tierModels.set('T1', dead);

    await router.generate('T1', { messages: [{ role: 'user', content: 'a' }], maxTokens: 64 })
      .catch(() => { /* the first call is what earns the verdict */ });
    expect(failoverOf(router).isPermanentlyFailed('azure:https://a.openai.azure.com')).toBe(true);

    // No pin. Selection must skip the dead deployment and find its sibling.
    const result = await router.generate('T1', { messages: [{ role: 'user', content: 'b' }], maxTokens: 64 });
    expect(result.content).toBe('from the healthy resource');

    azureStream.mockRestore();
    vi.restoreAllMocks();
  });

  it('a sibling tier still bound to the dead provider does not call it', async () => {
    // markProviderUnavailable only affects selector-based picks, so cached
    // T1/T2 entries pointing at the provider T3 just killed would each go and
    // rediscover the same dead account.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    const openaiStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'served elsewhere', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
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

    const openaiModel = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    // Bind a SECOND tier to the same provider, the way init's tier-fill would.
    (router as unknown as { tierModels: Map<string, unknown> }).tierModels.set('T2', openaiModel);

    // T3 discovers the dead account.
    await router.generate('T3', { messages: [{ role: 'user', content: 'a' }], model: openaiModel, maxTokens: 64 });
    expect(openaiStream).toHaveBeenCalledTimes(1);

    // T2 is still bound to it. It must not go and find out for itself.
    const t2 = await router.generate('T2', { messages: [{ role: 'user', content: 'b' }], maxTokens: 64 });
    expect(t2.content).toBe('served elsewhere');
    expect(openaiStream).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it('puts the tier back on the restored provider at the next run, with no pin', async () => {
    // Review finding: clearing the verdict only makes the provider SELECTABLE.
    // generate() resolves tierModels.get(tier) before it ever asks the
    // selector, so a tier still holding the fallback keeps charging the
    // fallback account for every later default-routed run. Deliberately
    // UNPINNED — the earlier boundary test pinned the original model, which
    // masked exactly this.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    const openaiStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));
    const anthropicStream = vi.spyOn(AnthropicProvider.prototype, 'generateStream')
      .mockResolvedValue({
        content: 'from the fallback', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
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

    const openaiModel = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    // Bind the tier the way init's tier-fill does — model AND provider instance.
    (router as unknown as { tierModels: Map<string, unknown> }).tierModels.set('T1', openaiModel);
    (router as unknown as { ensureProvider(m: unknown, c: unknown): void })
      .ensureProvider(openaiModel, [{ type: 'openai', apiKey: 'sk-test' }]);

    // Run 1: the account dies and the tier is repointed at anthropic.
    const first = await router.generate('T1', { messages: [{ role: 'user', content: 'a' }], maxTokens: 64 });
    expect(first.content).toBe('from the fallback');

    // The account is topped up between runs.
    openaiStream.mockResolvedValue({
      content: 'from the restored account', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);
    router.beginRun();

    // Run 2, default-routed: the traffic must go back, not stay on the fallback.
    const second = await router.generate('T1', { messages: [{ role: 'user', content: 'b' }], maxTokens: 64 });
    expect(second.content).toBe('from the restored account');
    expect(anthropicStream).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });

  it('a straggler from the previous run cannot steer the new one', async () => {
    // A call admitted by run A can still be settling when run B starts.
    // Guarding only the `permanent` bit left everything else: a 30s transient
    // failover entry, markProviderUnavailable() for a provider-wide scope, and
    // a repointed tier — all installed on run B from run A's dead result.
    //
    // The earlier version of this test asserted only isPermanentlyFailed, which
    // stayed false throughout and so proved none of that.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    let releaseStraggler: ((e: unknown) => void) | undefined;
    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockImplementation(() => new Promise((_res, rej) => { releaseStraggler = rej; }) as never);
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
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

    const openaiModel = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    // Run A submits a call that will not settle until we say so.
    const inFlight = router.generate('T1', {
      messages: [{ role: 'user', content: 'a' }], model: openaiModel, maxTokens: 64,
    }).catch(() => undefined);

    // Let it actually reach the provider — otherwise there is no straggler.
    for (let i = 0; i < 50 && !releaseStraggler; i++) {
      await new Promise((r) => setImmediate(r));
    }

    // Run B begins, and we snapshot everything its routing depends on.
    router.beginRun();
    const selector = selectorOf(router);
    const tierBefore = router.getModelForTier('T1')?.id;
    const pickBefore = selector.selectForTier('T1')?.id;
    const failover = failoverOf(router);

    // NOW run A comes back, with a failure that would ordinarily repoint a tier
    // and pull the provider.
    expect(releaseStraggler).toBeDefined();
    releaseStraggler!(new Error('insufficient_quota: your credit balance is too low'));
    await inFlight;

    // Nothing about run B moved: no verdict, no transient backoff, no provider
    // removed from selection, no tier rebound.
    expect(failover.isPermanentlyFailed('openai')).toBe(false);
    expect(failover.isProviderAvailable('openai')).toBe(true);
    expect(selector.selectForTier('T1')?.id).toBe(pickBefore);
    expect(router.getModelForTier('T1')?.id).toBe(tierBefore);

    vi.restoreAllMocks();
  });
  it('does not ask a dead account twice for one streaming call', async () => {
    // Review finding: on a stream rejection the cloud branch fell back to
    // provider.generate(), and the built-in providers implement generate() by
    // calling generateStream() again — so one logical call hit the exhausted
    // account twice, doubled again across a concurrent wave.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    const openaiStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));
    // generate() delegating to generateStream is what makes the double-call
    // real, so model that faithfully rather than stubbing it away.
    const openaiGenerate = vi.spyOn(OpenAIProvider.prototype, 'generate')
      .mockImplementation(function (this: OpenAIProvider, ...args: unknown[]) {
        return (this.generateStream as unknown as (...a: unknown[]) => Promise<never>)(args[0], () => undefined);
      } as never);
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
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

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    // onChunk present ⇒ the streaming path, which is what the CLI and the
    // hosted client both use.
    const result = await router.generate(
      'T1',
      { messages: [{ role: 'user', content: 'hi' }], model: pinned, maxTokens: 64 },
      () => undefined,
    );

    expect(result.content).toBe('from fallback');
    // Exactly one request to the dead account, not two.
    expect(openaiStream).toHaveBeenCalledTimes(1);
    expect(openaiGenerate).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('fails over on a model-scoped 403 instead of rethrowing', async () => {
    // Classifying "Project does not have access to model gpt-5" as
    // model_unavailable stopped it killing the whole provider — but the
    // routing branch only handled quota/auth/rate limits and
    // isModelNotFoundError's regex does not match that wording, so it was
    // rethrown with a healthy fallback sitting right there.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    // Only THIS model is refused. That is what "model-scoped" means: the
    // credential is fine, so the right move is another model on the same
    // provider — not condemning the account and moving the spend elsewhere.
    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockImplementation(function (this: { model?: { id?: string } }) {
        if (this?.model?.id === 'gpt-4o') {
          return Promise.reject(Object.assign(
            new Error('Project does not have access to model gpt-4o'), { status: 403 },
          ));
        }
        return Promise.resolve({
          content: 'from another model on the same key',
          usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
        }) as never;
      } as never);
    const anthropicStream = vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'from a different provider', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
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

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    const result = await router.generate('T1', {
      messages: [{ role: 'user', content: 'hi' }], model: pinned, maxTokens: 64,
    });

    expect(result.content).toBe('from another model on the same key');
    // The credential is NOT condemned — only this model was — so the spend
    // never had to move to a different account at all.
    expect(failoverOf(router).isPermanentlyFailed('openai')).toBe(false);
    expect(anthropicStream).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('two deployments on ONE resource share the verdict, because they share the key', async () => {
    // Review finding: Azure keys are resource-scoped —
    // config/global-credentials spreads one resource key across every
    // deployment on that endpoint, and has a test saying so. Keying per
    // deployment let fallback pick the sibling on the same endpoint and issue
    // a second request that could not possibly work.
    const { OpenAIProvider } = await import('../../providers/openai.js');

    const azureStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['azure']));
    await router.init(makeConfig({
      providers: [
        { type: 'azure', deploymentName: 'gpt-4o', apiKey: 'key-r1', baseUrl: 'https://r1.openai.azure.com' },
        { type: 'azure', deploymentName: 'gpt-4o-mini', apiKey: 'key-r1', baseUrl: 'https://r1.openai.azure.com' },
      ],
    }));

    const first = router.getAvailableModels().find((m) => m.id === 'gpt-4o');
    await router.generate('T1', { messages: [{ role: 'user', content: 'x' }], model: first, maxTokens: 64 })
      .catch(() => { /* earning the verdict is the point */ });

    // One verdict, covering the whole resource…
    expect(failoverOf(router).isPermanentlyFailed('azure:https://r1.openai.azure.com')).toBe(true);
    // …so the sibling deployment is out too, and selection will not offer it.
    const sibling = router.getAvailableModels().find((m) => m.id === 'gpt-4o-mini')!;
    expect(selectorOf(router).getNextFallback('gpt-4o', 'T1')).toBeNull();

    const callsBefore = azureStream.mock.calls.length;
    await router.generate('T1', { messages: [{ role: 'user', content: 'y' }], model: sibling, maxTokens: 64 })
      .catch(() => { /* refused from the verdict, not by asking */ });
    expect(azureStream.mock.calls.length).toBe(callsBefore);

    vi.restoreAllMocks();
  });

  it('a TRANSIENT scoped failure is enforced in selection, then expires', async () => {
    // A scoped verdict deliberately does not call markProviderUnavailable —
    // that would take the resource's healthy siblings with it — so a veto that
    // only looked at permanent verdicts left an Azure rate limit recorded and
    // then completely ignored.
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['azure']));
    await router.init(makeConfig({
      providers: [
        { type: 'azure', deploymentName: 'busy', apiKey: 'k1', baseUrl: 'https://r1.openai.azure.com' },
        { type: 'azure', deploymentName: 'quiet', apiKey: 'k2', baseUrl: 'https://r2.openai.azure.com' },
      ],
    }));

    const selector = selectorOf(router);
    expect(selector.selectForTier('T1')?.id).toBe('busy');

    vi.useFakeTimers();
    try {
      // An ORDINARY rate limit — not permanent.
      failoverOf(router).recordFailure('azure', 'rate limit', { scope: 'azure:https://r1.openai.azure.com' });

      expect(selector.selectForTier('T1')?.id).toBe('quiet');

      // …and the existing expiry brings it back on its own.
      vi.advanceTimersByTime(30_001);
      expect(selector.selectForTier('T1')?.id).toBe('busy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never hands an image to a model whose credential is out', async () => {
    // selectVisionModel() is the SOLE path a vision-required call resolves
    // through, and it read `availableProviders` directly rather than going via
    // isUsable() — making it the one selection route that ignored the model
    // veto. A resource-scoped verdict deliberately does not pull the provider,
    // so nothing else would have stopped the image going to the dead account.
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['azure']));
    await router.init(makeConfig({
      providers: [
        { type: 'azure', deploymentName: 'gpt-4o', apiKey: 'k1', baseUrl: 'https://r1.openai.azure.com' },
        { type: 'azure', deploymentName: 'backup-gpt-4o', apiKey: 'k2', baseUrl: 'https://r2.openai.azure.com' },
      ],
    }));

    const selector = (router as unknown as {
      selector: { selectVisionModel(): { id: string } | null };
    }).selector;

    // Both deployments can see, and the dead one is the preferred pick.
    const all = router.getAvailableModels();
    expect(all.filter((m) => m.isVisionCapable).map((m) => m.id).sort())
      .toEqual(['backup-gpt-4o', 'gpt-4o']);
    expect(selector.selectVisionModel()?.id).toBe('gpt-4o');

    failoverOf(router).recordFailure('azure', 'quota exhausted', {
      permanent: true, scope: 'azure:https://r1.openai.azure.com',
    });

    // The replacement must still be able to see — not merely be available.
    const replacement = selector.selectVisionModel();
    expect(replacement?.id).toBe('backup-gpt-4o');
    expect(all.find((m) => m.id === replacement?.id)?.isVisionCapable).toBe(true);
  });

  it('reports the model that actually served, not the one that was asked for', async () => {
    // Review finding: callers that REPORT a model — tier:status, which the
    // hosted server persists onto the assistant message and which /why and
    // thumbs feedback then read — had no way to learn about a mid-call
    // failover, so the credit went to a model that never ran.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
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

    const asked = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    const result = await router.generate('T1', {
      messages: [{ role: 'user', content: 'hi' }], model: asked, maxTokens: 64,
    });

    expect(result.content).toBe('from fallback');
    expect(result.servedBy).toBeDefined();
    expect(result.servedBy!.provider).toBe('anthropic');
    expect(result.servedBy!.id).not.toBe('gpt-4o');

    vi.restoreAllMocks();
  });

  it('reports the pinned model when no failover happened', async () => {
    // The other half: with a per-call pin and no failover, the tier's own
    // binding is NOT what served, so reading it back off the tier would be
    // wrong in the ordinary case.
    const { OpenAIProvider } = await import('../../providers/openai.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['openai']));
    await router.init(makeConfig({ providers: [{ type: 'openai', apiKey: 'sk-test' }] }));

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o-mini');
    const result = await router.generate('T1', {
      messages: [{ role: 'user', content: 'hi' }], model: pinned, maxTokens: 64,
    });

    expect(result.servedBy).toEqual({ provider: 'openai', id: 'gpt-4o-mini' });
    // And it is genuinely different from the tier's own binding.
    expect(router.getModelForTier('T1')?.id).not.toBe('gpt-4o-mini');

    vi.restoreAllMocks();
  });

  it('restores the tier BASELINE, not a one-off per-call override', async () => {
    // Review finding: recording the model that failed meant a Cascade Auto
    // per-subtask override, once it failed permanently, was installed by
    // beginRun() as the tier's baseline — leaving every later default-routed
    // call on a model the tier was never configured to use.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
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

    // The tier's configured baseline…
    const baseline = router.getAvailableModels().find((m) => m.provider === 'anthropic')!;
    (router as unknown as { tierModels: Map<string, unknown> }).tierModels.set('T1', baseline);

    // …and a DIFFERENT, one-off per-call override that is about to die.
    const oneOff = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o')!;
    await router.generate('T1', {
      messages: [{ role: 'user', content: 'x' }], model: oneOff, maxTokens: 64,
    }).catch(() => undefined);

    router.beginRun();

    // The baseline comes back — not the subtask model that happened to fail.
    expect(router.getModelForTier('T1')?.id).toBe(baseline.id);
    expect(router.getModelForTier('T1')?.id).not.toBe('gpt-4o');

    vi.restoreAllMocks();
  });

  it('identifies the Azure resource regardless of trailing slashes or case', async () => {
    // The scope is derived through utils/net.ts normalizeEndpoint rather than a
    // hand-rolled trim: `replace(/\/+$/, '')` is polynomial and CodeQL flags it
    // as a ReDoS risk wherever caller-supplied input reaches it, which a
    // configured baseUrl does. The behaviour that matters is here — two
    // spellings of one endpoint must be ONE credential, or a verdict recorded
    // under one spelling silently fails to cover the other.
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['azure']));
    await router.init(makeConfig({
      providers: [
        { type: 'azure', deploymentName: 'a', apiKey: 'k', baseUrl: 'https://R1.OpenAI.Azure.com///' },
        { type: 'azure', deploymentName: 'b', apiKey: 'k', baseUrl: 'https://r1.openai.azure.com' },
      ],
    }));

    const scopeFor = (router as unknown as { scopeFor(m: unknown): string }).scopeFor.bind(router);
    const a = router.getAvailableModels().find((m) => m.id === 'a');
    const b = router.getAvailableModels().find((m) => m.id === 'b');

    // Same resource, written two ways — one scope.
    expect(scopeFor(a)).toBe(scopeFor(b));
    expect(scopeFor(a)).not.toContain('///');
  });

  it('keeps two tenant routes on one gateway as separate credentials', () => {
    // The old normalization lowercased the WHOLE url, path included, so
    // https://gw.example/TenantA and /tenanta collapsed to one scope — meaning
    // a verdict earned by one tenant's credential silently condemned the
    // other's. utils/net.ts lowercases scheme and host only, and says why in
    // as many words. Same over-broadening this PR has been narrowing all
    // along, one level further down.
    const router = new CascadeRouter();
    const scopeFor = (router as unknown as { scopeFor(m: unknown): string }).scopeFor.bind(router);
    (router as unknown as { config: unknown }).config = {
      providers: [
        { type: 'azure', deploymentName: 'a', apiKey: 'k1', baseUrl: 'https://gw.example/TenantA' },
        { type: 'azure', deploymentName: 'b', apiKey: 'k2', baseUrl: 'https://gw.example/tenanta' },
      ],
    };

    const a = scopeFor({ provider: 'azure', id: 'a' });
    const b = scopeFor({ provider: 'azure', id: 'b' });
    expect(a).not.toBe(b);
  });

  it('scopes a rejected KEY to that key, and a spent quota to the resource', async () => {
    // The two systemic failures have different blast radii on one endpoint.
    // Billing belongs to the resource — deployments there draw on the same
    // subscription even with separate keys. A rejected credential belongs to
    // the key: a 401 on a rotated one says nothing about its neighbour.
    const router = new CascadeRouter();
    (router as unknown as { config: unknown }).config = {
      providers: [
        { type: 'azure', deploymentName: 'a', apiKey: 'key-one', baseUrl: 'https://r1.openai.azure.com' },
        { type: 'azure', deploymentName: 'b', apiKey: 'key-two', baseUrl: 'https://r1.openai.azure.com' },
      ],
    };
    const inner = router as unknown as {
      scopeForFailure(m: unknown, kind: string): string;
      scopesFor(m: unknown): string[];
    };
    const a = { provider: 'azure', id: 'a' };
    const b = { provider: 'azure', id: 'b' };

    // Same resource, different keys.
    expect(inner.scopeForFailure(a, 'quota_exhausted')).toBe(inner.scopeForFailure(b, 'quota_exhausted'));
    expect(inner.scopeForFailure(a, 'auth')).not.toBe(inner.scopeForFailure(b, 'auth'));

    // And "is this model out?" consults both, or a verdict filed under one
    // would be invisible to the other.
    expect(inner.scopesFor(a)).toContain(inner.scopeForFailure(a, 'quota_exhausted'));
    expect(inner.scopesFor(a)).toContain(inner.scopeForFailure(a, 'auth'));
  });

  it('does not durably retire a model the key merely lacks access to', async () => {
    // A 403 is this credential's authorization, not a fact about the model id.
    // Persisting it to the 7-day DeadModelStore kept removing a usable model
    // across later runs and process restarts, even after the user granted the
    // project access or swapped in a key that already had it.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockImplementation(function (this: { model?: { id?: string } }) {
        if (this?.model?.id === 'gpt-4o') {
          return Promise.reject(Object.assign(
            new Error('Project does not have access to model gpt-4o'), { status: 403 },
          ));
        }
        return Promise.resolve({
          content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
        }) as never;
      } as never);
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
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

    const deadModels = (router as unknown as { deadModels: { isDead(p: string, id: string): boolean } }).deadModels;
    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');

    await router.generate('T1', { messages: [{ role: 'user', content: 'hi' }], model: pinned, maxTokens: 64 });

    // It failed over for this request…
    expect(deadModels.isDead('openai', 'gpt-4o')).toBe(false);

    vi.restoreAllMocks();
  });

  it('keeps a tool-capable model when a tool call fails over', async () => {
    // The caller picked native-tool vs text-tool mode from the ORIGINAL model
    // and shaped the request around it. A tool-less replacement leaves that
    // request's `tools` unanswerable and the worker free to reply without
    // doing the work. servedBy is what makes this observable.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
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

    // Make the model the ordinary fallback would reach FIRST tool-less, and
    // leave exactly one capable alternative behind it.
    const anthropicModels = router.getAvailableModels().filter((m) => m.provider === 'anthropic');
    expect(anthropicModels.length).toBeGreaterThan(1);
    for (const m of anthropicModels) (m as { supportsToolUse?: boolean }).supportsToolUse = false;
    const capable = anthropicModels[anthropicModels.length - 1]!;
    (capable as { supportsToolUse?: boolean }).supportsToolUse = true;

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');
    const result = await router.generate('T1', {
      messages: [{ role: 'user', content: 'hi' }],
      model: pinned,
      maxTokens: 64,
      tools: [{ name: 'read_file', description: 'x', inputSchema: { type: 'object' } }],
    } as never);

    expect(result.servedBy).toBeDefined();
    const served = router.getAvailableModels().find((m) => m.id === result.servedBy!.id);
    expect(served, `served ${result.servedBy!.id}`).toBeDefined();
    expect(served!.supportsToolUse).not.toBe(false);

    vi.restoreAllMocks();
  });

  it('restores the CONFIGURED baseline after a Cascade Auto override fails', async () => {
    // overrideTierModel() stashes the configured baseline in originalTierModels
    // and overwrites tierModels with a per-task pick. Reading tierModels when
    // recording the repoint captured that pick, so beginRun() installed a model
    // chosen for the PREVIOUS task as the tier's baseline — before the next
    // task had even been classified.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));
    vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
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

    // The tier's CONFIGURED baseline.
    const baseline = router.getAvailableModels().find((m) => m.provider === 'anthropic')!;
    (router as unknown as { tierModels: Map<string, unknown> }).tierModels.set('T1', baseline);

    // Cascade Auto picks something else for this one task, the proper way.
    const autoPick = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o')!;
    router.overrideTierModel('T1', autoPick);
    expect(router.getModelForTier('T1')?.id).toBe(autoPick.id);

    // That per-task pick is the one that dies.
    await router.generate('T1', { messages: [{ role: 'user', content: 'x' }], maxTokens: 64 })
      .catch(() => undefined);

    router.beginRun();

    // The CONFIGURED baseline comes back — not the model Auto chose for a task
    // that is already over.
    expect(router.getModelForTier('T1')?.id).toBe(baseline.id);
    expect(router.getModelForTier('T1')?.id).not.toBe(autoPick.id);

    vi.restoreAllMocks();
  });
  it('does not submit a call that was queued when the verdict landed', async () => {
    // The concurrent-wave case the verdict exists for. The check at model
    // resolution runs BEFORE the TPM bucket and the local queue, either of
    // which can hold a call for a refill interval — and that is exactly when a
    // sibling discovers the account is dead. Every worker already past the
    // first check would otherwise still submit.
    const { OpenAIProvider } = await import('../../providers/openai.js');

    const openaiStream = vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockResolvedValue({
        content: 'should never be reached', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
      } as never);

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['openai']));
    await router.init(makeConfig({ providers: [{ type: 'openai', apiKey: 'sk-test' }] }));

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');

    // Stand in for "a sibling recorded the verdict while this call waited":
    // the TPM acquire is the wait, and the verdict lands during it.
    const limiter = (router as unknown as {
      tpmLimiter: { acquire(p: string, n: number, s?: AbortSignal): Promise<void> };
    }).tpmLimiter;
    const realAcquire = limiter.acquire.bind(limiter);
    limiter.acquire = async (p: string, n: number, sig?: AbortSignal) => {
      await realAcquire(p, n, sig);
      failoverOf(router).recordFailure('openai', 'quota exhausted', {
        permanent: true, detail: 'Quota or billing limit reached. This will not recover on its own.',
      });
    };

    await expect(
      router.generate('T1', { messages: [{ role: 'user', content: 'hi' }], model: pinned, maxTokens: 64 }),
    ).rejects.toThrow(/will not recover on its own/);

    // The provider was never asked.
    expect(openaiStream).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('names the model a VISION retry will actually use', async () => {
    // A vision call's retry re-resolves through selectVisionModel() and ignores
    // the tier binding, so announcing the ordinary tier fallback named an
    // account that never receives the work — while telling the user their
    // spend had moved there.
    const { OpenAIProvider } = await import('../../providers/openai.js');
    const { AnthropicProvider } = await import('../../providers/anthropic.js');

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['openai', 'anthropic']));
    await router.init(makeConfig({
      providers: [
        { type: 'openai', apiKey: 'sk-test' },
        { type: 'anthropic', apiKey: 'sk-ant-test' },
      ],
    }));

    // Fail whichever model the vision path ACTUALLY resolves to first, rather
    // than assuming which provider wins the vision priority list.
    const selector = (router as unknown as {
      selector: {
        selectVisionModel(): { id: string; provider: string } | null;
        getNextFallback(id: string, t: string): { id: string } | null;
      };
    }).selector;
    const firstVision = selector.selectVisionModel();
    expect(firstVision).not.toBeNull();

    // Force the ordinary tier fallback and the vision pick APART, and force it
    // to hold AFTER the verdict — the verdict condemns the failing provider, so
    // a divergence computed beforehand evaporates once that provider is out.
    //
    // The surviving provider's FIRST model loses vision and its LAST keeps it:
    // getNextFallback then lands on the first (blind) while selectVisionModel
    // lands on the last. Announcing the former would name a model that never
    // serves.
    const all = router.getAvailableModels();
    const survivors = all.filter((m) => m.provider !== firstVision!.provider);
    expect(survivors.length, 'fixture needs several models on a second provider')
      .toBeGreaterThan(1);
    const backupVision = survivors[survivors.length - 1]!;
    for (const m of all) {
      (m as { isVisionCapable: boolean }).isVisionCapable =
        m.id === firstVision!.id || m.id === backupVision.id;
    }
    expect((survivors[0] as { isVisionCapable: boolean }).isVisionCapable).toBe(false);

    const dead = (self: { model?: { id?: string } }) =>
      self?.model?.id === firstVision!.id
        ? Promise.reject(new Error('insufficient_quota: your credit balance is too low'))
        : Promise.resolve({
            content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
          }) as never;
    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockImplementation(function (this: { model?: { id?: string } }) { return dead(this); } as never);
    vi.spyOn(AnthropicProvider.prototype, 'generateStream')
      .mockImplementation(function (this: { model?: { id?: string } }) { return dead(this); } as never);

    const seen: Array<Record<string, unknown>> = [];
    router.on('provider:exhausted', (e: Record<string, unknown>) => seen.push(e));

    const result = await router.generate(
      'T1',
      { messages: [{ role: 'user', content: 'what is in this image' }], maxTokens: 64 },
      undefined,
      true, // requireVision
    );

    expect(seen).toHaveLength(1);
    const announced = String(seen[0]!['failedOverTo']);
    expect(announced).toBeTruthy();
    // What was announced is what actually served — and it can see.
    expect(result.servedBy).toBeDefined();
    expect(announced).toBe(`${result.servedBy!.provider}:${result.servedBy!.id}`);
    const served = router.getAvailableModels().find((m) => m.id === result.servedBy!.id);
    expect(served?.isVisionCapable).toBe(true);

    vi.restoreAllMocks();
  });

  it('explains the dead account when no other provider can serve the tier', async () => {
    // The case that matters most, and the one the old code handled worst: with
    // nothing to fail over to it re-threw the raw vendor string, which says
    // nothing about which of the user's accounts to go and look at.
    const { OpenAIProvider } = await import('../../providers/openai.js');

    vi.spyOn(OpenAIProvider.prototype, 'generateStream')
      .mockRejectedValue(new Error('insufficient_quota: your credit balance is too low'));

    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
      vi.fn().mockResolvedValue(new Set(['openai']));
    await router.init(makeConfig({ providers: [{ type: 'openai', apiKey: 'sk-test' }] }));

    const pinned = router.getAvailableModels().find((m) => m.provider === 'openai' && m.id === 'gpt-4o');

    await expect(
      router.generate('T1', { messages: [{ role: 'user', content: 'hi' }], model: pinned }),
    ).rejects.toThrow(/will not recover on its own/);

    vi.restoreAllMocks();
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

  it('releases a secret on a real timer, with no later lookup to trigger it', () => {
    // Retention used to be bounded only by the NEXT lookup: `sweepExpired()`
    // ran from `credentialIdentity()` and nowhere else, so a process that
    // inserted a credential, had it rotated, and then went idle held the old
    // value until it exited. The documented fifteen-minute retention was really
    // "until someone asks again, whenever that is".
    // Reset FIRST, so the sweep interval is armed under the fake clock rather
    // than one an earlier test left running on the real one.
    resetCredentialIdentitiesForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));

    const secret = 'sk-raw-secret-value-should-not-be-retained';
    discoveryCacheKey('anthropic', { type: 'anthropic', apiKey: secret });
    expect(credentialIdentityKeys()).toContain(secret);

    // Time passes and NOTHING calls back in — exactly the idle case.
    vi.advanceTimersByTime(TTL_MS * 2);

    expect(credentialIdentityKeys()).not.toContain(secret);
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
