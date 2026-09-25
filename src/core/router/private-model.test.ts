// ─────────────────────────────────────────────
//  Cascade AI — Which private model a local-only call can use
// ─────────────────────────────────────────────
//
//  A subtask about to read a local-only file asks hasPrivateModel() first,
//  and forceLocal swaps its calls onto a private model. Both used to count
//  every available private model, including one the selector would never
//  route to — so a read was allowed with nothing able to take it on, and the
//  swap kept landing on the same dead endpoint.

import { describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import type { CascadeConfig, ModelInfo } from '../../types.js';

function localModel(id: string, supportsToolUse: boolean): ModelInfo {
  return {
    id, name: id, provider: 'ollama', contextWindow: 32_000,
    isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
    maxOutputTokens: 1_000, supportsStreaming: true, isLocal: true, supportsToolUse,
  } as ModelInfo;
}

async function makeRouter(): Promise<{ router: CascadeRouter; veto: Set<string>; generated: string[] }> {
  const router = new CascadeRouter();
  const internals = router as unknown as Record<string, unknown>;
  internals['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set(['ollama']));
  internals['discoverOllamaModels'] = vi.fn().mockResolvedValue(undefined);
  await router.init({
    providers: [{ type: 'ollama', baseUrl: 'http://127.0.0.1:11434' }],
    models: {}, tools: { allowedTools: [] },
  } as unknown as CascadeConfig);

  const selector = internals['selector'] as {
    addDynamicModel(m: ModelInfo): void;
    setModelVeto(v: (m: ModelInfo) => boolean): void;
  };
  selector.addDynamicModel(localModel('llama-a', true));
  selector.addDynamicModel(localModel('llama-b', false));
  // Stands in for the failover verdicts the router's own veto reads. The
  // bundled catalog's Ollama models are ruled out throughout, so only the two
  // above are in play.
  const veto = new Set<string>();
  selector.setModelVeto((m) => veto.has(m.id) || !['llama-a', 'llama-b'].includes(m.id));

  const generated: string[] = [];
  const providers = internals['providers'] as Map<string, unknown>;
  for (const id of ['llama-a', 'llama-b']) {
    providers.set(`ollama:${id}`, {
      generate: async () => {
        generated.push(id);
        return { content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });
  }
  (internals['tierModels'] as Map<string, ModelInfo>).set('T3', {
    id: 'cloud-1', name: 'Cloud', provider: 'anthropic', contextWindow: 128_000,
    isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
    maxOutputTokens: 1_000, supportsStreaming: true, isLocal: false,
  } as ModelInfo);
  return { router, veto, generated };
}

describe('the private model a local-only call gets', () => {
  it('prefers one with native tools when the call carries them', async () => {
    const { router } = await makeRouter();
    expect(router.getPrivateModel({ tools: true })?.id).toBe('llama-a');
    expect(router.getPrivateModel({ current: localModel('llama-b', false), tools: true })?.id).toBe('llama-b');
  });

  it('does not take a cloud model for the private one that shares its ID', async () => {
    const { router } = await makeRouter();
    const cloudTwin = { ...localModel('llama-b', true), provider: 'openai', isLocal: false } as ModelInfo;
    const chosen = router.getPrivateModel({ current: cloudTwin, tools: true });
    expect(chosen?.provider).toBe('ollama');
    // The private model's own tool protocol, not the cloud twin's.
    expect(chosen?.id).toBe('llama-a');
    expect(chosen?.supportsToolUse).toBe(true);
  });

  it('does not count a private model the selector has ruled out', async () => {
    const { router, veto } = await makeRouter();
    veto.add('llama-a');
    expect(router.getPrivateModel({ tools: true })?.id).toBe('llama-b');
    expect(router.hasPrivateModel()).toBe(true);
    veto.add('llama-b');
    expect(router.hasPrivateModel()).toBe(false);
    expect(router.getPrivateModel({ current: localModel('llama-a', true) })).toBeUndefined();
  });

  it('refuses a forced-local call rather than send it to a ruled-out endpoint', async () => {
    const { router, veto, generated } = await makeRouter();
    veto.add('llama-a');
    veto.add('llama-b');
    await expect(
      router.generate('T3', { messages: [{ role: 'user', content: 'hi' }], forceLocal: true } as never),
    ).rejects.toThrow(/no LOCAL model is available/);
    expect(generated).toEqual([]);

    veto.delete('llama-b');
    await router.generate('T3', { messages: [{ role: 'user', content: 'hi' }], forceLocal: true } as never);
    expect(generated).toEqual(['llama-b']);
  });
});
