import { describe, it, expect } from 'vitest';
import { LLMReranker, parseRankOrder } from './rerank.js';
import { planRetrieval } from './plan.js';
import type { ScoredChunk } from './types.js';

const chunk = (id: string, text: string, score = 0): ScoredChunk => ({ id, text, sourceId: 's', ord: 0, score });

describe('parseRankOrder', () => {
  it('parses a comma list into 0-based indices', () => {
    expect(parseRankOrder('3, 1, 4', 5)).toEqual([2, 0, 3]);
  });
  it('drops out-of-range and duplicate entries', () => {
    expect(parseRankOrder('2, 2, 9, 1', 3)).toEqual([1, 0]);
  });
  it('tolerates prose around the numbers', () => {
    expect(parseRankOrder('The order is 2 then 1.', 2)).toEqual([1, 0]);
  });
  it('returns null when nothing parses', () => {
    expect(parseRankOrder('none relevant', 3)).toBeNull();
  });
});

describe('LLMReranker', () => {
  const cands = [chunk('a', 'about cats'), chunk('b', 'about dogs'), chunk('c', 'about taxes')];

  it('reorders candidates per the model verdict', async () => {
    const reranker = new LLMReranker({ complete: async () => '3,1' }); // c, a
    const out = await reranker.rerank('q', cands, 2);
    expect(out.map((c) => c.id)).toEqual(['c', 'a']);
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it('falls back to input order when the model reply is unparseable', async () => {
    const reranker = new LLMReranker({ complete: async () => 'sorry, no idea' });
    const out = await reranker.rerank('q', cands, 3);
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to input order when the completion throws', async () => {
    const reranker = new LLMReranker({ complete: async () => { throw new Error('rate limit'); } });
    const out = await reranker.rerank('q', cands, 2);
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('backfills omitted candidates to satisfy topK', async () => {
    const reranker = new LLMReranker({ complete: async () => '2' }); // only picks b
    const out = await reranker.rerank('q', cands, 3);
    expect(out).toHaveLength(3);
    expect(out[0]!.id).toBe('b');
    expect(new Set(out.map((c) => c.id))).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('planRetrieval', () => {
  const budget = 24_000;
  it('injects in full (cag) for a fast answer with sources, skipping retrieval', () => {
    expect(planRetrieval({ sourceCount: 2, totalChars: 999_999, cagCharBudget: budget, fastAnswer: true }).mode).toBe('cag');
  });
  it('is none for a fast answer with no sources', () => {
    expect(planRetrieval({ sourceCount: 0, totalChars: 0, cagCharBudget: budget, fastAnswer: true }).mode).toBe('none');
  });
  it('is none with no sources', () => {
    expect(planRetrieval({ sourceCount: 0, totalChars: 0, cagCharBudget: budget }).mode).toBe('none');
  });
  it('is cag when sources fit the budget', () => {
    expect(planRetrieval({ sourceCount: 1, totalChars: 5_000, cagCharBudget: budget }).mode).toBe('cag');
  });
  it('is rag when sources exceed the budget', () => {
    expect(planRetrieval({ sourceCount: 1, totalChars: 60_000, cagCharBudget: budget }).mode).toBe('rag');
  });
});
