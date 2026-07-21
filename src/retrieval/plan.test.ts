import { describe, it, expect } from 'vitest';
import { planRetrieval, cagCharBudget, CHARS_PER_TOKEN } from './plan.js';

describe('cagCharBudget', () => {
  it('scales with the context window (chars = window × docFraction × chars/token)', () => {
    // Default docFraction 0.5: a 200k-token window admits up to 400k chars in full.
    expect(cagCharBudget(200_000)).toBe(200_000 * 0.5 * CHARS_PER_TOKEN);
    // A bigger window admits proportionally more.
    expect(cagCharBudget(400_000)).toBeGreaterThan(cagCharBudget(200_000));
  });

  it('honours an explicit doc fraction and never goes negative', () => {
    expect(cagCharBudget(100_000, { docFraction: 0.25 })).toBe(100_000 * 0.25 * CHARS_PER_TOKEN);
    expect(cagCharBudget(0)).toBe(0);
    expect(cagCharBudget(-5)).toBe(0);
  });

  it('a 52 KB document injects in full (CAG) for any modern window — the reported bug', () => {
    const doc52kb = 52 * 1024; // chars
    // Even a conservative 128k-token window comfortably admits it in full.
    const budget = cagCharBudget(128_000);
    expect(doc52kb).toBeLessThan(budget);
    expect(planRetrieval({ sourceCount: 1, totalChars: doc52kb, cagCharBudget: budget }).mode).toBe('cag');
  });

  it('a genuinely oversized corpus still routes to retrieval', () => {
    const budget = cagCharBudget(128_000);
    expect(planRetrieval({ sourceCount: 1, totalChars: budget + 1, cagCharBudget: budget }).mode).toBe('rag');
  });
});
