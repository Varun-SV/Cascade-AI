// ─────────────────────────────────────────────
//  Cascade AI — /api/config secret redaction
// ─────────────────────────────────────────────
//
//  The handler masked `apiKey` and nothing else, under a comment saying
//  "Strip sensitive fields before sending". A provider configured with a
//  bearer token — which both `cascade link` and ANTHROPIC_AUTH_TOKEN produce
//  — had that token served in plaintext.

import { describe, expect, it } from 'vitest';
import { redactProviderSecrets } from './server.js';
import type { CascadeConfig } from '../types.js';

function configWith(providers: CascadeConfig['providers']): CascadeConfig {
  return { providers, models: {}, tools: { allowedTools: [] } } as unknown as CascadeConfig;
}

describe('redactProviderSecrets', () => {
  it('masks an API key', () => {
    const safe = redactProviderSecrets(configWith([{ type: 'anthropic', apiKey: 'sk-ant-secret' }]));
    expect(JSON.stringify(safe)).not.toContain('sk-ant-secret');
    expect(safe.providers[0]!.apiKey).toBe('***');
  });

  it('masks a bearer token — the field that used to leak', () => {
    const safe = redactProviderSecrets(configWith([{ type: 'anthropic', authToken: 'gw-token-secret' }]));
    expect(JSON.stringify(safe)).not.toContain('gw-token-secret');
    expect(safe.providers[0]!.authToken).toBe('***');
  });

  it('masks both when a provider carries both', () => {
    const safe = redactProviderSecrets(configWith([
      { type: 'anthropic', apiKey: 'sk-ant-secret', authToken: 'gw-token-secret' },
    ]));
    const json = JSON.stringify(safe);
    expect(json).not.toContain('sk-ant-secret');
    expect(json).not.toContain('gw-token-secret');
  });

  it('leaves non-secret fields intact, so the route stays useful', () => {
    const safe = redactProviderSecrets(configWith([
      { type: 'openai-compatible', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1' },
    ]));
    expect(safe.providers[0]!.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(safe.providers[0]!.type).toBe('openai-compatible');
  });

  it('does not invent fields on a provider that has no secret', () => {
    const safe = redactProviderSecrets(configWith([{ type: 'ollama' }]));
    expect(safe.providers[0]!.apiKey).toBeUndefined();
    expect(safe.providers[0]!.authToken).toBeUndefined();
  });

  it('does not mutate the config it was given', () => {
    const config = configWith([{ type: 'anthropic', apiKey: 'sk-ant-secret', authToken: 'gw' }]);
    redactProviderSecrets(config);
    expect(config.providers[0]!.apiKey).toBe('sk-ant-secret');
    expect(config.providers[0]!.authToken).toBe('gw');
  });

  it('survives a config with no providers array at all', () => {
    const safe = redactProviderSecrets({ models: {} } as unknown as CascadeConfig);
    expect(safe.providers).toEqual([]);
  });
});
