import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ModelInfo } from '../types.js';

const seed: ModelInfo = {
  id: 'openai-compatible', name: 'openai-compatible', provider: 'openai-compatible',
  contextWindow: 32_000, isVisionCapable: false,
  inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
  maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
};

describe('OpenAICompatibleProvider construction', () => {
  const prevKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  });

  it('constructs without an apiKey and with no OPENAI_API_KEY env var set', () => {
    // Regression: local servers (llama.cpp / LM Studio / vLLM without
    // --api-key) need no key, so config.apiKey is legitimately undefined.
    // The underlying `openai` SDK throws in its own constructor whenever
    // apiKey is undefined and OPENAI_API_KEY isn't set in the environment —
    // and that constructor ran via `super(config, model)` before this
    // subclass could apply its "not-required" fallback, so every endpoint
    // discovery attempt threw regardless of the configured base URL.
    delete process.env.OPENAI_API_KEY;
    expect(() => new OpenAICompatibleProvider(
      { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:8900/v1' },
      seed,
    )).not.toThrow();
  });
});
