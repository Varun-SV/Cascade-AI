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
    const selector = new ModelSelector(new Set(['ollama', 'openai-compatible']));
    selector.addDynamicModel(ocModel('mistral-7b-instruct'));
    expect(selector.selectForTier('T2', 'mistral-7b-instruct')!.provider).toBe('openai-compatible');
  });

  it('attributes a full Windows .gguf path to openai-compatible', () => {
    const selector = new ModelSelector(new Set(['ollama', 'openai-compatible']));
    const m = selector.selectForTier('T3', 'C:\\models\\gemma-4-12b-it-Q4_K_M.gguf');
    expect(m).not.toBeNull();
    expect(m!.provider).toBe('openai-compatible');
    expect(m!.id).toBe('C:\\models\\gemma-4-12b-it-Q4_K_M.gguf');
  });

  it('honors an explicit provider prefix', () => {
    const selector = new ModelSelector(new Set(['ollama', 'openai-compatible']));
    expect(selector.selectForTier('T3', 'openai-compatible:some-model')!.provider).toBe('openai-compatible');
  });

  it('prefers an already-registered model over a blank synthetic one when addressed with a "provider:id" override', () => {
    const selector = new ModelSelector(new Set(['azure']));
    const real: ModelInfo = {
      id: 'gpt-5.4-mini', name: 'Prod GPT-5.4-mini', provider: 'azure',
      contextWindow: 128_000, isVisionCapable: false,
      inputCostPer1kTokens: 0.0025, outputCostPer1kTokens: 0.01,
      maxOutputTokens: 16_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
    };
    selector.addDynamicModel(real);
    const m = selector.selectForTier('T1', 'azure:gpt-5.4-mini');
    expect(m).toBe(real);
    expect(m!.inputCostPer1kTokens).toBeGreaterThan(0);
  });

  it('still synthesizes a placeholder when no registered model matches the stripped id', () => {
    const selector = new ModelSelector(new Set(['azure']));
    const m = selector.selectForTier('T1', 'azure:some-other-deployment');
    expect(m).not.toBeNull();
    expect(m!.id).toBe('some-other-deployment');
    expect(m!.provider).toBe('azure');
  });
});

function geminiModel(id: string): ModelInfo {
  return {
    id, name: id, provider: 'gemini',
    contextWindow: 1_000_000, isVisionCapable: true,
    inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
    maxOutputTokens: 8_000, supportsStreaming: true, isLocal: false,
  };
}

describe('ModelSelector — provider model validation (discovery)', () => {
  it('auto-selection only ever picks a validated model, never an un-validated one', () => {
    const selector = new ModelSelector(new Set(['gemini']));
    selector.addDynamicModel(geminiModel('gemini-real'));
    selector.addDynamicModel(geminiModel('gemini-phantom'));
    selector.setValidatedModels('gemini', ['gemini-real']);

    for (const tier of ['T1', 'T2', 'T3'] as const) {
      const m = selector.selectForTier(tier);
      expect(m, tier).not.toBeNull();
      expect(m!.id, tier).toBe('gemini-real');
    }
  });

  it('normalizes ids so a "models/" prefix matches the bare id', () => {
    const selector = new ModelSelector(new Set(['gemini']));
    selector.addDynamicModel(geminiModel('gemini-2.5-flash'));
    selector.setValidatedModels('gemini', ['models/gemini-2.5-flash']);
    expect(selector.selectForTier('T3')!.id).toBe('gemini-2.5-flash');
  });

  it('without validation, selection is unchanged (no filtering)', () => {
    const selector = new ModelSelector(new Set(['gemini']));
    selector.addDynamicModel(geminiModel('gemini-phantom'));
    expect(selector.selectForTier('T3')).not.toBeNull();
  });

  it('an empty discovery result is ignored (keeps the static catalog usable)', () => {
    const selector = new ModelSelector(new Set(['gemini']));
    selector.addDynamicModel(geminiModel('gemini-real'));
    selector.setValidatedModels('gemini', []);
    expect(selector.selectForTier('T3')).not.toBeNull();
  });

  it('lets a live-discovered non-catalog model compete in AUTO tier candidates', () => {
    const selector = new ModelSelector(new Set(['gemini']));
    const futureModel = 'gemini-9-flash';
    expect(selector.getCandidatesForTier('T3').some((m) => m.id === futureModel)).toBe(false);
    selector.addDynamicModel(geminiModel(futureModel));
    expect(selector.getCandidatesForTier('T3').some((m) => m.id === futureModel)).toBe(true);
  });
});

describe('ModelSelector — explicit tier pin whose model id contains a slash', () => {
  it('resolves a "provider:owner/model" pin to the right provider and id', () => {
    const selector = new ModelSelector(new Set(['openai-compatible', 'anthropic']));
    const m = selector.selectForTier('T1', 'openai-compatible:openai/gpt-4o');
    expect(m).not.toBeNull();
    expect(m!.provider).toBe('openai-compatible');
    expect(m!.id).toBe('openai/gpt-4o');
  });

  it('keeps the whole owner/model id even when the prefix split could swallow it', () => {
    const selector = new ModelSelector(new Set(['openai-compatible', 'anthropic']));
    const m = selector.selectForTier('T2', 'openai-compatible:meta/Llama-3.3-70B-Instruct');
    expect(m!.id).toBe('meta/Llama-3.3-70B-Instruct');
    expect(m!.provider).toBe('openai-compatible');
  });

  it('does not synthesize a pin when the named provider is not configured', () => {
    const selector = new ModelSelector(new Set(['anthropic']));
    expect(selector.selectForTier('T1', 'openai-compatible:openai/gpt-4o')).toBeNull();
  });
});

describe('ModelSelector — a live-discovered model stays out of Cascade Auto scoring', () => {
  it('a discovered model whose provider has no static catalog entry never enters the scored pool', () => {
    const selector = new ModelSelector(new Set(['openai-compatible', 'gemini']));
    selector.addDynamicModel({
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'openai-compatible',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    });
    for (const tier of ['T1', 'T2', 'T3'] as const) {
      expect(selector.getCandidatesForTier(tier).some((m) => m.provider === 'openai-compatible'), tier).toBe(false);
    }
    expect(selector.selectForTier('T1', 'openai-compatible:openai/gpt-4o')!.provider).toBe('openai-compatible');
  });
});

describe('ModelSelector — getNextFallback for a dynamically-resolved pin', () => {
  it('falls over to another usable model when the failed id is not in the static priority chain', () => {
    const selector = new ModelSelector(new Set(['openai-compatible', 'anthropic']));
    selector.addDynamicModel({
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'openai-compatible',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    });
    const fallback = selector.getNextFallback('openai/gpt-4o', 'T1');
    expect(fallback).not.toBeNull();
    expect(fallback!.provider).toBe('anthropic');
  });

  it('still returns null when no other provider has anything usable', () => {
    const selector = new ModelSelector(new Set(['openai-compatible']));
    selector.addDynamicModel({
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'openai-compatible',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    });
    expect(selector.getNextFallback('openai/gpt-4o', 'T1')).toBeNull();
  });

  it('leaves the existing priority-chain walk unchanged for a statically-known model', () => {
    const selector = new ModelSelector(new Set(['anthropic', 'openai', 'gemini']));
    const next = selector.getNextFallback('claude-opus-4', 'T1');
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe('claude-opus-4');
  });

  it('falls to a dynamic model when a STATIC model fails and the rest of its chain is also unusable', () => {
    const selector = new ModelSelector(new Set(['openai-compatible']));
    selector.addDynamicModel({
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o (via a local endpoint)', provider: 'openai-compatible',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    });
    const fallback = selector.getNextFallback('gpt-4o', 'T1');
    expect(fallback).not.toBeNull();
    expect(fallback!.provider).toBe('openai-compatible');
  });
});

describe('ModelSelector — selectVisionModel for a dynamically-discovered model', () => {
  it('finds a live-discovered vision-capable model when nothing in the static priority list matches', () => {
    const selector = new ModelSelector(new Set(['openai-compatible']));
    selector.addDynamicModel({
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'openai-compatible',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    });
    const vision = selector.selectVisionModel();
    expect(vision).not.toBeNull();
    expect(vision!.provider).toBe('openai-compatible');
    expect(vision!.id).toBe('openai/gpt-4o');
  });

  it('ignores a dynamically-discovered model with no vision capability', () => {
    const selector = new ModelSelector(new Set(['openai-compatible']));
    selector.addDynamicModel({
      id: 'meta/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B', provider: 'openai-compatible',
      contextWindow: 128_000, isVisionCapable: false,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    });
    expect(selector.selectVisionModel()).toBeNull();
  });

  it('still prefers the static VISION_MODEL_PRIORITY list when it has a match', () => {
    const selector = new ModelSelector(new Set(['anthropic', 'openai-compatible']));
    selector.addDynamicModel({
      id: 'openai/gpt-4o', name: 'OpenAI GPT-4o', provider: 'openai-compatible',
      contextWindow: 128_000, isVisionCapable: true,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, pricingUnknown: false,
      maxOutputTokens: 4_000, supportsStreaming: true, supportsToolUse: true, isLocal: false,
    });
    const vision = selector.selectVisionModel();
    expect(vision).not.toBeNull();
    expect(vision!.provider).toBe('anthropic');
  });
});