// A run's thinking level reaches every model call the run makes.
import { describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import type { CascadeConfig, GenerateOptions, ModelInfo, ThinkingLevel } from '../../types.js';

const local: ModelInfo = {
  id: 'llama-a', name: 'llama-a', provider: 'ollama', contextWindow: 32_000, isVisionCapable: false,
  inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 1_000, supportsStreaming: true, isLocal: true, supportsToolUse: true,
} as ModelInfo;

async function routerWith(thinking?: ThinkingLevel): Promise<{ router: CascadeRouter; seen: GenerateOptions[] }> {
  const router = new CascadeRouter();
  const internals = router as unknown as Record<string, unknown>;
  internals['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set(['ollama']));
  internals['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
  await router.init({
    providers: [{ type: 'ollama', baseUrl: 'http://127.0.0.1:11434' }],
    models: {}, tools: { allowedTools: [] }, ...(thinking ? { thinking } : {}),
  } as unknown as CascadeConfig);
  const selector = internals['selector'] as { addDynamicModel(m: ModelInfo): void; setModelVeto(v: (m: ModelInfo) => boolean): void };
  selector.addDynamicModel(local);
  selector.setModelVeto((m) => m.id !== 'llama-a');
  const seen: GenerateOptions[] = [];
  (internals['providers'] as Map<string, unknown>).set('ollama:llama-a', {
    generate: async (o: GenerateOptions) => { seen.push(o); return { content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }; },
  });
  // A cloud tier model, so a forced-local call swaps onto the stub above.
  for (const tier of ['T1', 'T3']) {
    (internals['tierModels'] as Map<string, ModelInfo>).set(tier, { ...local, id: 'cloud-1', provider: 'anthropic', isLocal: false } as ModelInfo);
  }
  return { router, seen };
}

const call = (extra: Partial<GenerateOptions> = {}) => ({ messages: [{ role: 'user', content: 'hi' }], forceLocal: true, ...extra }) as never;

describe("a run's thinking level", () => {
  it('is set on every call the run makes', async () => {
    const { router, seen } = await routerWith('high');
    await router.generate('T3', call());
    await router.generate('T1', call());
    expect(seen.map((o) => o.thinking)).toEqual(['high', 'high']);
  });

  it('leaves a call that chose its own alone', async () => {
    const { router, seen } = await routerWith('high');
    await router.generate('T3', call({ thinking: 'off' }));
    expect(seen[0]?.thinking).toBe('off');
  });

  it('sets nothing for "auto" or when unset', async () => {
    for (const level of ['auto', undefined] as const) {
      const { router, seen } = await routerWith(level);
      await router.generate('T3', call());
      expect(seen[0]?.thinking).toBeUndefined();
    }
  });
});
