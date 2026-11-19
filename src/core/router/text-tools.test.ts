import { describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import type { ModelInfo } from '../../types.js';
import type { MemoryStore } from '../../memory/store.js';

function model(id: string, provider: ModelInfo['provider'], supportsToolUse: boolean | undefined): ModelInfo {
  return {
    id, name: id, provider, contextWindow: 32000, isVisionCapable: false,
    inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 4096,
    supportsStreaming: true, isLocal: provider === 'ollama', supportsToolUse,
  };
}

/** A router over a fixed pool, with its selector and tier models in reach. */
function routerWith(models: ModelInfo[]) {
  const pool = new Map(models.map((m) => [m.id, m]));
  const router = new CascadeRouter();
  const inner = router as unknown as Record<string, unknown>;
  inner['selector'] = {
    getModelById: (id: string) => pool.get(id),
    getAllAvailableModels: () => [...pool.values()],
    addDynamicModel: (m: ModelInfo) => pool.set(m.id, m),
  };
  const tiers = new Map<string, ModelInfo>([['T3', models[0]!]]);
  inner['tierModels'] = tiers;
  return { router, pool, tiers };
}

function storeWith(verdicts: Record<string, boolean> = {}) {
  const saved: Array<[string, string, { supportsToolUse?: boolean }]> = [];
  const store = {
    getModelProfile: (id: string, provider: string) =>
      (`${provider}:${id}` in verdicts ? { supportsToolUse: verdicts[`${provider}:${id}`] } : undefined),
    saveModelCapability: vi.fn((id: string, provider: string, caps: { supportsToolUse?: boolean }) => { saved.push([id, provider, caps]); }),
  } as unknown as MemoryStore;
  return { store, saved };
}

describe('CascadeRouter.useTextTools', () => {
  it('switches the model and its tier to the text format, and keeps the verdict for an OpenAI-compatible model', async () => {
    const { router, pool, tiers } = routerWith([model('qwen', 'openai-compatible', true)]);
    const { store, saved } = storeWith();
    await router.probeLocalToolSupport(store);

    router.useTextTools({ provider: 'openai-compatible', id: 'qwen' });

    expect(pool.get('qwen')!.supportsToolUse).toBe(false);
    expect(tiers.get('T3')!.supportsToolUse).toBe(false);
    expect(saved).toEqual([['qwen', 'openai-compatible', { supportsToolUse: false }]]);
  });

  it('switches a first-party model for this run only', async () => {
    const { router, pool } = routerWith([model('gpt-x', 'openai', true)]);
    const { store, saved } = storeWith();
    await router.probeLocalToolSupport(store);

    router.useTextTools({ provider: 'openai', id: 'gpt-x' });

    expect(pool.get('gpt-x')!.supportsToolUse).toBe(false);
    expect(saved).toEqual([]);
  });

  it('starts a model remembered as a text-tool model in the text format', async () => {
    const { router, pool } = routerWith([model('llama', 'ollama', true), model('gpt-x', 'openai', true)]);
    const { store } = storeWith({ 'ollama:llama': false, 'openai:gpt-x': false });

    await router.probeLocalToolSupport(store);

    expect(pool.get('llama')!.supportsToolUse).toBe(false);
    expect(pool.get('gpt-x')!.supportsToolUse).toBe(true);
  });

  it('ignores a model it does not know', () => {
    const { router, pool } = routerWith([model('qwen', 'openai-compatible', true)]);
    router.useTextTools({ provider: 'ollama', id: 'qwen' });
    expect(pool.get('qwen')!.supportsToolUse).toBe(true);
  });
});
