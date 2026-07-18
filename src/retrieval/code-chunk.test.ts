import { describe, it, expect } from 'vitest';
import { chunkCode } from './code-chunk.js';
import { buildManifest, diffManifest, hashContent } from './manifest.js';

describe('chunkCode', () => {
  it('returns nothing for empty input', () => {
    expect(chunkCode('')).toEqual([]);
    expect(chunkCode('   \n\n')).toEqual([]);
  });

  it('keeps a small function intact as one chunk', () => {
    const src = `function add(a, b) {\n  return a + b;\n}`;
    const out = chunkCode(src);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('function add');
  });

  it('splits at definition boundaries and packs small ones', () => {
    const fns = Array.from({ length: 8 }, (_, i) => `function f${i}() {\n  return ${i};\n}`).join('\n\n');
    const out = chunkCode(fns, { targetChars: 120 });
    expect(out.length).toBeGreaterThan(1);
    out.forEach((c, i) => expect(c.ord).toBe(i));
    // A boundary should start a chunk near a function definition.
    expect(out.some((c) => /function f\d/.test(c.text))).toBe(true);
  });

  it('hard-splits a single oversized definition by lines', () => {
    const body = Array.from({ length: 200 }, (_, i) => `  const x${i} = ${i};`).join('\n');
    const src = `function huge() {\n${body}\n}`;
    const out = chunkCode(src, { targetChars: 400 });
    expect(out.length).toBeGreaterThan(3);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(400 + 120);
  });

  it('handles python def/class boundaries', () => {
    const src = `class A:\n    def m(self):\n        return 1\n\ndef top():\n    return 2`;
    const out = chunkCode(src, { targetChars: 40 });
    expect(out.some((c) => c.text.includes('class A'))).toBe(true);
    expect(out.some((c) => c.text.includes('def top'))).toBe(true);
  });
});

describe('file manifest', () => {
  it('builds a stable root over the same files regardless of input order', () => {
    const a = buildManifest([{ path: 'a.ts', hash: '1' }, { path: 'b.ts', hash: '2' }]);
    const b = buildManifest([{ path: 'b.ts', hash: '2' }, { path: 'a.ts', hash: '1' }]);
    expect(a.root).toBe(b.root);
  });

  it('diffs added / changed / removed / unchanged', () => {
    const oldM = buildManifest([{ path: 'keep.ts', hash: 'x' }, { path: 'edit.ts', hash: 'v1' }, { path: 'gone.ts', hash: 'z' }]);
    const newM = buildManifest([{ path: 'keep.ts', hash: 'x' }, { path: 'edit.ts', hash: 'v2' }, { path: 'new.ts', hash: 'n' }]);
    const d = diffManifest(oldM, newM);
    expect(d.added).toEqual(['new.ts']);
    expect(d.changed).toEqual(['edit.ts']);
    expect(d.removed).toEqual(['gone.ts']);
    expect(d.unchanged).toEqual(['keep.ts']);
  });

  it('treats a null previous manifest as all-added', () => {
    const m = buildManifest([{ path: 'a.ts', hash: '1' }]);
    expect(diffManifest(null, m).added).toEqual(['a.ts']);
  });

  it('hashContent is stable and content-sensitive', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });
});
