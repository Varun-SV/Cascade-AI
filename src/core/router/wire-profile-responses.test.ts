import { describe, expect, it } from 'vitest';
import { CascadeRouter } from './index.js';
import { wireProfile, wireProfileFor } from './wire-profile.js';
import { OpenAIProvider } from '../../providers/openai.js';
import { ChatGptProvider } from '../../providers/chatgpt.js';
import { MODELS } from '../../constants.js';
import type { ChatGptAuth } from '../../auth/chatgpt/manager.js';
import type { ConversationMessage, GenerateOptions, ModelInfo } from '../../types.js';

// A tool result whose content is an ARRAY. The Responses serializer submits it
// whole, JSON.stringify()d, into function_call_output.output.
const BIG = 'RESPONSES_TOOL_PAYLOAD '.repeat(4000);
const toolArray: ConversationMessage = {
  role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: BIG }] as never,
};
const history: ConversationMessage[] = [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', input: { path: 'a' } }] },
  toolArray,
];

const planModel: ModelInfo = {
  id: 'chatgpt:gpt-5.5', baseModelId: 'gpt-5.5', name: 'GPT-5.5', provider: 'chatgpt', contextWindow: 272_000,
  isVisionCapable: true, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 32_000, supportsStreaming: true, isLocal: false,
};
const sol: ModelInfo = { ...Object.values(MODELS).find((m) => m.provider === 'openai')!, id: 'gpt-6.1-sol' };

function serialized(provider: 'chatgpt' | 'openai'): string {
  const p = provider === 'chatgpt'
    ? new ChatGptProvider({ type: 'chatgpt' }, planModel, { auth: { planReady: () => true } as unknown as ChatGptAuth })
    : new OpenAIProvider({ type: 'openai', apiKey: 'k' }, sol);
  return JSON.stringify((p as unknown as { convertToResponsesInput(m: ConversationMessage[]): unknown }).convertToResponsesInput(history));
}

function estimate(model: ModelInfo, options: GenerateOptions): number {
  const router = new CascadeRouter();
  return (router as unknown as { estimateInputTokens(o: GenerateOptions, m: ModelInfo): number }).estimateInputTokens(options, model);
}

describe('the Responses wire profile matches what the Responses serializer sends', () => {
  it('the serializer really does submit a tool result array whole', () => {
    expect(serialized('chatgpt')).toContain('RESPONSES_TOOL_PAYLOAD');
    expect(serialized('openai')).toContain('RESPONSES_TOOL_PAYLOAD');
  });

  it('chatgpt: a tool result array is charged in full (it was read as dropped)', () => {
    expect(wireProfile('chatgpt').blockHandling(toolArray)).toBe('stringified');
    const tokens = estimate(planModel, { messages: history });
    expect(tokens).toBeGreaterThan(BIG.length / 8);
  });

  it('chatgpt: tool calls are sized as namespaced function_call items', () => {
    const wire = wireProfile('chatgpt');
    expect(wire.sendsToolCalls(history[1]!)).toBe(true);
    expect(JSON.stringify(wire.sizeToolCalls(history[1]!.toolCalls!))).toContain('"namespace":"cascade"');
    expect(JSON.stringify(wire.sizeTools([{ name: 'read', description: 'd', inputSchema: { type: 'object' } }]))).toContain('"type":"namespace"');
  });

  it('openai: a tools request on a Responses-only model uses the Responses rules; without tools it stays on Chat Completions', () => {
    expect(wireProfileFor(sol, true).blockHandling(toolArray)).toBe('stringified');
    expect(wireProfileFor(sol, false).blockHandling(toolArray)).toBe('dropped');
    const withTools = estimate(sol, { messages: history, tools: [{ name: 'read', description: 'd', inputSchema: { type: 'object' } }] });
    const chatOnly = estimate({ ...sol, id: 'gpt-4o' }, { messages: history, tools: [{ name: 'read', description: 'd', inputSchema: { type: 'object' } }] });
    expect(withTools).toBeGreaterThan(BIG.length / 8);
    expect(chatOnly).toBeLessThan(BIG.length / 16);
  });
});
