import { describe, it, expect } from 'vitest';
import { azureModelForDeployment } from './azure.js';

describe('azureModelForDeployment', () => {
  it('maps a configured deployment to a model keyed by deployment name', () => {
    const model = azureModelForDeployment({
      type: 'azure', apiKey: 'k', baseUrl: 'https://r.openai.azure.com',
      deploymentName: 'gpt-4o-prod', label: 'Prod GPT-4o', apiVersion: '2024-08-01-preview',
    });
    expect(model).toMatchObject({ id: 'gpt-4o-prod', name: 'Prod GPT-4o', provider: 'azure', supportsToolUse: true });
    // Cost tracking must be an estimate, never $0 (which reads as free).
    expect(model!.inputCostPer1kTokens).toBeGreaterThan(0);
    expect(model!.outputCostPer1kTokens).toBeGreaterThan(0);
  });

  it('falls back to the deployment name when no label is set', () => {
    const model = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-35' });
    expect(model!.name).toBe('gpt-35');
  });

  it('returns null for entries without a deployment name or with the wrong type', () => {
    expect(azureModelForDeployment({ type: 'azure', baseUrl: 'https://r.openai.azure.com' })).toBeNull();
    expect(azureModelForDeployment({ type: 'azure', deploymentName: '   ' })).toBeNull();
    expect(azureModelForDeployment({ type: 'openai', deploymentName: 'x' })).toBeNull();
  });
});
