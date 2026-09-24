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

describe('isPrivateEndpoint — the private networks there are', () => {
  const at = (baseUrl: string) => isPrivateEndpoint(model('ollama', true), [{ type: 'ollama', baseUrl }]);

  // An Ollama on one of these counted as private before, through isLocal;
  // judged by host, IPv6 and LAN names were left out.
  it('counts IPv6 unique-local and link-local addresses, IPv4 carried in IPv6, and single-label LAN names', () => {
    expect(at('http://[fd00::1]:11434')).toBe(true);
    expect(at('http://[fc12:3456::9]:11434')).toBe(true);
    expect(at('http://[fe80::1]:11434')).toBe(true);
    expect(at('http://[::ffff:10.0.0.7]:11434')).toBe(true);
    expect(at('http://[::1]:11434')).toBe(true);
    expect(at('http://gpu-box:11434')).toBe(true);
  });

  it('still does not count a public address or name', () => {
    expect(at('http://[2001:db8::1]:11434')).toBe(false);
    expect(at('http://[::ffff:8.8.8.8]:11434')).toBe(false);
    expect(at('https://ollama.example.com')).toBe(false);
    expect(at('http://8.8.8.8:11434')).toBe(false);
  });
});
