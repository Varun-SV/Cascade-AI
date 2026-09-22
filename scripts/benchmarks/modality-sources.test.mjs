// Tests for modality source validation (scripts/benchmarks/modality-sources.mjs).
// Run by vitest via the `scripts/**/*.test.mjs` include in vitest.config.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateModalitySource } from './modality-sources.mjs';

const source = (models) => ({ modality: 'demo', source: 'demo-source', models });

let warn;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('validateModalitySource', () => {
  it('keeps real numbers, integer and fractional', () => {
    const out = validateModalitySource(source({ a: 1186, b: 57.3, c: -2.5, d: 0 }));
    expect(out.models).toEqual({ a: 1186, b: 57.3, c: -2.5, d: 0 });
  });

  // `Number(null)`, `Number('')`, `Number(false)` and `Number([])` are all 0 and
  // all finite, so a check written as `Number.isFinite(Number(v))` accepted a
  // MISSING measurement and stored it as a score of zero.
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['false', false],
    ['true', true],
    ['an empty array', []],
    ['an object', {}],
    ['a numeric string', '0.85'],
    ['a non-numeric string', 'n/a'],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('refuses %s rather than coercing it to a score', (_label, value) => {
    const out = validateModalitySource(source({ good: 10, bad: value }));
    expect(out.models).toEqual({ good: 10 });
    expect(out.models).not.toHaveProperty('bad');
  });

  it('says which row it dropped, instead of quietly rating fewer models', () => {
    validateModalitySource(source({ good: 10, missing: null }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"missing"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('null'));
  });

  // Why it matters beyond tidiness: a zero is the BEST possible value on a
  // lower-is-better metric, so an unmeasured model would have ranked top of the
  // field — and since normalization is a percentile within the source, that one
  // invented row moves every other model's rank in the file.
  it('does not let an unmeasured model outrank the ones that were measured', () => {
    const out = validateModalitySource({
      modality: 'speech-to-text', source: 'wer-source', lowerIsBetter: true,
      models: { good: 0.05, alsoGood: 0.07, neverMeasured: null },
    });
    expect(Object.keys(out.models).sort()).toEqual(['alsoGood', 'good']);
  });

  // `!!"false"` is true, and so is `!!"0"`. A flag that flips turns the whole
  // source upside down — every model's rank, not one cell — and it does so
  // while passing every other check.
  describe('the ranking direction', () => {
    it('accepts a real boolean, either way', () => {
      expect(validateModalitySource({ ...source({ a: 1 }), lowerIsBetter: true }).lowerIsBetter).toBe(true);
      expect(validateModalitySource({ ...source({ a: 1 }), lowerIsBetter: false }).lowerIsBetter).toBe(false);
    });

    it('defaults to higher-is-better when the flag is absent', () => {
      expect(validateModalitySource(source({ a: 1 })).lowerIsBetter).toBe(false);
    });

    it.each([
      ['the string "false"', 'false'],
      ['the string "true"', 'true'],
      ['the string "0"', '0'],
      ['a number', 1],
      ['null', null],
      ['an object', {}],
    ])('refuses %s rather than guessing which direction it meant', (_label, value) => {
      expect(validateModalitySource({ ...source({ a: 1, b: 2 }), lowerIsBetter: value })).toBeNull();
    });

    it('says why it skipped the source, since losing one silently looks like a quiet week', () => {
      validateModalitySource({ ...source({ a: 1 }), lowerIsBetter: 'false' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lowerIsBetter'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invert'));
    });
  });

  it('skips a file with no usable rows at all rather than emitting an empty source', () => {
    expect(validateModalitySource(source({ a: null, b: '' }))).toBeNull();
  });

  it('is not our concern when the file declares no modality', () => {
    // The legacy text pipeline owns those, and they are quietly skipped.
    expect(validateModalitySource({ source: 'lmarena', models: { a: 1 } })).toBeNull();
  });
});
