// ─────────────────────────────────────────────
//  Cascade AI — "confirmed by the endpoint" vs "the bundled list"
// ─────────────────────────────────────────────
//
//  `BaseProvider.listModels({ staticFallback })` exists because the two answers
//  are not interchangeable. Returning the bundled catalogue when live discovery
//  fails is right for a settings list and wrong for router validation, which
//  reads a non-empty result as "the endpoint confirmed these ids", caches it,
//  and pins Auto to them — so a 401, a refused cross-origin redirect or an
//  outage was recorded as confirmation of the PUBLIC catalogue.
//
//  Anthropic honoured the flag from the start; OpenAI and Gemini accepted the
//  parameter and ignored it, which is worse than not having it — the router
//  asked for confirmed models and was answered with a guess.

import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai.js';
import { GeminiProvider } from './gemini.js';
import { MODELS } from '../constants.js';
import type { ModelInfo } from '../types.js';

const modelFor = (provider: string): ModelInfo =>
  Object.values(MODELS).find((m) => m.provider === provider)!;

describe('listModels honours staticFallback across providers', () => {
  it('OpenAI: nothing on failure when fallback is refused, catalogue otherwise', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));
    try {
      const p = new OpenAIProvider({ type: 'openai', apiKey: 'k' }, modelFor('openai'));
      expect(await p.listModels({ staticFallback: false })).toEqual([]);
      expect((await p.listModels()).length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('Gemini: nothing on a 401 when fallback is refused, catalogue otherwise', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"error":{}}', { status: 401 }));
    try {
      const p = new GeminiProvider({ type: 'gemini', apiKey: 'k' }, modelFor('gemini'));
      expect(await p.listModels({ staticFallback: false })).toEqual([]);
      expect((await p.listModels()).length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});
