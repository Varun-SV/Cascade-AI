import { describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderConfig } from '../../types.js';
import { isPrivateEndpoint, providerConfigFor } from './endpoint.js';

const model = (provider: ModelInfo['provider'], isLocal: boolean, id = 'm'): ModelInfo => ({
  id, name: id, provider, contextWindow: 8_000, isVisionCapable: false,
  inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 1_000, supportsStreaming: true, isLocal,
});

describe('isPrivateEndpoint — where the call goes, not what it costs', () => {
  it('counts an endpoint on this machine or a private network', () => {
    expect(isPrivateEndpoint(model('ollama', true), [{ type: 'ollama' }])).toBe(true);
    expect(isPrivateEndpoint(model('openai-compatible', true), [{ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1' }])).toBe(true);
    expect(isPrivateEndpoint(model('openai-compatible', false), [{ type: 'openai-compatible', baseUrl: 'http://192.168.1.20:8000/v1' }])).toBe(true);
  });

  // `isLocal` is true for both of these — it means "costs $0" — and a
  // local-only file read would have been sent to either.
  it('does not count a hosted endpoint configured as free, or an Ollama on someone else\'s box', () => {
    const hostedFree: ProviderConfig = { type: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', local: true };
    expect(isPrivateEndpoint(model('openai-compatible', true), [hostedFree])).toBe(false);
    expect(isPrivateEndpoint(model('ollama', true), [{ type: 'ollama', baseUrl: 'https://gpu.example.com' }])).toBe(false);
  });

  it('never counts a cloud provider', () => {
    for (const provider of ['anthropic', 'openai', 'gemini', 'azure'] as const) {
      expect(isPrivateEndpoint(model(provider, true), [{ type: provider, baseUrl: 'http://localhost:1' }]), provider).toBe(false);
    }
  });

  it('judges the config the call is bound to — the same one the router binds', () => {
    const configs: ProviderConfig[] = [
      { type: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
      { type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1' },
    ];
    expect(providerConfigFor(model('openai-compatible', true), configs)).toBe(configs[0]);
    expect(isPrivateEndpoint(model('openai-compatible', true), configs)).toBe(false);
  });
});
