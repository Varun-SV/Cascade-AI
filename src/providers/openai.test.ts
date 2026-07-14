import { describe, it, expect, vi } from 'vitest';

// Mutable holder so tests can inject stream frames into the mocked client.
const streamFramesHolder: { frames: unknown[] } = { frames: [] };

vi.mock('openai', () => {
  class FakeOpenAI {
    public chat = {
      completions: {
        create: vi.fn(async () => {
          const frames = streamFramesHolder.frames;
          return {
            async *[Symbol.asyncIterator]() {
              for (const f of frames) yield f;
            },
          };
        }),
      },
    };
    public models = {
      list: vi.fn(async () => ({ data: [] })),
    };
  }
  return { default: FakeOpenAI };
});

import { OpenAIProvider, isReasoningModel, isParamShapeError } from './openai.js';
import { MODELS } from '../constants.js';
import type { ModelInfo } from '../types.js';

function makeProvider(): OpenAIProvider {
  const model = Object.values(MODELS).find((m) => m.provider === 'openai')!;
  return new OpenAIProvider({ type: 'openai', apiKey: 'sk-test' }, model);
}

describe('OpenAIProvider streaming tool-call parsing', () => {
  it('recovers gracefully when tool-call args are truncated mid-JSON', async () => {
    streamFramesHolder.frames = [
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { name: 'do_thing', arguments: '{"path":"/tmp/x' } },
            ],
          },
        }],
      },
      { choices: [{ finish_reason: 'length' }] },
    ];

    const provider = makeProvider();
    const result = await provider.generateStream(
      { messages: [{ role: 'user', content: 'run it' }] },
      () => { /* drop chunks */ },
    );

    expect(result.toolCalls?.[0]?.name).toBe('do_thing');
    const input = result.toolCalls?.[0]?.input as Record<string, unknown>;
    expect(input['__parseError']).toBe(true);
    expect(input['__rawArguments']).toContain('/tmp/x');
  });

  it('parses complete tool-call JSON into a real object', async () => {
    streamFramesHolder.frames = [
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_2', function: { name: 'do_thing', arguments: '{"path":"/tmp/y"}' } },
            ],
          },
        }],
      },
      { choices: [{ finish_reason: 'tool_calls' }] },
    ];

    const provider = makeProvider();
    const result = await provider.generateStream(
      { messages: [{ role: 'user', content: 'go' }] },
      () => { /* drop */ },
    );
    const input = result.toolCalls?.[0]?.input as Record<string, unknown>;
    expect(input).toEqual({ path: '/tmp/y' });
  });
});

describe('OpenAIProvider — adaptive token parameter', () => {
  const emptyStream = () => ({ async *[Symbol.asyncIterator]() { /* no frames */ } });
  function providerWith(modelId: string, create: ReturnType<typeof vi.fn>): OpenAIProvider {
    const model: ModelInfo = {
      id: modelId, name: modelId, provider: 'openai', contextWindow: 128_000, isVisionCapable: false,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 1000, supportsStreaming: true, isLocal: false,
    };
    const p = new OpenAIProvider({ type: 'openai', apiKey: 'sk' }, model);
    (p as unknown as { client: { chat: { completions: { create: typeof create } } } }).client = { chat: { completions: { create } } };
    return p;
  }

  it('uses max_completion_tokens (and omits temperature) up front for reasoning models', async () => {
    const create = vi.fn(async () => emptyStream());
    const p = providerWith('gpt-5-mini', create);
    await p.generateStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ max_completion_tokens: expect.any(Number) });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('max_tokens');
    expect(create.mock.calls[0]![0]).not.toHaveProperty('temperature');
  });

  it('adapts: on a max_tokens rejection, retries with max_completion_tokens', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."))
      .mockResolvedValueOnce(emptyStream());
    const p = providerWith('gpt-4o', create);
    await p.generateStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![0]).toHaveProperty('max_tokens');
    expect(create.mock.calls[1]![0]).toMatchObject({ max_completion_tokens: expect.any(Number) });
    expect(create.mock.calls[1]![0]).not.toHaveProperty('temperature');
  });

  it('isReasoningModel / isParamShapeError detect the right cases', () => {
    expect(isReasoningModel('gpt-5-mini')).toBe(true);
    expect(isReasoningModel('o1-preview')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
    expect(isReasoningModel('gpt-4o')).toBe(false);
    expect(isParamShapeError(new Error('Please use max_completion_tokens'))).toBe(true);
    expect(isParamShapeError(new Error("'temperature' does not support 0.7 — only the default"))).toBe(true);
    expect(isParamShapeError(new Error('network timeout'))).toBe(false);
  });
});
