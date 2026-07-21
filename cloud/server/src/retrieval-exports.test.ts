import { describe, it, expect } from 'vitest';
import { LLMReranker, planRetrieval, cagCharBudget, chatCompleterFromProviders, DEFAULT_CONTEXT_LIMIT } from '#cascade-ai';
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
