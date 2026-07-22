import { describe, it, expect } from 'vitest';
import { isChatModel } from './model-filter.js';

describe('isChatModel — cross-provider non-chat filtering', () => {
  it('keeps real text-chat models across providers', () => {
    const keep = [
      // OpenAI
      'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4-turbo', 'gpt-3.5-turbo',
      'o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini',
      'chatgpt-4o-latest', 'gpt-4-vision-preview', 'computer-use-preview', 'codex-mini-latest',
      // Gemini
      'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemma-3-27b-it', 'learnlm-2.0-flash-experimental',
      // Anthropic
      'claude-opus-4-1', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-20241022',
      // Ollama
      'llama3.1:8b', 'qwen2.5-coder:7b', 'mistral', 'llava:13b', 'deepseek-r1:7b', 'phi3',
    ];
    for (const id of keep) expect(isChatModel(id), id).toBe(true);
  });

  it('drops embeddings, speech, image/video, moderation and legacy base models', () => {
    const drop = [
      // OpenAI
      'text-embedding-3-large', 'text-embedding-ada-002', 'tts-1', 'tts-1-hd', 'gpt-4o-mini-tts',
      'whisper-1', 'dall-e-2', 'dall-e-3', 'gpt-image-1', 'omni-moderation-latest',
      'gpt-4o-realtime-preview', 'gpt-4o-audio-preview', 'babbage-002', 'davinci-002', 'sora',
      // Gemini
      'gemini-2.5-pro-preview-tts', 'gemini-2.5-flash-preview-tts', 'text-embedding-004',
      'gemini-embedding-exp', 'imagen-3.0-generate-002', 'gemini-2.5-flash-image-preview',
      'gemini-2.0-flash-preview-image-generation', 'gemini-2.0-flash-live-001', 'aqa', 'veo-2.0-generate-001',
      // Ollama
      'nomic-embed-text', 'mxbai-embed-large:latest', 'snowflake-arctic-embed',
    ];
    for (const id of drop) expect(isChatModel(id), id).toBe(false);
  });

  it('honours reported generation methods (Gemini) over the name heuristic', () => {
    // Embedder reported by the API — dropped even though the name is plain.
    expect(isChatModel('some-custom-model', ['embedContent'])).toBe(false);
    // Text model with methods present — kept.
    expect(isChatModel('gemini-2.5-flash', ['generateContent', 'countTokens'])).toBe(true);
  });
});
