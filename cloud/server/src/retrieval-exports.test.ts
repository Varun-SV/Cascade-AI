import { describe, it, expect } from 'vitest';
import { LLMReranker, planRetrieval, cagCharBudget, chatCompleterFromProviders, DEFAULT_CONTEXT_LIMIT } from '#cascade-ai';
import type { ProviderConfig } from '#cascade-ai';
import { runContextWindowTokens } from './runs.js';

// Confirms the Phase-2 retrieval surface is exported by the vendored SDK bundle
// and behaves as the cloud run pipeline expects (the link/build is the main
// cloud-specific risk; the algorithms themselves are covered in the core suite).
describe('vendored retrieval exports (Phase 2)', () => {
  it('planRetrieval routes none / cag / rag as the doc pipeline relies on', () => {
    expect(planRetrieval({ sourceCount: 0, totalChars: 0, cagCharBudget: 24_000 }).mode).toBe('none');
    expect(planRetrieval({ sourceCount: 1, totalChars: 1_000, cagCharBudget: 24_000 }).mode).toBe('cag');
    expect(planRetrieval({ sourceCount: 1, totalChars: 50_000, cagCharBudget: 24_000 }).mode).toBe('rag');
  });

  it('a 52 KB document is injected in full, not pushed to retrieval (the reported bug)', () => {
    // Derived budget from a real window admits an ordinary doc in full — no
    // embedder needed, no misleading "truncated" notice.
    const budget = cagCharBudget(runContextWindowTokens([{ type: 'azure', deploymentName: 'gpt-5.4-mini', apiKey: 'x', baseUrl: 'https://x.openai.azure.com' }]));
    expect(planRetrieval({ sourceCount: 1, totalChars: 52 * 1024, cagCharBudget: budget }).mode).toBe('cag');
  });

  it('runContextWindowTokens uses the Azure deployment window, else the SDK default', () => {
    // gpt-5.4-mini resolves to a real (large) window via the deployment name.
    expect(runContextWindowTokens([{ type: 'azure', deploymentName: 'gpt-5.4-mini', apiKey: 'x', baseUrl: 'https://x.openai.azure.com' }]))
      .toBeGreaterThanOrEqual(128_000);
    // No pinned model → conservative default.
    expect(runContextWindowTokens([{ type: 'anthropic', apiKey: 'x' }])).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  // A Fast Answer that pins a model is a SINGLE-model run: that model answers
  // and nothing else in the provider list participates. Taking the minimum
  // across the list then sized the corpus for a window belonging to a model the
  // run would never call — pinning the 1,047,576-token gpt-4.1 next to an
  // unused 128k Azure deployment threw away ~88% of the document allowance.
  describe('runContextWindowTokens and a pinned Fast Answer', () => {
    const azure128k: ProviderConfig = {
      type: 'azure', deploymentName: 'gpt-4o-mini', apiKey: 'x', baseUrl: 'https://x.openai.azure.com',
    };
    const providers: ProviderConfig[] = [azure128k, { type: 'openai', apiKey: 'sk-test' }];

    it('sizes the run by the pinned model, not by a deployment it cannot call', () => {
      expect(runContextWindowTokens(providers), 'the unpinned run is still conservative').toBe(128_000);
      expect(
        runContextWindowTokens(providers, { enabled: true, model: 'openai:gpt-4.1' }),
        'and the pinned Fast Answer gets its own window',
      ).toBe(1_047_576);
    });

    it('resolves a pinned Azure deployment through its provider entry', () => {
      // Azure ids are DEPLOYMENT names and are absent from the model catalog,
      // so a pin that reads as "unknown model" falls back to the very minimum
      // pinning exists to escape.
      const pinned: ProviderConfig = {
        type: 'azure', deploymentName: 'prod-chat', model: 'gpt-4.1', apiKey: 'x', baseUrl: 'https://x.openai.azure.com',
      };
      expect(
        runContextWindowTokens([azure128k, pinned], { enabled: true, model: 'azure:prod-chat' }),
        'the deployment name resolves to the model behind it',
      ).toBe(1_047_576);
    });

    it('resolves a provider-qualified pin by its provider, not by a catalog id it collides with', () => {
      // A deployment is named by whoever created it, so `gpt-4.1` may be the
      // NAME of a deployment configured as something else entirely. Consulting
      // the catalog first handed that deployment gpt-4.1's 1,047,576-token
      // budget when the thing behind it holds 128k — and the run finds out by
      // failing on the provider's own limit.
      const misleading: ProviderConfig = {
        type: 'azure', deploymentName: 'gpt-4.1', model: 'gpt-4o-mini', apiKey: 'x', baseUrl: 'https://x.openai.azure.com',
      };
      expect(
        runContextWindowTokens([misleading], { enabled: true, model: 'azure:gpt-4.1' }),
        'the deployment behind the name is what the run will actually call',
      ).toBe(128_000);
    });

    it('stays conservative when the run is not a single pinned model', () => {
      // Without Fast Answer the router may reach any configured provider, so
      // the smallest window is the only one the corpus is safe against.
      expect(runContextWindowTokens(providers, { model: 'openai:gpt-4.1' })).toBe(128_000);
      // An id nothing can resolve means we do not know what will answer.
      expect(runContextWindowTokens(providers, { enabled: true, model: 'openai:not-a-model' })).toBe(128_000);
    });
  });

  it('LLMReranker reorders candidates via the provided completer', async () => {
    const reranker = new LLMReranker({ complete: async () => '2,1' });
    const out = await reranker.rerank('q', [
      { id: 'a', text: 'first', sourceId: 's', ord: 0, score: 0 },
      { id: 'b', text: 'second', sourceId: 's', ord: 1, score: 0 },
    ], 2);
    expect(out.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('chatCompleterFromProviders returns null without a chat-capable provider', () => {
    expect(chatCompleterFromProviders([])).toBeNull();
    expect(chatCompleterFromProviders([{ type: 'anthropic', apiKey: 'x' }])).toBeNull();
    expect(chatCompleterFromProviders([{ type: 'openai', apiKey: 'x' }])).toBeTypeOf('function');
  });
});
