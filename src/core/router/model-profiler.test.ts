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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModelProfiler — github-models exclusion from direct-inference probing', () => {
  it('never calls router.generate() to profile a github-models model', async () => {
    // Regression (Codex P1): profileAll() runs every unprofiled model's
    // direct-query fallback in full parallel via Promise.allSettled, and
    // queryModelDirectly always hits whatever model T3 currently resolves
    // to — so registering N github-models catalog entries (no static
    // priority list, so ALL of them land in the "toProfile" set at startup,
    // every session) fires N simultaneous requests at GitHub's real ~10 RPM
    // budget before the user submits a single real task. Stub fetch so the
    // OpenRouter lookup finds nothing, forcing the fallback path to matter.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const generate = vi.fn().mockResolvedValue({
      content: '{"specializations":["code"]}',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'stop',
    });
    const router = { generate } as unknown as CascadeRouter;
    const store = makeStore();

    const models = [
      makeModel({ id: 'openai/gpt-4o' }),
      makeModel({ id: 'meta/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' }),
      makeModel({ id: 'deepseek/DeepSeek-R1', name: 'DeepSeek R1' }),
    ];

    await new ModelProfiler(store, router).profileAll(models);

    expect(generate).not.toHaveBeenCalled();
    // Still recorded (with empty specializations) so startup never re-attempts.
    expect(store.saveModelProfile).toHaveBeenCalledTimes(3);
    for (const m of models) {
      expect(store.saveModelProfile).toHaveBeenCalledWith(m.id, 'github-models', []);
    }
  });

  it('still profiles a non-github-models model via direct query when OpenRouter has no match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const generate = vi.fn().mockResolvedValue({
      content: '{"specializations":["analysis"]}',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'stop',
    });
    const router = { generate } as unknown as CascadeRouter;
    const store = makeStore();

    await new ModelProfiler(store, router).profileAll([
      makeModel({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' }),
    ]);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.saveModelProfile).toHaveBeenCalledWith('gpt-4o', 'openai', ['analysis']);
  });
});
