import { describe, expect, it } from 'vitest';
import { priorAzureRow } from './settings-merge.js';
import { sameAzureEndpoint } from '../../src/index.js';

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
