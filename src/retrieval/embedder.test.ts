import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../types.js';
import { describeEmbedFailure, embedderFromProviders, openAIRoute, pickOpenAIRoute } from './embedder.js';
import { chatCompleterFromProviders } from './rerank.js';

const p = (c: Partial<ProviderConfig> & { type: ProviderConfig['type'] }) => c as ProviderConfig;

describe('which provider embeds, and where it is reached', () => {
  // The report: Gemini configured (and working), plus the Ollama entry the
  // config adds by default. Indexing went to api.openai.com with "sk-none".
  it('a Gemini key embeds through Gemini, not through a bare Ollama entry sent to OpenAI', () => {
    const providers = [p({ type: 'gemini', apiKey: 'g-key' }), p({ type: 'ollama' })];
    const route = pickOpenAIRoute(providers)!;
    expect(route.provider.type).toBe('gemini');
    expect(route.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
    expect(route.apiKey).toBe('g-key');
    const embedder = embedderFromProviders(providers)!;
    expect(embedder.provider).toBe('gemini');
    expect(embedder.model).toBe('gemini-embedding-001');
  });

  it('a bare Ollama entry is reached on this machine, never at the OpenAI default', () => {
    expect(openAIRoute(p({ type: 'ollama' }))!.baseURL).toBe('http://localhost:11434/v1');
    expect(openAIRoute(p({ type: 'ollama', baseUrl: 'http://gpu-box:11434/' }))!.baseURL).toBe('http://gpu-box:11434/v1');
    expect(openAIRoute(p({ type: 'ollama', baseUrl: 'http://gpu-box:11434/v1' }))!.baseURL).toBe('http://gpu-box:11434/v1');
    expect(embedderFromProviders([p({ type: 'ollama' })])!.model).toBe('nomic-embed-text');
  });

  it('in order: OpenAI, a compatible endpoint, an Ollama you pointed at, Gemini, the default Ollama', () => {
    const gemini = p({ type: 'gemini', apiKey: 'g' });
    const bare = p({ type: 'ollama' });
    const pointed = p({ type: 'ollama', baseUrl: 'http://localhost:11434' });
    expect(pickOpenAIRoute([bare, gemini, p({ type: 'openai', apiKey: 'o' })])!.provider.type).toBe('openai');
    expect(pickOpenAIRoute([gemini, p({ type: 'openai-compatible', baseUrl: 'https://gw.test/v1' })])!.provider.type).toBe('openai-compatible');
    expect(pickOpenAIRoute([gemini, pointed])!.provider).toBe(pointed);
    expect(pickOpenAIRoute([bare, gemini])!.provider).toBe(gemini);
  });

  it('not a provider that cannot be reached this way', () => {
    // A compatible endpoint needs its address; Gemini needs its key.
    expect(openAIRoute(p({ type: 'openai-compatible', apiKey: 'k' }))).toBeNull();
    expect(openAIRoute(p({ type: 'gemini' }))).toBeNull();
    expect(embedderFromProviders([p({ type: 'anthropic', apiKey: 'a' })])).toBeNull();
    // Gemini without a key falls through to what else there is.
    expect(pickOpenAIRoute([p({ type: 'gemini' }), p({ type: 'ollama' })])!.provider.type).toBe('ollama');
  });

  it('a Gemini gateway keeps its root, however its version is spelt (Codex on d230b69)', () => {
    const at = (baseUrl: string) => openAIRoute(p({ type: 'gemini', apiKey: 'g', baseUrl }))!.baseURL;
    expect(at('https://proxy.test/google/')).toBe('https://proxy.test/google/v1beta/openai/');
    // As the Gemini client reads it (geminiApiRoot): the version is not a second root.
    expect(at('https://gemini-proxy.internal/v1beta')).toBe('https://gemini-proxy.internal/v1beta/openai/');
    expect(at('https://gemini-proxy.internal/v1beta/')).toBe('https://gemini-proxy.internal/v1beta/openai/');
  });

  it('slashes are trimmed in linear time (CodeQL on d230b69)', () => {
    const t0 = performance.now();
    expect(openAIRoute(p({ type: 'ollama', baseUrl: `http://h${'/'.repeat(100_000)}x` }))!.baseURL).toMatch(/x\/v1$/);
    expect(openAIRoute(p({ type: 'ollama', baseUrl: `http://h:11434${'/'.repeat(100_000)}` }))!.baseURL).toBe('http://h:11434/v1');
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('the reranker picks the same provider', () => {
    expect(chatCompleterFromProviders([p({ type: 'gemini', apiKey: 'g' }), p({ type: 'ollama' })])).not.toBeNull();
    expect(chatCompleterFromProviders([p({ type: 'anthropic', apiKey: 'a' })])).toBeNull();
  });
});

describe('why embedding failed, in a line', () => {
  it('says a refused key plainly, without repeating it', () => {
    const err = Object.assign(new Error('401 Incorrect API key provided: sk-secret-123. You can find your API key at …'), { status: 401 });
    const line = describeEmbedFailure(err, { provider: 'openai', model: 'text-embedding-3-small' });
    expect(line).toContain('openai (text-embedding-3-small) refused the key (HTTP 401)');
    expect(line).not.toContain('sk-secret-123');
  });

  it('names a missing model, and anything else as it was said', () => {
    expect(describeEmbedFailure(Object.assign(new Error('404 model not found'), { status: 404 }), { provider: 'gemini', model: 'm' }))
      .toContain('no such embeddings model or endpoint');
    expect(describeEmbedFailure(new Error('connect ECONNREFUSED 127.0.0.1:11434\nstack…'), { provider: 'ollama', model: 'nomic-embed-text' }))
      .toBe('Embedding with ollama (nomic-embed-text) failed: connect ECONNREFUSED 127.0.0.1:11434');
  });
});
