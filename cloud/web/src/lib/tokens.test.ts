import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateConversationTokens, contextWindowFor, DEFAULT_CONTEXT_WINDOW } from './tokens.js';

describe('estimateTokens', () => {
  it('is ~chars/4, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('estimateConversationTokens', () => {
  it('sums across messages', () => {
    expect(estimateConversationTokens([{ content: 'abcd' }, { content: 'abcdefgh' }])).toBe(3);
    expect(estimateConversationTokens([])).toBe(0);
  });
});

describe('contextWindowFor', () => {
  it('maps a provider:model string to a real window', () => {
    expect(contextWindowFor('openai:gpt-5')).toBe(400_000);
    expect(contextWindowFor('azure:gpt-5.4-mini')).toBe(400_000);
    expect(contextWindowFor('anthropic:claude-sonnet-4')).toBe(200_000);
    expect(contextWindowFor('gemini:gemini-2.5-pro')).toBe(1_000_000);
    expect(contextWindowFor('openai:gpt-4o')).toBe(128_000);
  });
  it('falls back to a conservative default when unknown or absent', () => {
    expect(contextWindowFor('someprovider:mystery-model')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});
