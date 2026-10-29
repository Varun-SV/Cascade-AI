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

describe('OpenAIProvider — tool transport per model', () => {
  const tool = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } };
  const emptyChat = () => ({ async *[Symbol.asyncIterator]() { /* no frames */ } });
  const events = (list: unknown[]) => ({ async *[Symbol.asyncIterator]() { for (const e of list) yield e; } });

  function provider(modelId: string, opts: { provider?: ModelInfo['provider']; responses?: unknown[] } = {}) {
    const chat = vi.fn(async () => emptyChat());
    const responses = vi.fn(async () => events(opts.responses ?? []));
    const model: ModelInfo = {
      id: modelId, name: modelId, provider: opts.provider ?? 'openai', contextWindow: 1_050_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 1000, supportsStreaming: true, isLocal: false,
    };
    const p = new OpenAIProvider({ type: 'openai', apiKey: 'sk' }, model);
    (p as unknown as { client: unknown }).client = { chat: { completions: { create: chat } }, responses: { create: responses } };
    return { p, chat, responses };
  }

  // A full tool round trip, as T1/T2 send it on their second turn.
  const history = [
    { role: 'user' as const, content: 'Summarise README.md' },
    { role: 'assistant' as const, content: 'Reading it.', toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'README.md' } }] },
    { role: 'tool' as const, content: '# Cascade', toolCallId: 'call_1' },
  ];

  it('sends GPT-6.1 Sol tool calls through the Responses API, not Chat Completions', async () => {
    const { p, chat, responses } = provider('gpt-6.1-sol');
    await p.generateStream({ messages: history, systemPrompt: 'You plan.', tools: [tool] }, () => {});
    expect(chat).not.toHaveBeenCalled();
    expect(responses).toHaveBeenCalledTimes(1);
    const params = (responses.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: 'gpt-6.1-sol', instructions: 'You plan.', store: false, stream: true, max_output_tokens: 1000,
      tools: [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: tool.inputSchema, strict: false }],
    });
    // The round trip is items joined by call_id, not message fields.
    expect(params['input']).toEqual([
      { role: 'user', content: 'Summarise README.md' },
      { role: 'assistant', content: 'Reading it.' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '# Cascade' },
    ]);
  });

  it('streams text, tool calls and usage back from the Responses API', async () => {
    const { p } = provider('gpt-6.1-terra', {
      responses: [
        { type: 'response.reasoning_summary_text.delta', delta: 'Need the file.' },
        { type: 'response.output_text.delta', delta: 'Checking ' },
        { type: 'response.output_text.delta', delta: 'now.' },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'read_file', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"path":' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '"a.md"}' },
        { type: 'response.completed', response: { usage: { input_tokens: 120, output_tokens: 30 } } },
      ],
    });
    const chunks: string[] = [];
    const result = await p.generateStream({ messages: [{ role: 'user', content: 'go' }], tools: [tool] }, (c) => chunks.push(c.text));
    expect(result.content).toBe('<think>\nNeed the file.\n</think>\n\nChecking now.');
    expect(chunks.join('')).toBe(result.content);
    expect(result.toolCalls).toEqual([{ id: 'call_9', name: 'read_file', input: { path: 'a.md' } }]);
    expect(result.finishReason).toBe('tool_use');
    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(30);
  });

  it('reports a token-budget stop and keeps truncated arguments instead of throwing', async () => {
    const { p } = provider('gpt-6.1-sol', {
      responses: [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"path":"/tm' },
        { type: 'response.incomplete', response: { usage: { input_tokens: 5, output_tokens: 1000 }, incomplete_details: { reason: 'max_output_tokens' } } },
      ],
    });
    const result = await p.generateStream({ messages: [{ role: 'user', content: 'go' }], tools: [tool] }, () => {});
    expect(result.finishReason).toBe('length');
    expect(result.toolCalls?.[0]?.input).toMatchObject({ __parseError: true, __rawArguments: '{"path":"/tm' });
  });

  it('surfaces a failed Responses call as an error', async () => {
    const { p } = provider('gpt-6.1-sol', {
      responses: [{ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } }],
    });
    await expect(p.generateStream({ messages: [{ role: 'user', content: 'go' }], tools: [tool] }, () => {}))
      .rejects.toThrow('server_error: boom');
  });

  it('keeps GPT-6.1 Sol on Chat Completions when no tools are sent', async () => {
    const { p, chat, responses } = provider('gpt-6.1-sol');
    await p.generateStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(responses).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('leaves other providers built on this class on their own transport', async () => {
    const { p, chat, responses } = provider('gpt-6.1-sol', { provider: 'azure' });
    await p.generateStream({ messages: [{ role: 'user', content: 'go' }], tools: [tool] }, () => {});
    expect(responses).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('asks GPT-6 Luna for reasoning_effort none whenever it is sent tools', async () => {
    const { p, chat } = provider('gpt-6-luna');
    await p.generateStream({ messages: [{ role: 'user', content: 'go' }], tools: [tool] }, () => {});
    expect(chat.mock.calls[0]![0]).toMatchObject({ reasoning_effort: 'none', tools: [expect.objectContaining({ type: 'function' })] });
    // Tool-less calls keep the model's default effort.
    await p.generateStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(chat.mock.calls[1]![0]).not.toHaveProperty('reasoning_effort');
  });

  it('does not change reasoning effort for models without that restriction', async () => {
    for (const id of ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.4-mini']) {
      const { p, chat } = provider(id);
      await p.generateStream({ messages: [{ role: 'user', content: 'go' }], tools: [tool] }, () => {});
      expect(chat.mock.calls[0]![0], id).not.toHaveProperty('reasoning_effort');
    }
  });

  it('treats GPT-6 as a reasoning family from the first call', () => {
    expect(isReasoningModel('gpt-6.1-sol')).toBe(true);
    expect(isReasoningModel('gpt-6-luna')).toBe(true);
  });
});
