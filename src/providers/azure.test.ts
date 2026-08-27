import { describe, it, expect, vi } from 'vitest';
import {
  AZURE_BASE_MODELS,
  azureModelForDeployment,
  inferAzureBaseModel,
  AzureOpenAIProvider,
} from './azure.js';
import { MODELS } from '../constants.js';
import type { ModelInfo } from '../types.js';

describe('inferAzureBaseModel', () => {
  it('maps current deployment names to canonical base models, most-specific first', () => {
    expect(inferAzureBaseModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(inferAzureBaseModel('prod-gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(inferAzureBaseModel('gpt-5.6-luna-eastus')).toBe('gpt-5.6-luna');
    expect(inferAzureBaseModel('gpt-5.5')).toBe('gpt-5.5');
    expect(inferAzureBaseModel('gpt-5.4')).toBe('gpt-5.4');
    expect(inferAzureBaseModel('gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(inferAzureBaseModel('gpt-5.4-nano')).toBe('gpt-5.4-nano');
    expect(inferAzureBaseModel('gpt-5.2')).toBe('gpt-5.2');
    expect(inferAzureBaseModel('gpt-5.1')).toBe('gpt-5.1');
    expect(inferAzureBaseModel('gpt-5-mini')).toBe('gpt-5-mini');
    expect(inferAzureBaseModel('gpt5nano-prod')).toBe('gpt-5-nano');
    expect(inferAzureBaseModel('my-gpt-4o-deploy')).toBe('gpt-4o');
    expect(inferAzureBaseModel('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(inferAzureBaseModel('o3')).toBe('o3');
  });

  it('serves the same current identities to the Azure base-model picker', () => {
    expect(AZURE_BASE_MODELS).toEqual(expect.arrayContaining([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.2',
      'gpt-5.1',
      'o3',
    ]));
  });

  it('returns null when the name gives no signal', () => {
    expect(inferAzureBaseModel('prod-fast')).toBeNull();
    expect(inferAzureBaseModel('assistant')).toBeNull();
  });
});

describe('azureModelForDeployment — base-model economics', () => {
  it('gives GPT-5.6 deployments their published long-context shape', () => {
    const m = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.6-sol', label: 'Sol' })!;
    expect(m.id).toBe('gpt-5.6-sol');
    expect(m.baseModelId).toBe('gpt-5.6-sol');
    expect(m.provider).toBe('azure');
    expect(m.contextWindow).toBe(1_050_000);
    expect(m.maxOutputTokens).toBe(128_000);
    expect(m.isVisionCapable).toBe(true);
    expect(m.inputCostPer1kTokens).toBeGreaterThan(0);
    expect(m.outputCostPer1kTokens).toBeGreaterThan(0);
  });

  it('keeps Sol, Terra, and Luna as distinct base identities', () => {
    const sol = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.6-sol' })!;
    const terra = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.6-terra' })!;
    const luna = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.6-luna' })!;
    expect(sol.baseModelId).toBe('gpt-5.6-sol');
    expect(terra.baseModelId).toBe('gpt-5.6-terra');
    expect(luna.baseModelId).toBe('gpt-5.6-luna');
    expect(sol.outputCostPer1kTokens).toBeGreaterThan(terra.outputCostPer1kTokens);
    expect(terra.outputCostPer1kTokens).toBeGreaterThan(luna.outputCostPer1kTokens);
  });

  it('distinguishes gpt-5.4 full, mini, and nano', () => {
    const full = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.4' })!;
    const mini = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.4-mini' })!;
    const nano = azureModelForDeployment({ type: 'azure', deploymentName: 'gpt-5.4-nano' })!;
    expect(full.baseModelId).toBe('gpt-5.4');
    expect(mini.baseModelId).toBe('gpt-5.4-mini');
    expect(nano.baseModelId).toBe('gpt-5.4-nano');
    expect(full.outputCostPer1kTokens).toBeGreaterThan(mini.outputCostPer1kTokens);
    expect(mini.outputCostPer1kTokens).toBeGreaterThan(nano.outputCostPer1kTokens);
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

  it('pings a GPT-5.6 reasoning deployment with max_completion_tokens up front', async () => {
    const { provider, create } = providerWithMockClient('gpt-5.6-terra');
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
