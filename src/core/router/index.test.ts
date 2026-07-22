// ─────────────────────────────────────────────
//  Cascade AI — router OpenAI-compatible discovery
// ─────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CascadeRouter } from './index.js';
import type { CascadeConfig } from '../../types.js';

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
