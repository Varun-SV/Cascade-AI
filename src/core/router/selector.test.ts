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

  it('attributes a full Windows .gguf path to openai-compatible', () => {
    // llama.cpp models are often configured by absolute path, e.g.
    // `C:\models\gemma4.gguf`. The drive-letter colon must not be mistaken for a
    // provider prefix, and the path must resolve to openai-compatible.
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
    // Regression: an Azure deployment (or any dynamic model) registered under
    // its bare id with real pricing/context/tool-support was being discarded
    // the moment the user picked it as "azure:<deployment>" — selectForTier
    // synthesized a fresh $0/generic placeholder instead of reusing the real
    // one, silently losing cost tracking and capability metadata.
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
    selector.addDynamicModel(geminiModel('gemini-phantom'));   // present in catalog, not served by the key
    selector.setValidatedModels('gemini', ['gemini-real']);    // only this one is real

    for (const tier of ['T1', 'T2', 'T3'] as const) {
      const m = selector.selectForTier(tier);
      expect(m, tier).not.toBeNull();
      // Never the phantom, and (since only gemini is available) never a bundled
      // catalog id the key didn't confirm.
      expect(m!.id, tier).toBe('gemini-real');
    }
  });

  it('normalizes ids so a "models/" prefix matches the bare id', () => {
    const selector = new ModelSelector(new Set(['gemini']));
    selector.addDynamicModel(geminiModel('gemini-2.5-flash'));
    selector.setValidatedModels('gemini', ['models/gemini-2.5-flash']); // Gemini prefix form
    expect(selector.selectForTier('T3')!.id).toBe('gemini-2.5-flash');
  });

  it('without validation, selection is unchanged (no filtering)', () => {
    const selector = new ModelSelector(new Set(['gemini']));
    selector.addDynamicModel(geminiModel('gemini-phantom'));
    // No setValidatedModels call → the model is selectable as before.
    expect(selector.selectForTier('T3')).not.toBeNull();
  });

  it('an empty discovery result is ignored (keeps the static catalog usable)', () => {
    const selector = new ModelSelector(new Set(['gemini']));
    selector.addDynamicModel(geminiModel('gemini-real'));
    selector.setValidatedModels('gemini', []); // discovery returned nothing → ignore
    expect(selector.selectForTier('T3')).not.toBeNull();
  });

  it('lets a live-discovered non-catalog model compete in AUTO tier candidates', () => {
    const selector = new ModelSelector(new Set(['gemini']));
    // Previously invisible to AUTO ranking: getCandidatesForTier only walked the
    // static priority chain, so a model the provider reported that isn't in the
    // bundled catalog never got scored. It should now be a candidate for a tier
    // that routes to its provider.
    expect(selector.getCandidatesForTier('T3').some((m) => m.id === 'gemini-3.5-flash')).toBe(false);
    selector.addDynamicModel(geminiModel('gemini-3.5-flash'));
    expect(selector.getCandidatesForTier('T3').some((m) => m.id === 'gemini-3.5-flash')).toBe(true);
  });
});
