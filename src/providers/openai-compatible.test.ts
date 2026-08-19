import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ModelInfo } from '../types.js';

const seed: ModelInfo = {
  id: 'openai-compatible', name: 'openai-compatible', provider: 'openai-compatible',
  contextWindow: 32_000, isVisionCapable: false,
  inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
  maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
};

describe('OpenAICompatibleProvider construction', () => {
  const prevKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  });

  it('constructs without an apiKey and with no OPENAI_API_KEY env var set', () => {
    // Regression: local servers (llama.cpp / LM Studio / vLLM without
    // --api-key) need no key, so config.apiKey is legitimately undefined.
    // The underlying `openai` SDK throws in its own constructor whenever
    // apiKey is undefined and OPENAI_API_KEY isn't set in the environment —
    // and that constructor ran via `super(config, model)` before this
    // subclass could apply its "not-required" fallback, so every endpoint
    // discovery attempt threw regardless of the configured base URL.
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAICompatibleProvider(
      { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:8900/v1' },
      seed,
    )).not.toThrow();
  });
});

// The provider talks to the endpoint through utils/net's nodeHttpFetch (the
// Electron main process can't always reach loopback via global fetch), so that
// is what has to be stubbed for a listModels() test.
vi.mock('../utils/net.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/net.js')>();
  return {
    ...actual,
    nodeHttpFetch: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'qwen3-30b-instruct' }] }),
    })),
  };
});

describe('OpenAICompatibleProvider listModels — local vs hosted pricing', () => {
  it('marks models from a loopback endpoint as genuinely local and free', async () => {
    const p = new OpenAICompatibleProvider(
      { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:8900/v1' },
      seed,
    );
    const [m] = await p.listModels();
    expect(m!.isLocal).toBe(true);
    expect(m!.inputCostPer1kTokens).toBe(0);
    expect(m!.pricingUnknown).toBe(false);
  });

  it('marks an unpriced HOSTED endpoint as cost-unknown, not free', async () => {
    const p = new OpenAICompatibleProvider(
      { type: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', apiKey: 'k' },
      seed,
    );
    const [m] = await p.listModels();
    expect(m!.isLocal).toBe(false);
    expect(m!.pricingUnknown).toBe(true);
  });

  it('honours an explicit local override on a non-loopback host', async () => {
    const p = new OpenAICompatibleProvider(
      { type: 'openai-compatible', baseUrl: 'https://gpu.mycorp.example/v1', apiKey: 'k', local: true },
      seed,
    );
    const [m] = await p.listModels();
    expect(m!.isLocal).toBe(true);
    expect(m!.pricingUnknown).toBe(false);
  });
});

describe('an OpenAI-compatible provider must name its endpoint', () => {
  // The OpenAI SDK defaults `baseURL` to api.openai.com, so an endpointless row
  // does not fail — it succeeds against the wrong host. The settings writers
  // refuse to create one, but `createCascade()` validates against
  // `ProviderConfigSchema`, where `baseUrl` is optional, so a programmatic
  // config reaches the constructor having passed none of those guards.
  const model = {
    id: 'seed', name: 'seed', provider: 'openai-compatible' as const,
    contextWindow: 32_000, isVisionCapable: false,
    inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
    maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
  };

  it('refuses a key with nowhere to send it', () => {
    expect(() => new OpenAICompatibleProvider({ type: 'openai-compatible', apiKey: 'groq-key' }, model))
      .toThrow(/requires `baseUrl`/);
  });

  it('refuses a keyless one too — "no key" is not "no address"', () => {
    expect(() => new OpenAICompatibleProvider({ type: 'openai-compatible' }, model))
      .toThrow(/requires `baseUrl`/);
  });

  it('accepts one that names its host', () => {
    expect(() => new OpenAICompatibleProvider(
      { type: 'openai-compatible', apiKey: 'k', baseUrl: 'https://api.groq.com/openai/v1' }, model,
    )).not.toThrow();
  });
});
