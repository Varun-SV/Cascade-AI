import { describe, it, expect } from 'vitest';
import { extractFirstJsonObject, parseFirstJsonObject } from './json-extract.js';

describe('extractFirstJsonObject', () => {
  it('extracts a plain object', () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts the first balanced object from prose', () => {
    const text = 'Here is the plan:\n{"sections":[{"id":"a"}]}\nDone.';
    expect(extractFirstJsonObject(text)).toBe('{"sections":[{"id":"a"}]}');
  });

  it('handles braces inside string literals', () => {
    const text = 'noise {"note":"has } brace inside","ok":true} trailing';
    expect(extractFirstJsonObject(text)).toBe('{"note":"has } brace inside","ok":true}');
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"quote":"he said \\"hi\\"","n":1}';
    expect(extractFirstJsonObject(text)).toBe(text);
  });

  it('returns null on unbalanced input', () => {
    expect(extractFirstJsonObject('prefix { "a": 1 no close')).toBeNull();
  });

  it('returns null when there is no object at all', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });

  it('parseFirstJsonObject parses and returns typed result', () => {
    const parsed = parseFirstJsonObject<{ a: number }>('leading {"a":42} trailing');
    expect(parsed).toEqual({ a: 42 });
  });

  it('parseFirstJsonObject returns null on invalid JSON', () => {
    expect(parseFirstJsonObject('{not valid json}')).toBeNull();
  });
});
