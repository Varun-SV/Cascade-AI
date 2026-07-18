import { describe, it, expect } from 'vitest';
import { chunkText } from './chunk.js';

describe('chunkText', () => {
  it('returns nothing for empty/whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const out = chunkText('A short paragraph about cats.');
    expect(out).toHaveLength(1);
    expect(out[0]!.ord).toBe(0);
    expect(out[0]!.text).toContain('cats');
  });

  it('splits long text into ordered, size-bounded chunks', () => {
    const para = 'Sentence about retrieval systems and embeddings. '.repeat(20); // ~1000 chars
    const doc = Array.from({ length: 8 }, (_, i) => `# Section ${i}\n\n${para}`).join('\n\n');
    const out = chunkText(doc, { targetChars: 1000, overlapChars: 100 });
    expect(out.length).toBeGreaterThan(1);
    out.forEach((c, i) => expect(c.ord).toBe(i));
    // No chunk grossly exceeds the target (allow overlap slack).
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(1000 + 300);
  });

  it('carries overlap between consecutive chunks', () => {
    const blocks = Array.from({ length: 6 }, (_, i) => `Block ${i} ` + 'word '.repeat(80)).join('\n\n');
    const out = chunkText(blocks, { targetChars: 600, overlapChars: 120 });
    expect(out.length).toBeGreaterThan(2);
    // The tail of chunk 0 should reappear at the head of chunk 1.
    const tail = out[0]!.text.slice(-40).trim().split(/\s+/).slice(-3).join(' ');
    expect(out[1]!.text).toContain(tail);
  });

  it('hard-splits a single oversized block', () => {
    const monster = 'x'.repeat(5000); // no sentence/paragraph boundaries
    const out = chunkText(monster, { targetChars: 1000, overlapChars: 0 });
    expect(out.length).toBeGreaterThanOrEqual(5);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(1000);
  });
});
