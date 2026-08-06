// ─────────────────────────────────────────────
//  Cascade AI — Model Profiler
// ─────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelProfiler } from './model-profiler.js';
import type { ModelInfo } from '../../types.js';
import type { CascadeRouter } from './index.js';
import type { MemoryStore } from '../../memory/store.js';

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'gpt-4o', name: 'GPT-4o', provider: 'openai',
    contextWindow: 8_000, isVisionCapable: false,
    inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
    maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: false, isLocal: false,
    ...overrides,
  };
}

function makeStore(): MemoryStore {
  return {
    getProfiledModelIds: () => [],
    saveModelProfile: vi.fn(),
  } as unknown as MemoryStore;
}

function makeRouter(t3Model: ModelInfo | undefined, generateResult: unknown): CascadeRouter {
  return {
    generate: vi.fn().mockResolvedValue(generateResult),
    getModelForTier: vi.fn().mockReturnValue(t3Model),
  } as unknown as CascadeRouter;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModelProfiler — direct-inference fallback', () => {
  it('profiles a model via direct query when the OpenRouter catalog has no entry for it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const t3Model = makeModel({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' });
    const router = makeRouter(t3Model, { content: '{"specializations":["analysis"]}', usage: {}, finishReason: 'stop' });
    const store = makeStore();

    await new ModelProfiler(store, router).profileAll([
      makeModel({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }),
    ]);

    expect(router.generate).toHaveBeenCalledTimes(1);
    expect(store.saveModelProfile).toHaveBeenCalledWith('gpt-4o', 'openai', ['analysis']);
  });
});
