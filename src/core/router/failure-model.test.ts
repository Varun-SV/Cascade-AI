// A failed call names the model it came from, so a caller that records a
// verdict about the model (the T3 worker's text-tool switch) records it
// against the right one, even after a failover.
import { describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import type { CascadeConfig, ModelInfo } from '../../types.js';

const local: ModelInfo = {
  id: 'gpt-oss:20b', name: 'gpt-oss:20b', provider: 'ollama', contextWindow: 32_000, isVisionCapable: false,
  inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 1_000, supportsStreaming: true, isLocal: true, supportsToolUse: true,
} as ModelInfo;

async function routerThrowing(error: Error): Promise<CascadeRouter> {
  const router = new CascadeRouter();
  const internals = router as unknown as Record<string, unknown>;
  internals['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set(['ollama']));
  internals['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
  await router.init({
    providers: [{ type: 'ollama', baseUrl: 'http://127.0.0.1:11434' }],
    models: {}, tools: { allowedTools: [] },
  } as unknown as CascadeConfig);
  const selector = internals['selector'] as { addDynamicModel(m: ModelInfo): void; setModelVeto(v: (m: ModelInfo) => boolean): void };
  selector.addDynamicModel(local);
  selector.setModelVeto((m) => m.id !== local.id);
  (internals['providers'] as Map<string, unknown>).set(`ollama:${local.id}`, {
    generate: async () => { throw error; },
  });
  (internals['tierModels'] as Map<string, ModelInfo>).set('T3', { ...local, id: 'cloud-1', provider: 'anthropic', isLocal: false } as ModelInfo);
  return router;
}

const templateError = () => new Error('Ollama chat request failed: 500 Internal Server Error - While executing If at line 13, column 13 in source: Error: Function is not a bool value');
const call = { messages: [{ role: 'user', content: 'hi' }], forceLocal: true, tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] } as never;

describe('a failed call', () => {
  it('names the model it came from', async () => {
    const router = await routerThrowing(templateError());
    const err = await router.generate('T3', call).catch((e: unknown) => e);
    expect((err as { servedBy?: unknown }).servedBy).toEqual({ provider: 'ollama', id: 'gpt-oss:20b' });
  });

  it('keeps the model a failover call named, rather than the one it failed over from', async () => {
    const inner = Object.assign(templateError(), { servedBy: { provider: 'openai-compatible', id: 'fallback-model' } });
    const router = await routerThrowing(inner);
    const err = await router.generate('T3', call).catch((e: unknown) => e);
    expect((err as { servedBy?: unknown }).servedBy).toEqual({ provider: 'openai-compatible', id: 'fallback-model' });
  });
});
