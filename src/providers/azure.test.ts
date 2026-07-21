import { describe, it, expect, vi } from 'vitest';
import { azureModelForDeployment, inferAzureBaseModel, AzureOpenAIProvider } from './azure.js';
import { MODELS } from '../constants.js';
import type { ModelInfo } from '../types.js';

describe('inferAzureBaseModel', () => {
  it('maps deployment names to canonical base models, most-specific first', () => {
    // Distinct point releases resolve to their OWN base (no longer folded).
    expect(inferAzureBaseModel('gpt-5.5')).toBe('gpt-5.5');
    expect(inferAzureBaseModel('gpt-5.4')).toBe('gpt-5.4');
    expect(inferAzureBaseModel('gpt-5.4-mini')).toBe('gpt-5.4-mini');
    // An unrecognised point release still folds into the gpt-5 base.
    expect(inferAzureBaseModel('gpt-5.3')).toBe('gpt-5');
    expect(inferAzureBaseModel('gpt-5-mini')).toBe('gpt-5-mini');
    expect(inferAzureBaseModel('gpt5nano-prod')).toBe('gpt-5-nano');
    expect(inferAzureBaseModel('my-gpt-4o-deploy')).toBe('gpt-4o');
    expect(inferAzureBaseModel('gpt-4.1-mini')).toBe('gpt-4.1-mini');
  });
  it('returns null when the name gives no signal', () => {
    expect(inferAzureBaseModel('prod-fast')).toBeNull();
    expect(inferAzureBaseModel('assistant')).toBeNull();
  });
});

describe('azureModelForDeployment — base-model economics', () => {
  it('inherits the inferred base model economics but keeps the deployment id', () => {
    const m = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.4', label: 'Prod' })!;
    const base = MODELS['gpt-5.4']!;
    expect(m.id).toBe('gpt-5.4');          // still callable by deployment name
    expect(m.baseModelId).toBe('gpt-5.4'); // resolves to its OWN base now
    expect(m.provider).toBe('azure');
    expect(m.contextWindow).toBe(base.contextWindow);
    expect(m.inputCostPer1kTokens).toBe(base.inputCostPer1kTokens);
    expect(m.outputCostPer1kTokens).toBe(base.outputCostPer1kTokens);
    expect(m.isVisionCapable).toBe(base.isVisionCapable);
  });

  it('distinguishes gpt-5.4 from gpt-5.4-mini (the reported mis-route)', () => {
    const full = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.4', label: 'Full' })!;
    const mini = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.4-mini', label: 'Mini' })!;
    expect(full.baseModelId).toBe('gpt-5.4');
    expect(mini.baseModelId).toBe('gpt-5.4-mini');
    // The full model must be the pricier (more capable) of the two.
    expect(full.outputCostPer1kTokens).toBeGreaterThan(mini.outputCostPer1kTokens);
  });

  it('lets an explicit cfg.model override the inference', () => {
    const m = azureModelForDeployment({ type: 'azure', deploymentName: 'prod-fast', model: 'gpt-5-mini' })!;
    expect(m.baseModelId).toBe('gpt-5-mini');
    expect(m.inputCostPer1kTokens).toBe(MODELS['gpt-5-mini']!.inputCostPer1kTokens);
  });

  it('keeps neutral estimate defaults when the base model is unknown', () => {
    const m = azureModelForDeployment({ type: 'azure', deploymentName: 'prod-fast' })!;
    expect(m.baseModelId).toBeUndefined();
    expect(m.inputCostPer1kTokens).toBeGreaterThan(0);
    expect(m.contextWindow).toBe(128_000);
  });
});

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
  function providerWithMockClient(deployment: string) {
    const model: ModelInfo = {
      id: deployment, name: deployment, provider: 'azure',
      contextWindow: 128_000, isVisionCapable: false,
      inputCostPer1kTokens: 0.0025, outputCostPer1kTokens: 0.01,
      maxOutputTokens: 16_000, supportsStreaming: true, isLocal: false,
    };
    const provider = new AzureOpenAIProvider(
      { type: 'azure', apiKey: 'k', baseUrl: 'https://r.openai.azure.com', deploymentName: deployment },
      model,
    );
    const create = vi.fn();
    (provider as unknown as { client: { chat: { completions: { create: typeof create } } } }).client = {
      chat: { completions: { create } },
    };
    return { provider, create };
  }

  it('pings a non-reasoning deployment with max_tokens and returns true', async () => {
    const { provider, create } = providerWithMockClient('gpt-4o-prod');
    create.mockResolvedValueOnce({});
    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ max_tokens: 1 });
  });

  it('pings a reasoning deployment (gpt-5*) with max_completion_tokens up front', async () => {
    // gpt-5 / o-series reject max_tokens, so don't waste a round trip on it.
    const { provider, create } = providerWithMockClient('gpt-5-mini');
    create.mockResolvedValueOnce({});
    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ max_completion_tokens: 16 });
    expect(create.mock.calls[0]![0]).not.toHaveProperty('max_tokens');
  });

  it('retries with max_completion_tokens when a deployment rejects max_tokens', async () => {
    const { provider, create } = providerWithMockClient('gpt-4o-prod');
    create
      .mockRejectedValueOnce(new Error("Unsupported parameter: 'max_tokens' is not supported. Use 'max_completion_tokens' instead."))
      .mockResolvedValueOnce({});
    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0]).toMatchObject({ max_completion_tokens: 16 });
    expect(create.mock.calls[1]![0]).not.toHaveProperty('max_tokens');
  });

  it('treats a param complaint on both attempts as AVAILABLE — the deployment exists', async () => {
    // A parameter error proves the endpoint is reachable and the deployment is
    // real; marking it unavailable is exactly what caused "No model for tier T1".
    const { provider, create } = providerWithMockClient('gpt-4o-prod');
    create
      .mockRejectedValueOnce(new Error("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'."))
      .mockRejectedValueOnce(new Error("Unsupported value: 'temperature' does not support 0.7 — only the default (1) is supported."));
    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  it('returns false immediately (no retry) for a real error, e.g. a bad key', async () => {
    const { provider, create } = providerWithMockClient('gpt-4o-prod');
    create.mockRejectedValueOnce(new Error('401 Unauthorized'));
    await expect(provider.isAvailable()).resolves.toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
