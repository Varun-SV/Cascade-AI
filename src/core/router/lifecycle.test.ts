// ─────────────────────────────────────────────
//  Cascade AI — Model lifecycle
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { describeLifecycle, excludedFromAuto, lifecycleOf } from './lifecycle.js';
import { ModelSelector } from './selector.js';
import { MODELS, T1_MODEL_PRIORITY, T2_MODEL_PRIORITY, T3_MODEL_PRIORITY, VISION_MODEL_PRIORITY } from '../../constants.js';
import type { ModelInfo, ProviderType } from '../../types.js';

const m = (id: string, provider: ProviderType, extra: Partial<ModelInfo> = {}) =>
  ({ id, name: id, provider, ...extra }) as ModelInfo;

describe('lifecycleOf', () => {
  it('knows what each provider has shut down', () => {
    expect(lifecycleOf(m('claude-sonnet-4-20250514', 'anthropic'))?.status).toBe('retired');
    expect(lifecycleOf(m('claude-3-7-sonnet-20250219', 'anthropic'))?.status).toBe('retired');
    expect(lifecycleOf(m('gpt-4.1-nano', 'openai'))?.status).toBe('retired');
    expect(lifecycleOf(m('o4-mini', 'openai'))?.status).toBe('retired');
    expect(lifecycleOf(m('gemini-2.0-flash', 'gemini'))?.status).toBe('retired');
  });

  it('knows what each provider is shutting down, and when', () => {
    expect(lifecycleOf(m('claude-sonnet-4-5-20250929', 'anthropic'))).toMatchObject({ status: 'deprecated', shutdown: '2026-11-30' });
    expect(lifecycleOf(m('gpt-4o', 'openai'))).toMatchObject({ status: 'deprecated', shutdown: '2027-01-14' });
    expect(lifecycleOf(m('gpt-5-mini-2025-08-07', 'openai'))).toMatchObject({ status: 'deprecated', shutdown: '2026-12-11' });
  });

  it('flags models that answer some accounts and refuse others', () => {
    expect(lifecycleOf(m('gemini-2.5-flash', 'gemini'))?.status).toBe('restricted');
    expect(lifecycleOf(m('models/gemini-2.5-pro', 'gemini'))?.status).toBe('restricted');
  });

  it('flags ids the provider silently routes to a newer model', () => {
    expect(lifecycleOf(m('gemini-3.7-flash', 'gemini'))).toMatchObject({ status: 'superseded', replacement: 'gemini-3.8-flash' });
  });

  it('leaves current models alone, including ones whose names contain an old one', () => {
    for (const [id, provider] of [
      ['claude-opus-5-5', 'anthropic'], ['claude-haiku-4-5-20251001', 'anthropic'], ['claude-opus-4-5-20251101', 'anthropic'],
      ['gpt-5.4', 'openai'], ['gpt-5.4-mini', 'openai'], ['gpt-5.5', 'openai'], ['gpt-6.1-sol', 'openai'], ['gpt-5.2', 'openai'],
      ['gemini-3.8-flash', 'gemini'], ['gemini-3.5-flash-lite', 'gemini'], ['gemini-3.6-flash', 'gemini'],
    ] as const) {
      expect(lifecycleOf(m(id, provider)), id).toBeNull();
    }
  });

  it('applies only to the provider\'s own API, which is what it was published for', () => {
    // Azure, Bedrock and gateways keep their own schedules.
    expect(lifecycleOf(m('prod-4o', 'azure', { baseModelId: 'gpt-4o' }))).toBeNull();
    expect(lifecycleOf(m('gpt-4o', 'openai-compatible'))).toBeNull();
  });

  it('reads a deployment\'s base model and strips gateway prefixes', () => {
    expect(lifecycleOf(m('openai:gpt-4o', 'openai'))?.status).toBe('deprecated');
  });

  it('describes itself for /why', () => {
    expect(describeLifecycle(lifecycleOf(m('gpt-4o', 'openai'))!))
      .toBe('deprecated by its provider (shuts down 2027-01-14); provider recommends gpt-6-luna');
  });
});

describe('the bundled tier chains', () => {
  it('contain only models their provider still fully serves', () => {
    for (const [name, chain] of Object.entries({ T1_MODEL_PRIORITY, T2_MODEL_PRIORITY, T3_MODEL_PRIORITY, VISION_MODEL_PRIORITY })) {
      for (const id of chain) {
        const model = MODELS[id];
        expect(model, `${name}: ${id} is not in MODELS`).toBeDefined();
        expect(excludedFromAuto(model!), `${name}: ${id}`).toBe(false);
      }
    }
  });
});

describe('ModelSelector with the lifecycle', () => {
  it('keeps phased-out models out of Auto\'s candidates', () => {
    const selector = new ModelSelector(new Set<ProviderType>(['openai', 'gemini']));
    // A discovered id the provider still answers but is shutting down.
    selector.addDynamicModel({ ...MODELS['gpt-5.4']!, id: 'gpt-5-nano', name: 'gpt-5-nano' });
    for (const tier of ['T1', 'T2', 'T3'] as const) {
      const ids = selector.getCandidatesForTier(tier).map((c) => c.id);
      expect(ids.filter((id) => excludedFromAuto(selector.getModelById(id)!)), tier).toEqual([]);
    }
  });

  it('still uses a phased-out model when nothing else can serve', () => {
    const selector = new ModelSelector(new Set<ProviderType>(['gemini']));
    selector.setValidatedModels('gemini', ['gemini-2.5-flash']);
    expect(selector.selectForTier('T2')?.id).toBe('gemini-2.5-flash');
    expect(selector.getCandidatesForTier('T3').map((c) => c.id)).toEqual([]);
  });

  it('lets a user pin a phased-out model', () => {
    const selector = new ModelSelector(new Set<ProviderType>(['openai']));
    expect(selector.selectForTier('T1', 'gpt-4o')?.id).toBe('gpt-4o');
  });

  it('fails over to a model still in service before a phased-out one', () => {
    const selector = new ModelSelector(new Set<ProviderType>(['openai']));
    const next = selector.getNextFallback('gpt-6.1-sol', 'T1');
    expect(next).not.toBeNull();
    expect(excludedFromAuto(next!)).toBe(false);
  });
});
