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

describe('parseModelJson', () => {
  it('reads the array after the thinking, not a bracket inside it', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    const reply = '<think>Option [A] or [B]? I will pick both.</think>\n[{"id":1},{"id":2}]';
    expect(parseModelJson(reply, 'array')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('skips prose brackets before the real array', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    expect(parseModelJson('Here it is [see below]:\n[1, 2, 3]', 'array')).toEqual([1, 2, 3]);
  });

  it('prefers a fenced block', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    expect(parseModelJson('Example {"x":0}\n```json\n{"x":1}\n```', 'object')).toEqual({ x: 1 });
  });

  it('repairs trailing commas, comments, curly quotes and Python literals', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    const reply = '{\n  // verdict\n  “sufficient”: False, /* why */ "notes": None,\n  "tags": ["a", "b",],\n}';
    expect(parseModelJson(reply, 'object')).toEqual({ sufficient: false, notes: null, tags: ['a', 'b'] });
  });

  it('leaves a comma or a Python word inside a string alone', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    expect(parseModelJson('{"s": "True, ]", "n": 1,}', 'object')).toEqual({ s: 'True, ]', n: 1 });
  });

  it('does not take an object for an array or the other way round', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    expect(parseModelJson('{"a":[1]}', 'array')).toEqual([1]);
    expect(parseModelJson('[1,2]', 'object')).toBeNull();
  });

  it('finds an array after an earlier bracket that never closes', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    expect(parseModelJson('Note [unfinished. Result: ["ok"]', 'array')).toEqual(['ok']);
  });

  it('returns null when nothing parses', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    expect(parseModelJson('no json at all', 'array')).toBeNull();
    expect(parseModelJson('', 'object')).toBeNull();
  });

  it('does not take a fence inside a JSON string value for the payload', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    const plan = JSON.stringify([{ subtaskId: 'a', description: 'Return ```json\n[]\n``` when empty' }]);
    expect(parseModelJson(plan, 'array')).toEqual([{ subtaskId: 'a', description: 'Return ```json\n[]\n``` when empty' }]);
    const spec = 'Spec:\n' + JSON.stringify({ name: 't', executeCode: 'return "```{}```"' });
    expect(parseModelJson(spec, 'object')).toEqual({ name: 't', executeCode: 'return "```{}```"' });
  });

  it('still prefers a real fenced block to an example in the prose', async () => {
    const { parseModelJson } = await import('./json-extract.js');
    expect(parseModelJson('Like {"x":0}, but:\n```json\n{"x":1}\n```', 'object')).toEqual({ x: 1 });
  });
});
