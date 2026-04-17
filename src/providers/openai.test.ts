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

import { OpenAIProvider } from './openai.js';
import { MODELS } from '../constants.js';

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
