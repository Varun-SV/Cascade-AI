import { describe, it, expect } from 'vitest';
import { ModelSelector } from './selector.js';
import type { ModelInfo } from '../../types.js';

function ocModel(id: string): ModelInfo {
  return {
    id, name: id, provider: 'openai-compatible',
    contextWindow: 32_000, isVisionCapable: false,
    inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
    maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
  };
}

describe('ModelSelector — provider attribution for local models', () => {
  it('attributes a configured .gguf model to openai-compatible, not ollama, when both are configured', () => {
    // Regression: a llama.cpp `.gguf` served via an OpenAI-compatible endpoint
    // was mislabeled as Ollama because the heuristic checked ollama first.
    const selector = new ModelSelector(new Set(['ollama', 'openai-compatible']));
    const m = selector.selectForTier('T3', 'gemma-4-12b-it-Q4_K_M.gguf');
    expect(m).not.toBeNull();
    expect(m!.provider).toBe('openai-compatible');
  });

  it('still attributes an Ollama-style family:tag id to ollama', () => {
    const selector = new ModelSelector(new Set(['ollama', 'openai-compatible']));
    expect(selector.selectForTier('T1', 'gemma4:31b')!.provider).toBe('ollama');
    expect(selector.selectForTier('T2', 'qwen3.6:35b')!.provider).toBe('ollama');
  });

  it('prefers an exact discovered model id over the heuristic', () => {
    // When the openai-compatible endpoint's models are discovered, an exact id
    // match must win regardless of the id's surface form.
    const selector = new ModelSelector(new Set(['ollama', 'openai-compatible']));
    selector.addDynamicModel(ocModel('mistral-7b-instruct'));
    expect(selector.selectForTier('T2', 'mistral-7b-instruct')!.provider).toBe('openai-compatible');
  });

  it('honors an explicit provider prefix', () => {
    const selector = new ModelSelector(new Set(['ollama', 'openai-compatible']));
    expect(selector.selectForTier('T3', 'openai-compatible:some-model')!.provider).toBe('openai-compatible');
  });
});
