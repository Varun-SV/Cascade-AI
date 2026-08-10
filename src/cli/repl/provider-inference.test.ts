import { describe, expect, it } from 'vitest';
import { inferProviderFromModelId } from './index.js';
import type { CascadeConfig } from '../../types.js';

const providers = [{ type: 'anthropic' as const, apiKey: 'k' }] as CascadeConfig['providers'];

describe('REPL inferProviderFromModelId — provider prefixes', () => {
  it('keeps a slash-containing model id attached to its provider prefix', () => {
    // The REPL keeps its own list, separate from the router's selector. When a
    // provider is missing from it the prefix isn't recognised, the id falls
    // through to the name heuristics, and startup reports a bogus "Model
    // warnings" banner for a pin that is in fact perfectly valid. A `/` in the
    // id must not confuse the `:` split either.
    expect(inferProviderFromModelId('openai-compatible:openai/gpt-4o', providers)).toBe('openai-compatible');
    expect(inferProviderFromModelId('openai-compatible:meta/Llama-3.3-70B-Instruct', providers)).toBe('openai-compatible');
  });

  it('still recognises the pre-existing providers', () => {
    expect(inferProviderFromModelId('azure:my-deployment', providers)).toBe('azure');
    expect(inferProviderFromModelId('openai-compatible:some-model', providers)).toBe('openai-compatible');
    expect(inferProviderFromModelId('ollama:llama3.2:3b', providers)).toBe('ollama');
  });

  it('falls back to the name heuristics for a bare model id', () => {
    expect(inferProviderFromModelId('gpt-4o', providers)).toBe('openai');
    expect(inferProviderFromModelId('claude-sonnet-4', providers)).toBe('anthropic');
  });
});
