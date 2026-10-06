// ─────────────────────────────────────────────
//  Cascade AI — Which models a browser screenshot may reach
// ─────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { CascadeRouter, IMAGE_TOKENS_EACH } from './index.js';
import { fitScreenshots, mayTakeScreenshots, screenshotRefusal, screenshotTokens } from './screenshots.js';
import type { CascadeConfig, ConversationMessage, GenerateOptions, ImageAttachment, ModelInfo } from '../../types.js';

function model(provider: ModelInfo['provider'], id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id, name: id, provider, contextWindow: 128_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.001, outputCostPer1kTokens: 0.002, maxOutputTokens: 4_000,
    supportsStreaming: true, isLocal: false, ...extra,
  } as ModelInfo;
}

const CLAUDE = model('anthropic', 'claude-sonnet-x');
const SHOT: ImageAttachment = { type: 'base64', data: 'AAAA', mimeType: 'image/jpeg', screenshot: { width: 1280, height: 800 } };
const ATTACHED: ImageAttachment = { type: 'base64', data: 'BBBB', mimeType: 'image/png' };

describe('screenshotTokens', () => {
  it('prices a 1280×800 page by each provider\'s own rule', () => {
    expect(screenshotTokens(CLAUDE, 1280, 800)).toBe(1366);
    expect(screenshotTokens(model('gemini', 'gemini-2.5-pro'), 1280, 800)).toBe(4 * 258);
    expect(screenshotTokens(model('openai', 'gpt-4o'), 1280, 800)).toBe(85 + 170 * 6);
    expect(screenshotTokens(model('azure', 'my-deploy', { baseModelId: 'gpt-4o' }), 1280, 800)).toBe(85 + 170 * 6);
    expect(screenshotTokens(model('openai', 'gpt-4.1-mini'), 1280, 800)).toBe(1620);
    expect(screenshotTokens(model('openai', 'gpt-4.1-nano'), 1280, 800)).toBe(2460);
  });

  it('prices gpt-4o-mini at its real rate — about 37k tokens a page', () => {
    expect(screenshotTokens(model('openai', 'gpt-4o-mini'), 1280, 800)).toBe(2833 + 5667 * 6);
  });

  it('applies Claude\'s downscaling to a large page', () => {
    // A 1920×1080 page is billed as ~1.15 megapixels, not 2.
    expect(screenshotTokens(CLAUDE, 1920, 1080)).toBeLessThanOrEqual(1534);
  });

  it('cannot price a provider whose rule it does not know', () => {
    expect(screenshotTokens(model('openai-compatible', 'llava'), 1280, 800)).toBeNull();
    expect(screenshotTokens(model('ollama', 'llava'), 1280, 800)).toBeNull();
    expect(screenshotTokens(CLAUDE, 0, 800)).toBeNull();
  });
});

describe('screenshotRefusal', () => {
  it('lets a screenshot reach a model that can see it at a fair price', () => {
    expect(screenshotRefusal(CLAUDE, SHOT, IMAGE_TOKENS_EACH)).toBeNull();
    expect(screenshotRefusal(model('openai', 'gpt-4o'), SHOT, IMAGE_TOKENS_EACH)).toBeNull();
  });

  it('keeps it from a model that cannot see, or whose vision flag means nothing', () => {
    expect(screenshotRefusal(model('anthropic', 'old', { isVisionCapable: false }), SHOT, IMAGE_TOKENS_EACH)).toMatch(/cannot view images/);
    expect(screenshotRefusal(model('openai-compatible', 'llava'), SHOT, IMAGE_TOKENS_EACH)).toMatch(/cannot view images/);
    expect(screenshotRefusal(model('ollama', 'llava', { isLocal: true }), SHOT, IMAGE_TOKENS_EACH)).toMatch(/cannot view images/);
  });

  it('keeps it from a model it would overcharge', () => {
    expect(screenshotRefusal(model('openai', 'gpt-4o-mini'), SHOT, IMAGE_TOKENS_EACH)).toMatch(/cost more/);
    expect(screenshotRefusal(model('openai', 'gpt-4.1-nano'), SHOT, IMAGE_TOKENS_EACH)).toMatch(/cost more/);
  });

  it('keeps out a screenshot whose size it was not told', () => {
    const { screenshot: _drop, ...noSize } = SHOT;
    expect(screenshotRefusal(CLAUDE, { ...noSize, screenshot: undefined }, IMAGE_TOKENS_EACH)).toMatch(/cost more/);
  });

  it('answers the worker\'s question the same way', () => {
    expect(mayTakeScreenshots(CLAUDE, IMAGE_TOKENS_EACH)).toBe(true);
    expect(mayTakeScreenshots(model('openai', 'gpt-4o-mini'), IMAGE_TOKENS_EACH)).toBe(false);
    expect(mayTakeScreenshots(undefined, IMAGE_TOKENS_EACH)).toBe(false);
  });
});

describe('fitScreenshots', () => {
  const request = (): GenerateOptions => ({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Look at this' }, { type: 'image', image: ATTACHED }] },
      { role: 'tool', toolCallId: 'c1', content: 'Looked at the page.' },
      { role: 'user', content: [{ type: 'text', text: '[A screenshot]' }, { type: 'image', image: SHOT }] },
    ],
  });

  it('replaces a screenshot the model cannot take with the reason', () => {
    const fitted = fitScreenshots(request(), model('openai', 'gpt-4o-mini'), IMAGE_TOKENS_EACH);
    const last = fitted.messages[2]!.content as Array<{ type: string; text?: string }>;
    expect(last.map((b) => b.type)).toEqual(['text', 'text']);
    expect(last[1]!.text).toMatch(/^\[Screenshot left out: .*cost more/);
  });

  it('never touches an image a person attached', () => {
    const fitted = fitScreenshots(request(), model('anthropic', 'blind', { isVisionCapable: false }), IMAGE_TOKENS_EACH);
    expect(fitted.messages[0]).toEqual(request().messages[0]);
  });

  it('keeps a person\'s image even in the same turn as a screenshot it drops', () => {
    const options: GenerateOptions = {
      messages: [{ role: 'user', content: [{ type: 'image', image: ATTACHED }, { type: 'image', image: SHOT }] }],
    };
    const fitted = fitScreenshots(options, model('anthropic', 'blind', { isVisionCapable: false }), IMAGE_TOKENS_EACH);
    const content = fitted.messages[0]!.content as Array<{ type: string; image?: ImageAttachment }>;
    expect(content[0]).toEqual({ type: 'image', image: ATTACHED });
    expect(content[1]!.type).toBe('text');
  });

  it('hands back the same request when nothing needs to change', () => {
    const options = request();
    expect(fitScreenshots(options, CLAUDE, IMAGE_TOKENS_EACH)).toBe(options);
  });
});

describe('the router decides against the model it resolved', () => {
  async function routerServing(served: ModelInfo) {
    const router = new CascadeRouter();
    (router as unknown as Record<string, unknown>)['detectAvailableProviders'] = vi.fn().mockResolvedValue(new Set());
    await router.init({ providers: [], models: {}, tools: { allowedTools: [] } } as unknown as CascadeConfig);
    const seen: ConversationMessage[][] = [];
    const internals = router as unknown as { tierModels: Map<string, ModelInfo>; providers: Map<string, unknown> };
    internals.tierModels.set('T3', served);
    internals.providers.set(`${served.provider}:${served.id}`, {
      generate: async (options: GenerateOptions) => {
        seen.push(options.messages);
        return { content: 'ok', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } };
      },
    });
    return { router, seen };
  }

  const withShot: GenerateOptions = {
    messages: [
      { role: 'user', content: 'Book a table' },
      { role: 'user', content: [{ type: 'text', text: '[A screenshot]' }, { type: 'image', image: SHOT }] },
    ],
  };

  it('sends the screenshot to a model that can see it', async () => {
    const { router, seen } = await routerServing(CLAUDE);
    await router.generate('T3', withShot);
    expect(JSON.stringify(seen[0])).toContain('"type":"image"');
  });

  it('leaves it out for a model that cannot, and says so', async () => {
    const { router, seen } = await routerServing(model('anthropic', 'blind', { isVisionCapable: false }));
    await router.generate('T3', withShot);
    expect(JSON.stringify(seen[0])).not.toContain('"type":"image"');
    expect(JSON.stringify(seen[0])).toContain('Screenshot left out');
  });

  it('counts what it sent and what it left out, for /why, per run', async () => {
    const seeing = await routerServing(CLAUDE);
    await seeing.router.generate('T3', withShot);
    await seeing.router.generate('T3', withShot);
    expect(seeing.router.getRunScreenshots()).toEqual({ sent: 2, leftOut: 0 });
    seeing.router.beginRun();
    expect(seeing.router.getRunScreenshots()).toEqual({ sent: 0, leftOut: 0 });

    const blind = await routerServing(model('anthropic', 'blind', { isVisionCapable: false }));
    await blind.router.generate('T3', withShot);
    await blind.router.generate('T3', { messages: [{ role: 'user', content: 'no picture here' }] });
    expect(blind.router.getRunScreenshots()).toEqual({ sent: 0, leftOut: 1 });
  });
});
