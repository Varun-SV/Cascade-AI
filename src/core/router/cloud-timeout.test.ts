// ─────────────────────────────────────────────
//  Cascade AI — Cloud inference timeout (anti-hang)
// ─────────────────────────────────────────────
//
//  Guards the regression where a stalled cloud stream (TCP open, no terminal
//  chunk) hung the whole run with no output. generate() must reject within
//  cloudInferenceTimeoutMs instead of awaiting forever.

import { describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import type { CascadeConfig, ModelInfo } from '../../types.js';

function makeConfig(overrides: Partial<CascadeConfig> = {}): CascadeConfig {
  return { providers: [], models: {}, tools: { allowedTools: [] }, ...overrides } as unknown as CascadeConfig;
}

function fakeModel(): ModelInfo {
  return {
    id: 'fake-1', name: 'Fake', provider: 'anthropic', contextWindow: 128_000,
    isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
    maxOutputTokens: 1_000, supportsStreaming: true, isLocal: false,
  } as ModelInfo;
}

/** Build a router with a hanging provider wired to the T3 tier. */
async function makeHangingRouter(timeoutMs: number): Promise<CascadeRouter> {
  const router = new CascadeRouter();
  (router as unknown as Record<string, unknown>)['detectAvailableProviders'] =
    vi.fn().mockResolvedValue(new Set());
  await router.init(makeConfig({ cloudInferenceTimeoutMs: timeoutMs } as Partial<CascadeConfig>));

  const model = fakeModel();
  const internals = router as unknown as {
    tierModels: Map<string, ModelInfo>;
    providers: Map<string, unknown>;
  };
  internals.tierModels.set('T3', model);
  // generate / generateStream return promises that never settle.
  internals.providers.set('anthropic:fake-1', {
    generate: () => new Promise(() => { /* hang */ }),
    generateStream: () => new Promise(() => { /* hang */ }),
  });
  return router;
}

describe('cloud inference timeout', () => {
  it('non-streaming: rejects with a timeout instead of hanging', async () => {
    const router = await makeHangingRouter(50);
    await expect(
      router.generate('T3', { messages: [{ role: 'user', content: 'hi' }] } as never),
    ).rejects.toThrow(/timed out/i);
  });

  it('streaming: rejects with a timeout after the stream stalls', async () => {
    const router = await makeHangingRouter(50);
    await expect(
      router.generate(
        'T3',
        { messages: [{ role: 'user', content: 'hi' }] } as never,
        () => { /* onChunk → streaming path */ },
      ),
    ).rejects.toThrow(/timed out/i);
  });
});
