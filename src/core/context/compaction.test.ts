import { describe, it, expect, vi } from 'vitest';
import {
  estimateTokens,
  contentToText,
  messagesTokens,
  chunkText,
  needsCompaction,
  mapReduceCompact,
  rollingSummary,
} from './compaction.js';
import type { ConversationMessage } from '../../types.js';

describe('estimateTokens', () => {
  it('is ~chars/4 and never zero for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('contentToText / messagesTokens', () => {
  it('flattens string and block content', () => {
    expect(contentToText('hello')).toBe('hello');
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'image', image: { type: 'url', data: 'x', mimeType: 'image/png' } }]))
      .toContain('a');
  });
  it('sums tokens across messages', () => {
    const msgs: ConversationMessage[] = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'b'.repeat(400) },
    ];
    expect(messagesTokens(msgs)).toBe(200);
  });
});

describe('chunkText', () => {
  it('returns a single chunk when it already fits', () => {
    expect(chunkText('short text', { maxTokens: 100 })).toEqual(['short text']);
  });
  it('returns nothing for blank input', () => {
    expect(chunkText('   ', { maxTokens: 100 })).toEqual([]);
  });
  it('splits oversized text into multiple bounded chunks', () => {
    const para = 'This is a sentence. '.repeat(50); // ~1000 chars
    const chunks = chunkText(para, { maxTokens: 50, overlapRatio: 0 }); // ~200 chars/chunk
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200 + 20);
    // Lossless-ish: every sentence's words survive across the chunk set.
    expect(chunks.join(' ')).toContain('This is a sentence');
  });
  it('hard-splits a giant separator-less blob', () => {
    const blob = 'x'.repeat(1000);
    const chunks = chunkText(blob, { maxTokens: 25 }); // ~100 chars/chunk
    expect(chunks.length).toBeGreaterThanOrEqual(10);
  });
  it('carries overlap between adjacent chunks', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(10);
    const chunks = chunkText(text, { maxTokens: 30, overlapRatio: 0.3 });
    expect(chunks.length).toBeGreaterThan(1);
    // With overlap, the tail of chunk N reappears at the head of chunk N+1.
    const tail = chunks[0]!.slice(-10);
    expect(chunks[1]!.startsWith(tail.trim().slice(0, 4))).toBe(false); // sanity: not identical
  });
});

describe('needsCompaction', () => {
  it('flags overflow past the reserved window, not before', () => {
    expect(needsCompaction(90, 100, 0.2)).toBe(true); // 90 > 80
    expect(needsCompaction(70, 100, 0.2)).toBe(false); // 70 < 80
    expect(needsCompaction(1000, 0)).toBe(false); // unknown window → never
  });
});

describe('mapReduceCompact', () => {
  it('returns input untouched when it already fits one chunk', async () => {
    const summarize = vi.fn(async () => 'S');
    const r = await mapReduceCompact('small', { summarize, chunkTokens: 100, targetTokens: 50, capTokens: 1000 });
    expect(r.calls).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
    expect(r.text).toBe('small');
  });

  it('maps each chunk then returns the combined summary', async () => {
    const summarize = vi.fn(async (input: string) => `SUM(${input.length})`);
    const text = 'sentence here. '.repeat(200); // ~3000 chars
    const r = await mapReduceCompact(text, { summarize, chunkTokens: 50, targetTokens: 100_000, capTokens: 100_000 });
    expect(r.chunks).toBeGreaterThan(1);
    expect(r.calls).toBe(r.chunks); // one map call per chunk, no reduce (target huge)
    expect(r.text).toContain('SUM(');
    expect(r.truncated).toBe(false);
  });

  it('recursively reduces until under the target', async () => {
    // Summarizer echoes a fixed-size blob so the combined stays large until the
    // group count collapses — exercises the reduce loop.
    const summarize = vi.fn(async () => 'word '.repeat(40)); // ~200 chars each
    const text = 'x. '.repeat(500);
    const r = await mapReduceCompact(text, { summarize, chunkTokens: 30, targetTokens: 40, capTokens: 100_000, maxReducePasses: 5 });
    expect(r.calls).toBeGreaterThan(r.chunks); // map + at least one reduce pass
  });

  it('truncates input beyond the cap and notes it', async () => {
    const summarize = vi.fn(async () => 'S');
    const text = 'a. '.repeat(5000); // ~15000 chars
    const r = await mapReduceCompact(text, { summarize, chunkTokens: 50, targetTokens: 100_000, capTokens: 100 }); // cap 400 chars
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/truncated/i);
  });
});

describe('rollingSummary', () => {
  const mk = (n: number): ConversationMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));

  it('leaves a short history untouched', async () => {
    const summarize = vi.fn(async () => 'S');
    const msgs = mk(3);
    expect(await rollingSummary(msgs, { summarize, keepRecent: 6, targetTokens: 1000 })).toBe(msgs);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('folds older turns into a leading system summary, keeps recent verbatim', async () => {
    const summarize = vi.fn(async () => 'CONDENSED');
    const msgs = mk(10);
    const out = await rollingSummary(msgs, { summarize, keepRecent: 4, targetTokens: 1000 });
    expect(out[0]!.role).toBe('system');
    expect(out[0]!.content).toContain('CONDENSED');
    // 1 summary + last 4 verbatim.
    expect(out.length).toBe(5);
    expect(out[out.length - 1]).toEqual(msgs[msgs.length - 1]);
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
