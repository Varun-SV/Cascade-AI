import { describe, it, expect, vi } from 'vitest';
import { azureModelForDeployment, AzureOpenAIProvider } from './azure.js';
import type { ModelInfo } from '../types.js';

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

describe('AzureOpenAIProvider.isAvailable', () => {
  const seedModel: ModelInfo = {
    id: 'gpt-5.4-mini', name: 'gpt-5.4-mini', provider: 'azure',
    contextWindow: 128_000, isVisionCapable: false,
    inputCostPer1kTokens: 0.0025, outputCostPer1kTokens: 0.01,
    maxOutputTokens: 16_000, supportsStreaming: true, isLocal: false,
  };

  function providerWithMockClient() {
    const provider = new AzureOpenAIProvider(
      { type: 'azure', apiKey: 'k', baseUrl: 'https://r.openai.azure.com', deploymentName: 'gpt-5.4-mini' },
      seedModel,
    );
    const create = vi.fn();
    (provider as unknown as { client: { chat: { completions: { create: typeof create } } } }).client = {
      chat: { completions: { create } },
    };
    return { provider, create };
  }

  it('returns true on the first ping when the deployment accepts max_tokens', async () => {
    const { provider, create } = providerWithMockClient();
    create.mockResolvedValueOnce({});
    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ max_tokens: 1 });
  });

  it('retries with max_completion_tokens when the deployment rejects max_tokens (reasoning-family models), instead of marking the whole provider unreachable', async () => {
    // This is the exact regression: a reasoning-style Azure deployment
    // (o1/o3/gpt-5.x-class) 400s on `max_tokens` with an error mentioning
    // `max_completion_tokens`. Before this fix that single ping failure
    // marked 'azure' unavailable provider-wide, and every explicit
    // "azure:<deployment>" override then failed with "provider not
    // available or unreachable" — even though real generation (which already
    // retries this way) would have worked.
    const { provider, create } = providerWithMockClient();
    create
      .mockRejectedValueOnce(new Error("Unsupported parameter: 'max_tokens' is not supported. Use 'max_completion_tokens' instead."))
      .mockResolvedValueOnce({});
    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0]).toMatchObject({ max_completion_tokens: 1 });
    expect(create.mock.calls[1]![0]).not.toHaveProperty('max_tokens');
  });

  it('returns false when the retry also fails', async () => {
    const { provider, create } = providerWithMockClient();
    create
      .mockRejectedValueOnce(new Error('max_completion_tokens required'))
      .mockRejectedValueOnce(new Error('still broken'));
    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  it('returns false immediately (no retry) for an unrelated error, e.g. real unreachability or a bad key', async () => {
    const { provider, create } = providerWithMockClient();
    create.mockRejectedValueOnce(new Error('401 Unauthorized'));
    await expect(provider.isAvailable()).resolves.toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
