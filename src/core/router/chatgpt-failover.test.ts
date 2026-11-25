// A ChatGPT plan limit STOPS the request. Failing over to a paid API provider
// would move the user's spend without their say.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CascadeRouter } from './index.js';
import { ChatGptProvider } from '../../providers/chatgpt.js';
import { AnthropicProvider } from '../../providers/anthropic.js';
import { requestErrorFrom } from '../../auth/chatgpt/errors.js';
import type { CascadeConfig, ModelInfo } from '../../types.js';

afterEach(() => vi.restoreAllMocks());

const planModel: ModelInfo = {
  id: 'chatgpt:gpt-5.5', baseModelId: 'gpt-5.5', name: 'GPT-5.5', provider: 'chatgpt', contextWindow: 272_000,
  isVisionCapable: true, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 32_000,
  supportsStreaming: true, supportsToolUse: true, isLocal: false,
};

async function pinnedRouter() {
  const router = new CascadeRouter();
  (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set(['chatgpt', 'anthropic']));
  await router.init({
    providers: [{ type: 'chatgpt' }, { type: 'anthropic', apiKey: 'sk-ant-test' }],
    models: {}, tools: { allowedTools: [] },
  } as unknown as CascadeConfig);
  (router as unknown as { selector: { addDynamicModel(m: ModelInfo): void } }).selector.addDynamicModel(planModel);
  return router;
}

describe('ChatGPT plan errors never fail over to another provider', () => {
  for (const [code, status] of [
    ['subscription_sharing_usage_limit_exceeded', 429],
    ['subscription_sharing_user_not_eligible', 403],
  ] as const) {
    it(`${code}: the typed error is raised and no other provider is called`, async () => {
      const plan = vi.spyOn(ChatGptProvider.prototype, 'generateStream')
        .mockRejectedValue(requestErrorFrom({ status, code, message: 'x' }));
      const other = vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
        content: 'from the paid provider', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
      } as never);

      const router = await pinnedRouter();
      const events: unknown[] = [];
      router.on('failover', (e: unknown) => events.push(e));
      router.on('provider:exhausted', (e: unknown) => events.push(e));

      await expect(router.generate('T1', { messages: [{ role: 'user', content: 'hi' }], model: planModel, maxTokens: 64 }))
        .rejects.toMatchObject({ name: 'ChatGptRequestError', code });
      expect(plan).toHaveBeenCalledTimes(1);
      expect(other).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });
  }

  it('a later call is not carried to the other provider either', async () => {
    vi.spyOn(ChatGptProvider.prototype, 'generateStream')
      .mockRejectedValue(requestErrorFrom({ status: 429, code: 'subscription_sharing_usage_limit_exceeded' }));
    const other = vi.spyOn(AnthropicProvider.prototype, 'generateStream').mockResolvedValue({
      content: 'paid', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
    } as never);
    const router = await pinnedRouter();
    for (let i = 0; i < 2; i++) {
      await expect(router.generate('T1', { messages: [{ role: 'user', content: 'hi' }], model: planModel, maxTokens: 64 })).rejects.toBeTruthy();
    }
    expect(other).not.toHaveBeenCalled();
  });
});
