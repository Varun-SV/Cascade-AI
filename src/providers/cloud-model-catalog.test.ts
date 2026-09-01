import { describe, expect, it } from 'vitest';
import catalog from './cloud-model-catalog.json' with { type: 'json' };

type Entry = {
  id: string;
  providers: string[];
  lifecycle: 'ga' | 'preview';
  contextWindow?: number;
  maxOutputTokens?: number;
};

const models = catalog.models as Entry[];

describe('cloud model catalog', () => {
  it('contains the researched active cloud families', () => {
    const ids = new Set(models.map((m) => m.id));
    for (const id of [
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
      'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-pro-preview',
    ]) expect(ids.has(id)).toBe(true);
  });

  it('contains only GA or Preview lifecycle entries', () => {
    expect(models.every((m) => m.lifecycle === 'ga' || m.lifecycle === 'preview')).toBe(true);
  });

  it('excludes known retired/shutdown chat models from the current snapshot', () => {
    const ids = new Set(models.map((m) => m.id));
    for (const id of [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-3-pro-preview',
      'claude-haiku-3-5-20251001',
    ]) expect(ids.has(id)).toBe(false);
  });

  it('keeps pricing out of the model capability catalog', () => {
    for (const entry of catalog.models as Array<Record<string, unknown>>) {
      expect(entry).not.toHaveProperty('inputCostPer1kTokens');
      expect(entry).not.toHaveProperty('outputCostPer1kTokens');
      expect(entry).not.toHaveProperty('price');
    }
  });

  it('gives every Azure base model enough capability metadata to synthesize a deployment', () => {
    const azure = models.filter((m) => m.providers.includes('azure'));
    expect(azure.length).toBeGreaterThan(0);
    for (const model of azure) {
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
    }
  });
});
