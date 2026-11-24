import { describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ThinkingLevel } from '../types.js';
import { anthropicThinkingParams, claudeThinkingKind, geminiThinkingConfig, openaiReasoningEffort, parseClaudeId, thinkingLevelFrom } from './thinking.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { AzureOpenAIProvider } from './azure.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { GeminiProvider } from './gemini.js';

const LEVELS: ThinkingLevel[] = ['auto', 'off', 'low', 'medium', 'high'];
const model = (id: string, provider: ModelInfo['provider']): ModelInfo => ({
  id, name: id, provider, contextWindow: 200_000, isVisionCapable: false,
  inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 32_000, supportsStreaming: true, isLocal: false,
});
const empty = () => ({ async *[Symbol.asyncIterator]() { /* no events */ } });
const tool = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } };

describe('Claude model ids', () => {
  it('reads family and version, with or without a date or platform prefix', () => {
    expect(parseClaudeId('claude-opus-4-8')).toEqual({ family: 'opus', version: 4.8 });
    expect(parseClaudeId('claude-opus-5')).toEqual({ family: 'opus', version: 5 });
    expect(parseClaudeId('claude-sonnet-4-5-20250929')).toEqual({ family: 'sonnet', version: 4.5 });
    expect(parseClaudeId('claude-opus-5-20260101')).toEqual({ family: 'opus', version: 5 });
    expect(parseClaudeId('us.anthropic.claude-haiku-5-5')).toEqual({ family: 'haiku', version: 5.5 });
    expect(parseClaudeId('gpt-6-luna')).toBeNull();
  });

  it('knows how each current model takes thinking', () => {
    expect(claudeThinkingKind('claude-fable-5-2')).toBe('always');
    expect(claudeThinkingKind('claude-mythos-5-1')).toBe('always');
    expect(claudeThinkingKind('claude-opus-5-5')).toBe('always');
    expect(claudeThinkingKind('claude-opus-5')).toBe('adaptive-off-disabled');
    expect(claudeThinkingKind('claude-sonnet-5')).toBe('adaptive-off-disabled');
    expect(claudeThinkingKind('claude-haiku-5-5')).toBe('adaptive-off-disabled');
    expect(claudeThinkingKind('claude-sonnet-5-5')).toBe('adaptive-off-between-tools');
    expect(claudeThinkingKind('claude-opus-4-8')).toBe('adaptive-opt-in');
    expect(claudeThinkingKind('claude-opus-4-7')).toBe('adaptive-opt-in');
    expect(claudeThinkingKind('claude-opus-4-6')).toBe('adaptive-sampling');
    expect(claudeThinkingKind('claude-sonnet-4-6')).toBe('adaptive-sampling');
    expect(claudeThinkingKind('claude-opus-4-5-20251101')).toBe('budget');
    expect(claudeThinkingKind('claude-haiku-4-5')).toBe('budget');
    expect(claudeThinkingKind('claude-3-5-sonnet')).toBe('none');
    expect(claudeThinkingKind('claude-opus-6')).toBe('always'); // newer than the table: like the newest
  });
});

describe('Anthropic request fields', () => {
  const p = (id: string, level?: ThinkingLevel, temp?: number) => anthropicThinkingParams(id, level, 32_000, temp);

  it('never sends a budget, a disabled thinking or a temperature to models that reject them', () => {
    for (const id of ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-opus-5-5']) {
      for (const level of LEVELS) {
        const out = p(id, level, 0.2);
        expect(out.temperature, `${id} ${level}`).toBeUndefined();
        expect(out.thinking?.type, `${id} ${level}`).not.toMatch(/disabled|enabled|between_tools/);
      }
    }
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
      for (const level of LEVELS) {
        const out = p(id, level, 0.2);
        expect(out.temperature, `${id} ${level}`).toBeUndefined();
        expect(out.thinking?.type, `${id} ${level}`).not.toBe('enabled');
      }
    }
  });

  it('turns thinking down as far as each model allows for "off"', () => {
    expect(p('claude-opus-5-5', 'off')).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } });
    expect(p('claude-opus-5', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(p('claude-haiku-5-5', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(p('claude-sonnet-5-5', 'off')).toEqual({ thinking: { type: 'between_tools' } });
    expect(p('claude-opus-4-8', 'off')).toEqual({});
    expect(p('claude-opus-4-6', 'off', 0.3)).toEqual({ temperature: 0.3 });
    expect(p('claude-sonnet-4-5', 'off', 0.3)).toEqual({ temperature: 0.3 });
  });

  it('sets the effort for low, medium and high', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(p('claude-opus-5-5', level)).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: level } });
      expect(p('claude-sonnet-5-5', level).output_config).toEqual({ effort: level });
      expect(p('claude-opus-4-8', level)).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: level } });
      expect(p('claude-opus-4-6', level)).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: level } });
    }
  });

  it('gives older models a token budget that fits under max_tokens', () => {
    expect(p('claude-sonnet-4-5', 'low')).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } });
    expect(p('claude-sonnet-4-5', 'high')).toEqual({ thinking: { type: 'enabled', budget_tokens: 16000 } });
    expect(anthropicThinkingParams('claude-sonnet-4-5', 'high', 4096, undefined)).toEqual({ thinking: { type: 'enabled', budget_tokens: 3072 } });
    // No room to think: an ordinary request.
    expect(anthropicThinkingParams('claude-sonnet-4-5', 'high', 1500, 0.5)).toEqual({ temperature: 0.5 });
  });

  it('keeps what "auto" sent before levels existed, minus what the model rejects', () => {
    expect(p('claude-sonnet-4-5')).toEqual({ thinking: { type: 'enabled', budget_tokens: 8000 } });
    expect(p('claude-haiku-4-5', 'auto', 0.4)).toEqual({ temperature: 0.4 });
    expect(p('claude-3-5-sonnet', 'high', 0.4)).toEqual({ temperature: 0.4 });
    expect(p('claude-opus-5-5')).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
  });
});

describe('OpenAI reasoning effort', () => {
  it('maps levels for reasoning models only', () => {
    expect(openaiReasoningEffort('gpt-6.1-sol', 'high')).toBe('high');
    expect(openaiReasoningEffort('o3-mini', 'low')).toBe('low');
    expect(openaiReasoningEffort('gpt-4o', 'high')).toBeUndefined();
    expect(openaiReasoningEffort('gpt-6.1-sol', 'auto')).toBeUndefined();
    expect(openaiReasoningEffort('gpt-6.1-sol', undefined)).toBeUndefined();
  });

  it('turns reasoning down as far as each family allows for "off"', () => {
    expect(openaiReasoningEffort('gpt-6-luna', 'off')).toBe('none');
    expect(openaiReasoningEffort('gpt-5.4-mini', 'off')).toBe('none');
    expect(openaiReasoningEffort('gpt-5-mini', 'off')).toBe('minimal');
    expect(openaiReasoningEffort('o4-mini', 'off')).toBe('low');
  });
});

describe('Gemini thinking config', () => {
  it('takes a level on Gemini 3 and a budget on 2.5', () => {
    expect(geminiThinkingConfig('gemini-3.5-flash', 'off')).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(geminiThinkingConfig('gemini-3.5-flash', 'medium')).toEqual({ thinkingLevel: 'MEDIUM' });
    expect(geminiThinkingConfig('gemini-3.1-pro-preview', 'off')).toEqual({ thinkingLevel: 'LOW' });
    expect(geminiThinkingConfig('gemini-3.1-pro-preview', 'medium')).toEqual({ thinkingLevel: 'HIGH' });
    expect(geminiThinkingConfig('gemini-2.5-flash', 'off')).toEqual({ thinkingBudget: 0 });
    expect(geminiThinkingConfig('gemini-2.5-pro', 'off')).toEqual({ thinkingBudget: 128 });
    expect(geminiThinkingConfig('gemini-2.5-pro', 'high')).toEqual({ thinkingBudget: 32768 });
    expect(geminiThinkingConfig('gemini-3.5-flash', 'auto')).toBeUndefined();
    expect(geminiThinkingConfig('gemini-1.5-pro', 'high')).toBeUndefined();
  });
});

describe('what each provider sends', () => {
  it('Anthropic: the fields for its model, and no temperature where rejected', async () => {
    const stream = vi.fn(() => Object.assign(empty(), { finalMessage: async () => ({ usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn', content: [] }) }));
    const prov = new AnthropicProvider({ type: 'anthropic', apiKey: 'k' }, model('claude-opus-5-5', 'anthropic'));
    (prov as unknown as { client: unknown }).client = { messages: { stream } };
    await prov.generateStream({ messages: [{ role: 'user', content: 'hi' }], thinking: 'high', temperature: 0.2 }, () => {});
    const body = (stream.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(body).not.toHaveProperty('temperature');
  });

  it('OpenAI: the level as reasoning_effort, on Chat Completions and on Responses', async () => {
    const chat = vi.fn(async () => empty());
    const responses = vi.fn(async () => empty());
    const prov = new OpenAIProvider({ type: 'openai', apiKey: 'k' }, model('gpt-6.1-sol', 'openai'));
    (prov as unknown as { client: unknown }).client = { chat: { completions: { create: chat } }, responses: { create: responses } };
    await prov.generateStream({ messages: [{ role: 'user', content: 'hi' }], thinking: 'low' }, () => {});
    expect((chat.mock.calls[0] as unknown[])[0]).toMatchObject({ reasoning_effort: 'low' });
    await prov.generateStream({ messages: [{ role: 'user', content: 'go' }], tools: [tool], thinking: 'high' }, () => {});
    expect((responses.mock.calls[0] as unknown[])[0]).toMatchObject({ reasoning: { effort: 'high' } });
  });

  it('OpenAI: GPT-6 Luna still gets "none" with tools, whatever the level', async () => {
    const chat = vi.fn(async () => empty());
    const prov = new OpenAIProvider({ type: 'openai', apiKey: 'k' }, model('gpt-6-luna', 'openai'));
    (prov as unknown as { client: unknown }).client = { chat: { completions: { create: chat } } };
    await prov.generateStream({ messages: [{ role: 'user', content: 'go' }], tools: [tool], thinking: 'high' }, () => {});
    expect((chat.mock.calls[0] as unknown[])[0]).toMatchObject({ reasoning_effort: 'none' });
  });

  it('Azure: never a reasoning effort, not even the "none" GPT-6 Luna needs on OpenAI', async () => {
    for (const [id, tools] of [['gpt-6.1-sol', undefined], ['gpt-6-luna', [tool]], ['o4-mini', undefined]] as const) {
      const create = vi.fn(async () => empty());
      const prov = new AzureOpenAIProvider({ type: 'azure', apiKey: 'k', baseUrl: 'https://r.openai.azure.com', deploymentName: id }, model(id, 'azure'));
      (prov as unknown as { client: unknown }).client = { chat: { completions: { create } } };
      await prov.generateStream({ messages: [{ role: 'user', content: 'go' }], ...(tools ? { tools: [...tools] } : {}), thinking: 'high' }, () => {});
      const body = (create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(body, id).not.toHaveProperty('reasoning_effort');
      expect(body, id).not.toHaveProperty('reasoning');
    }
  });

  it('OpenAI-compatible gateways: no level, only the tool rule they had', async () => {
    const create = vi.fn(async () => empty());
    const prov = new OpenAICompatibleProvider({ type: 'openai-compatible', apiKey: 'k', baseUrl: 'https://gw.example.com/v1' }, model('gpt-6.1-sol', 'openai-compatible'));
    (prov as unknown as { client: unknown }).client = { chat: { completions: { create } } };
    await prov.generateStream({ messages: [{ role: 'user', content: 'hi' }], thinking: 'high' }, () => {});
    expect((create.mock.calls[0] as unknown[])[0]).not.toHaveProperty('reasoning_effort');
  });

  it('Gemini: thinkingConfig in the request config', async () => {
    const generateContentStream = vi.fn(async () => empty());
    const prov = new GeminiProvider({ type: 'gemini', apiKey: 'k' }, model('gemini-3.5-flash', 'gemini'));
    (prov as unknown as { client: unknown }).client = { models: { generateContentStream } };
    await prov.generateStream({ messages: [{ role: 'user', content: 'hi' }], thinking: 'off' }, () => {});
    const req = (generateContentStream.mock.calls[0] as unknown[])[0] as { config: Record<string, unknown> };
    expect(req.config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
  });
});

describe('a thinking level from a socket payload', () => {
  it('takes the four levels, and nothing else', () => {
    for (const level of ['off', 'low', 'medium', 'high']) expect(thinkingLevelFrom(level)).toBe(level);
    for (const bad of ['auto', 'max', '', 3, null, undefined, { level: 'high' }]) expect(thinkingLevelFrom(bad)).toBeUndefined();
  });
});
