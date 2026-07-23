import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiProvider } from './gemini.js';
import type { ModelInfo } from '../types.js';

const MODEL: ModelInfo = {
  id: 'gemini-2.5-flash',
  name: 'Gemini 2.5 Flash',
  provider: 'gemini',
  contextWindow: 1_000_000,
  isVisionCapable: true,
  inputCostPer1kTokens: 0,
  outputCostPer1kTokens: 0,
  maxOutputTokens: 8_000,
  supportsStreaming: true,
  isLocal: false,
  supportsToolUse: true,
};

// Builds a fake @google/genai streaming response as an async iterable of chunks.
function fakeStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function providerWithStream(chunks: unknown[]): GeminiProvider {
  const p = new GeminiProvider({ type: 'gemini', apiKey: 'test' }, MODEL);
  // Replace the real client with a stub that returns our canned stream.
  (p as unknown as { client: unknown }).client = {
    models: { generateContentStream: vi.fn(async () => fakeStream(chunks)) },
  };
  return p;
}

describe('GeminiProvider — part extraction', () => {
  it('keeps answer text, skips private "thought" parts, and captures functionCall', async () => {
    // A thinking-model response: a thought part, real answer text, and a tool call
    // in the same stream — the exact shape whose `chunk.text` getter warned and
    // could come back empty.
    const provider = providerWithStream([
      { candidates: [{ content: { parts: [{ thought: true, text: 'let me think...' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Hello, ' }, { text: 'world.' }] } }] },
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'x' } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      },
    ]);

    const streamed: string[] = [];
    const result = await provider.generateStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      (c) => { if (c.text) streamed.push(c.text); },
    );

    // The answer text is preserved; the "thought" text is NOT folded in.
    expect(result.content).toBe('Hello, world.');
    expect(result.content).not.toContain('let me think');
    expect(streamed.join('')).toBe('Hello, world.');
    // The function call is surfaced as a tool call.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.name).toBe('web_search');
    expect(result.finishReason).toBe('tool_use');
  });

  it('returns empty content (not a crash) when the model emits only a thought part', async () => {
    const provider = providerWithStream([
      { candidates: [{ content: { parts: [{ thought: true, text: 'thinking only' }] }, finishReason: 'STOP' }] },
    ]);
    const result = await provider.generateStream({ messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(result.content).toBe('');
  });
});

describe('GeminiProvider — model listing filters out non-text models', () => {
  it('listModels drops TTS/embedding models the API returns', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1000000, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-pro-preview-tts', displayName: 'Gemini 2.5 Pro TTS', inputTokenLimit: 8000, outputTokenLimit: 16000, supportedGenerationMethods: ['countTokens', 'generateContent'] },
          { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', inputTokenLimit: 2048, outputTokenLimit: 1, supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GeminiProvider({ type: 'gemini', apiKey: 'test' }, MODEL);
    const models = await provider.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain('gemini-2.5-flash');
    expect(ids).not.toContain('gemini-2.5-pro-preview-tts');
    expect(ids).not.toContain('text-embedding-004');
  });

  afterEach(() => vi.unstubAllGlobals());
});
