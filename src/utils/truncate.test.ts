import { describe, it, expect } from 'vitest';
import { truncateForContext } from './truncate.js';

describe('truncateForContext', () => {
  it('returns short text unchanged', () => {
    expect(truncateForContext('hello', 100)).toBe('hello');
  });

  it('keeps the head and tail with an elision marker for long text', () => {
    const text = 'A'.repeat(10_000) + 'MIDDLE' + 'Z'.repeat(10_000);
    const out = truncateForContext(text, 1_000);
    expect(out.length).toBeLessThan(1_200); // cap + marker
    expect(out.startsWith('AAA')).toBe(true);
    expect(out.endsWith('ZZZ')).toBe(true);
    expect(out).toContain('characters elided');
    expect(out).not.toContain('MIDDLE');
  });

  it('keeps error-bearing tails visible (shell output pattern)', () => {
    const out = truncateForContext('x'.repeat(50_000) + '\nError: exit code 1', 2_000);
    expect(out).toContain('Error: exit code 1');
  });
});
