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
    id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'github-models',
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

describe('ModelProfiler — github-models exclusion from direct-inference probing', () => {
  it('never calls router.generate() when T3 resolves to a github-models model', async () => {
    // Regression (Codex P1): profileAll() runs every unprofiled model's
    // direct-query fallback in full parallel via Promise.allSettled, and
    // queryModelDirectly always hits whatever model T3 currently resolves
    // to — so registering N github-models catalog entries (no static
    // priority list, so ALL of them land in the "toProfile" set at startup,
    // every session) fires N simultaneous requests at GitHub's real ~10 RPM
    // budget before the user submits a single real task. Stub fetch so the
    // OpenRouter lookup finds nothing, forcing the fallback path to matter.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const t3Model = makeModel({ id: 'openai/gpt-4o' });
    const router = makeRouter(t3Model, { content: '{"specializations":["code"]}', usage: {}, finishReason: 'stop' });
    const store = makeStore();

    const models = [
      makeModel({ id: 'openai/gpt-4o' }),
      makeModel({ id: 'meta/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' }),
      makeModel({ id: 'deepseek/DeepSeek-R1', name: 'DeepSeek R1' }),
    ];

    await new ModelProfiler(store, router).profileAll(models);

    expect(router.generate).not.toHaveBeenCalled();
    // Still recorded (with empty specializations) so startup never re-attempts.
    expect(store.saveModelProfile).toHaveBeenCalledTimes(3);
    for (const m of models) {
      expect(store.saveModelProfile).toHaveBeenCalledWith(m.id, 'github-models', []);
    }
  });

  it('never calls router.generate() for a NON-github-models model being profiled when T3 is pinned to github-models', async () => {
    // Regression (Codex P1, sharper variant): the previous fix gated on the
    // provider of the model BEING PROFILED (the loop variable), not on the
    // model that actually receives every probe. In a mixed-provider config
    // with T3 explicitly pinned to github-models, an anthropic/openai/etc.
    // catalog model with no OpenRouter match would still pass that guard
    // (its own provider isn't 'github-models') and call
    // queryModelDirectly() — which ignores which model was passed in and
    // always hits router.generate('T3', …), landing on the pinned
    // github-models model regardless.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const t3Model = makeModel({ id: 'openai/gpt-4o', provider: 'github-models' });
    const router = makeRouter(t3Model, { content: '{"specializations":["code"]}', usage: {}, finishReason: 'stop' });
    const store = makeStore();

    const anthropicModel = makeModel({
      id: 'claude-opus-4-5', name: 'Claude Opus 4', provider: 'anthropic',
      contextWindow: 200_000, maxOutputTokens: 32_000, supportsToolUse: true,
    });

    await new ModelProfiler(store, router).profileAll([anthropicModel]);

    expect(router.generate).not.toHaveBeenCalled();
    expect(store.saveModelProfile).toHaveBeenCalledWith('claude-opus-4-5', 'anthropic', []);
  });

  it('still profiles a non-github-models model via direct query when T3 is NOT pinned to github-models', async () => {
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
