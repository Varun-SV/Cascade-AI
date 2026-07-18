import { describe, it, expect } from 'vitest';
import { LLMReranker, planRetrieval, chatCompleterFromProviders } from '#cascade-ai';

// Confirms the Phase-2 retrieval surface is exported by the vendored SDK bundle
// and behaves as the cloud run pipeline expects (the link/build is the main
// cloud-specific risk; the algorithms themselves are covered in the core suite).
describe('vendored retrieval exports (Phase 2)', () => {
  it('planRetrieval routes none / cag / rag as the doc pipeline relies on', () => {
    expect(planRetrieval({ sourceCount: 0, totalChars: 0, cagCharBudget: 24_000 }).mode).toBe('none');
    expect(planRetrieval({ sourceCount: 1, totalChars: 1_000, cagCharBudget: 24_000 }).mode).toBe('cag');
    expect(planRetrieval({ sourceCount: 1, totalChars: 50_000, cagCharBudget: 24_000 }).mode).toBe('rag');
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
