import { describe, it, expect } from 'vitest';
import { buildTitlePrompt, cleanTitle } from './titler.js';
import { detectLocalModelCapability } from './capability.js';

describe('cleanTitle', () => {
  it('strips quotes, a Title: label, and trailing punctuation', () => {
    expect(cleanTitle('"Weekend Trip Plan."')).toBe('Weekend Trip Plan');
    expect(cleanTitle('Title: Debugging the router')).toBe('Debugging the router');
    expect(cleanTitle('`SQL join help`')).toBe('SQL join help');
  });

  it('takes only the first line and caps to 8 words', () => {
    expect(cleanTitle('One two three four five six seven eight nine ten')).toBe('One two three four five six seven eight');
    expect(cleanTitle('Real title\nsome rambling after')).toBe('Real title');
  });

  it('returns empty for blank/garbage', () => {
    expect(cleanTitle('')).toBe('');
    expect(cleanTitle('   ')).toBe('');
    expect(cleanTitle('""')).toBe('');
  });
});

describe('buildTitlePrompt', () => {
  it('includes both turns and bounds the length', () => {
    const p = buildTitlePrompt('hello there', 'general kenobi');
    expect(p).toContain('hello there');
    expect(p).toContain('general kenobi');
    const long = buildTitlePrompt('x'.repeat(5000), 'y'.repeat(5000));
    expect(long.length).toBeLessThan(1700);
  });
});

describe('detectLocalModelCapability', () => {
  it('requires WebGPU', () => {
    expect(detectLocalModelCapability({}).supported).toBe(false);
    expect(detectLocalModelCapability({ gpu: {} }).supported).toBe(true);
  });

  it('rejects clearly low-memory devices when memory is reported', () => {
    expect(detectLocalModelCapability({ gpu: {}, deviceMemory: 2 }).supported).toBe(false);
    expect(detectLocalModelCapability({ gpu: {}, deviceMemory: 8 }).supported).toBe(true);
    // Unknown memory (non-Chrome) doesn't block.
    expect(detectLocalModelCapability({ gpu: {} }).supported).toBe(true);
  });
});
