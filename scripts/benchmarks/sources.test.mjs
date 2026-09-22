// Tests for text-benchmark source validation (scripts/benchmarks/sources.mjs).
// Run by vitest via the `scripts/**/*.test.mjs` include in vitest.config.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateSource } from './sources.mjs';

const source = (models) => ({ source: 'demo-source', models });

let warn;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('validateSource', () => {
  it('keeps a well-formed models map', () => {
    const out = validateSource(source({ 'gpt-5': { code: 80, analysis: 70 } }));
    expect(out.models).toEqual({ 'gpt-5': { code: 80, analysis: 70 } });
  });

  // The modality loader had the same guard and the same hole: `typeof [] ===
  // 'object'`, so an array walked through it and `Object.entries` read its
  // INDICES as model-family names. A file shaped this way did not get skipped
  // as promised — it published a family called "0" into the committed
  // snapshot, where nothing downstream can tell it from a real one.
  it('refuses an array-shaped models map instead of naming families after its indices', () => {
    expect(validateSource(source([{ code: 80 }])), 'the file is skipped').toBeNull();
    expect(warn, 'and said so').toHaveBeenCalled();
  });

  // The same hole on the text side: JSON.parse makes `__proto__` an own
  // property, and assigning it into a plain `{}` silently stores nothing.
  it('keeps a family called __proto__ instead of losing it to the prototype setter', () => {
    const models = JSON.parse('{"__proto__": {"code": 80}, "gpt-5": {"code": 70}}');
    const out = validateSource(source(models));
    expect(Object.keys(out.models).sort(), 'both rows survive').toEqual(['__proto__', 'gpt-5']);
    expect(out.models['__proto__'], 'with its profile intact').toEqual({ code: 80 });
  });

  it('still refuses a missing models map', () => {
    expect(validateSource({ source: 'demo-source' })).toBeNull();
  });
});
