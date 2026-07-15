import { describe, it, expect } from 'vitest';
import { buildClassifierPrompt, parseComplexity } from './classifier.js';

describe('buildClassifierPrompt', () => {
  it('includes the request and the three buckets', () => {
    const p = buildClassifierPrompt('Write a report and save it');
    expect(p).toContain('Simple, Moderate, Complex');
    expect(p).toContain('Request: Write a report and save it');
    expect(p.trimEnd().endsWith('Answer:')).toBe(true);
  });

  it('adds recent context only when provided', () => {
    expect(buildClassifierPrompt('do it')).not.toContain('Recent context:');
    expect(buildClassifierPrompt('do it', 'earlier we built a parser')).toContain('Recent context:');
  });

  it('bounds oversized input', () => {
    const huge = 'x'.repeat(5000);
    const p = buildClassifierPrompt(huge, 'y'.repeat(5000));
    // The prompt stays far below the raw 10k of input.
    expect(p.length).toBeLessThan(3000);
  });
});

describe('parseComplexity', () => {
  it('reads a bare verdict word (any case)', () => {
    expect(parseComplexity('Simple')).toBe('Simple');
    expect(parseComplexity('moderate')).toBe('Moderate');
    expect(parseComplexity('COMPLEX')).toBe('Complex');
  });

  it('takes the first verdict even with a preamble', () => {
    expect(parseComplexity('This looks Moderate to me')).toBe('Moderate');
    expect(parseComplexity('**Complex** — several steps')).toBe('Complex');
  });

  it('returns null on nothing usable', () => {
    expect(parseComplexity('')).toBeNull();
    expect(parseComplexity(null)).toBeNull();
    expect(parseComplexity('I am not sure')).toBeNull();
  });
});
