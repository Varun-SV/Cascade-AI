import { describe, it, expect } from 'vitest';
import { sharedKeywords, isStrongKeywordOverlap } from './t1-administrator.js';

describe('T1 section overlap detection (parallelism preservation)', () => {
  it('finds shared keywords case-insensitively', () => {
    expect(sharedKeywords(['Code', 'Auth'], ['code', 'db'])).toEqual(['code']);
  });

  it('does NOT treat one or two shared keywords as strong overlap', () => {
    // Common words like "code" must not serialize otherwise-independent sections.
    expect(isStrongKeywordOverlap(['code', 'auth', 'jwt'], ['code', 'ui', 'theme'])).toBe(false);
    expect(isStrongKeywordOverlap(['code', 'test', 'jwt'], ['code', 'test', 'theme'])).toBe(false);
  });

  it('treats a substantial shared set as strong overlap (serialize that pair)', () => {
    expect(isStrongKeywordOverlap(
      ['auth', 'jwt', 'token', 'login'],
      ['auth', 'jwt', 'token', 'session'],
    )).toBe(true);
  });

  it('handles empty keyword lists safely', () => {
    expect(isStrongKeywordOverlap([], ['a', 'b', 'c'])).toBe(false);
    expect(sharedKeywords(undefined as unknown as string[], ['a'])).toEqual([]);
  });
});
