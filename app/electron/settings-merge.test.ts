import { describe, expect, it } from 'vitest';
import { applySettingsCredentials, credentialDispositionForEdit, priorAzureRow, type SettingsMergeDeps } from './settings-merge.js';
import { sameEndpoint, sameAzureEndpoint } from '../../src/index.js';

describe('credentialDispositionForEdit', () => {
  it('keeps the key when the endpoint has not moved', () => {
    expect(credentialDispositionForEdit(
      { baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.groq.com/openai/v1/',
      undefined,
      sameEndpoint,
    )).toBe('keep');
  });

  it('drops the key when the host changes and no replacement was typed', () => {
    // The reported shape: `{ baseUrl: Groq, apiKey: groqKey }` edited to another
    // host became `{ baseUrl: otherHost, apiKey: groqKey }`, because a blank key
    // field means "keep the existing key" and the two fields were handled
    // independently.
    expect(credentialDispositionForEdit(
      { baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.deepseek.com/v1',
      undefined,
      sameEndpoint,
    )).toBe('clear');
  });

  it('drops the key when the endpoint is cleared', () => {
    expect(credentialDispositionForEdit(
      { baseUrl: 'https://api.groq.com/openai/v1' }, '', undefined, sameEndpoint,
    )).toBe('clear');
  });

  it('reports a typed key as a REPLACEMENT, never as a clear', () => {
    // This returned `false` — the same value as "clear" — and the caller
    // deleted the credential on `false`. So a save carrying a new key and a new
    // endpoint installed the key and immediately removed it.
    expect(credentialDispositionForEdit(
      { baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.deepseek.com/v1',
      'new-key',
      sameEndpoint,
    )).toBe('replaced');
    // …and likewise when the endpoint did not move at all.
    expect(credentialDispositionForEdit(
      { baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.groq.com/openai/v1',
      'new-key',
      sameEndpoint,
    )).toBe('replaced');
  });

  it('keeps a key on a provider that never had an endpoint', () => {
    // A plain `openai`/`anthropic` row is not endpoint-scoped.
    expect(credentialDispositionForEdit({}, 'https://gw.example', undefined, sameEndpoint)).toBe('keep');
  });
});

describe('priorAzureRow', () => {
  const prior = [
    { deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', apiKey: 'key-a' },
    { deploymentName: 'dev', baseUrl: 'https://resource-b.openai.azure.com', apiKey: 'key-b' },
  ];

  it('inherits the key when the deployment stays on its resource', () => {
    expect(priorAzureRow(prior, {
      deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com/',
    }, sameAzureEndpoint)?.apiKey).toBe('key-a');
  });

  it('inherits nothing when the deployment moves to another resource', () => {
    // Azure keys are resource-scoped; matching on the deployment name alone
    // copied resource A's key onto resource B.
    expect(priorAzureRow(prior, {
      deploymentName: 'prod', baseUrl: 'https://resource-b.openai.azure.com',
    }, sameAzureEndpoint)).toBeUndefined();
  });

  it('inherits nothing for a deployment with no name to match on', () => {
    expect(priorAzureRow(prior, { baseUrl: 'https://resource-a.openai.azure.com' }, sameAzureEndpoint))
      .toBeUndefined();
  });
});

describe('applySettingsCredentials — the real save sequence', () => {
  // The unit above is not enough on its own: the defect was in how the two
  // halves compose, and the composition lived inside `ipcMain.handle` where no
  // test could reach it.
  const applyProviderApiKey: SettingsMergeDeps['applyProviderApiKey'] = (providers, type, apiKey, extra) => {
    const existing = providers.find((p) => p.type === type);
    if (existing) {
      existing.apiKey = apiKey;
      existing.authToken = undefined;
      if (extra?.baseUrl) existing.baseUrl = extra.baseUrl;
      return;
    }
    providers.push({ type, apiKey, ...(extra?.baseUrl ? { baseUrl: extra.baseUrl } : {}) });
  };
  const deps = { applyProviderApiKey, sameEndpoint };

  it('keeps a key and endpoint saved together', () => {
    // The reported P1: typing a new key alongside a new endpoint wrote the key
    // and then deleted it, so Settings appeared to discard what the user typed.
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': 'new-key' },
      endpoints: { 'openai-compatible': 'https://api.deepseek.com/v1' },
    }, deps);

    expect(providers[0]).toMatchObject({ apiKey: 'new-key', baseUrl: 'https://api.deepseek.com/v1' });
  });

  it('keeps a key saved with no endpoint change at all', () => {
    const providers = [{ type: 'openai-compatible', apiKey: 'old', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': 'new-key' },
      endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1' },
    }, deps);

    expect(providers[0]?.apiKey).toBe('new-key');
  });

  it('still retires a key when the host moves and nothing was typed', () => {
    // The behaviour the disposition exists to preserve.
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      endpoints: { 'openai-compatible': 'https://api.deepseek.com/v1' },
    }, deps);

    expect(providers[0]?.apiKey).toBeUndefined();
    expect(providers[0]?.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('leaves a blank key field meaning "keep it" when the host is unchanged', () => {
    const providers = [{ type: 'openai-compatible', apiKey: 'groq-key', baseUrl: 'https://api.groq.com/openai/v1' }];
    applySettingsCredentials(providers, {
      keys: { 'openai-compatible': '' },
      endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1/' },
    }, deps);

    expect(providers[0]?.apiKey).toBe('groq-key');
  });

  it('creates a row for an endpoint typed against a provider with none', () => {
    const providers: Array<{ type: string; apiKey?: string; baseUrl?: string }> = [];
    applySettingsCredentials(providers, { endpoints: { 'openai-compatible': 'https://api.groq.com/openai/v1' } }, deps);
    expect(providers).toEqual([{ type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' }]);
  });

  it('never touches azure, which has its own field', () => {
    const providers = [{ type: 'azure', apiKey: 'az', baseUrl: 'https://r1.openai.azure.com' }];
    applySettingsCredentials(providers, { endpoints: { azure: 'https://r2.openai.azure.com' } }, deps);
    expect(providers[0]).toMatchObject({ apiKey: 'az', baseUrl: 'https://r1.openai.azure.com' });
  });
});
