import { describe, expect, it } from 'vitest';
import { keepsCredentialAcrossEdit, priorAzureRow } from './settings-merge.js';
import { sameEndpoint, sameAzureEndpoint } from '../../src/index.js';

describe('keepsCredentialAcrossEdit', () => {
  it('keeps the key when the endpoint has not moved', () => {
    expect(keepsCredentialAcrossEdit(
      { baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.groq.com/openai/v1/',
      undefined,
      sameEndpoint,
    )).toBe(true);
  });

  it('drops the key when the host changes and no replacement was typed', () => {
    // The reported shape: `{ baseUrl: Groq, apiKey: groqKey }` edited to another
    // host became `{ baseUrl: otherHost, apiKey: groqKey }`, because a blank key
    // field means "keep the existing key" and the two fields were handled
    // independently.
    expect(keepsCredentialAcrossEdit(
      { baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.deepseek.com/v1',
      undefined,
      sameEndpoint,
    )).toBe(false);
  });

  it('drops the key when the endpoint is cleared', () => {
    expect(keepsCredentialAcrossEdit(
      { baseUrl: 'https://api.groq.com/openai/v1' }, '', undefined, sameEndpoint,
    )).toBe(false);
  });

  it('is moot when a replacement key was typed in the same save', () => {
    expect(keepsCredentialAcrossEdit(
      { baseUrl: 'https://api.groq.com/openai/v1' },
      'https://api.deepseek.com/v1',
      'new-key',
      sameEndpoint,
    )).toBe(false);
  });

  it('keeps a key on a provider that never had an endpoint', () => {
    // A plain `openai`/`anthropic` row is not endpoint-scoped.
    expect(keepsCredentialAcrossEdit({}, 'https://gw.example', undefined, sameEndpoint)).toBe(true);
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
