// ─────────────────────────────────────────────
//  Cascade AI — Azure OpenAI Provider
// ─────────────────────────────────────────────

import { AzureOpenAI } from 'openai';
import { AZURE_BASE_URL_TEMPLATE, MODELS } from '../constants.js';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider, isReasoningModel, isParamShapeError } from './openai.js';
import { resolvePricing } from '../core/router/pricing.js';
import cloudModelCatalog from './cloud-model-catalog.json' with { type: 'json' };

const DEFAULT_AZURE_API_VERSION = '2024-12-01-preview';

type CloudCatalogEntry = {
  id: string;
  name: string;
  providers: string[];
  lifecycle: 'ga' | 'preview';
  contextWindow?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  toolUse?: boolean;
};

const CLOUD_MODELS = cloudModelCatalog.models as CloudCatalogEntry[];
const AZURE_CATALOG = CLOUD_MODELS
  .filter((m) => m.providers.includes('azure'))
  .slice()
  .sort((a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id));

export const AZURE_BASE_MODELS: readonly string[] = AZURE_CATALOG.map((m) => m.id);

function compactModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

function catalogEntry(id: string): CloudCatalogEntry | undefined {
  const n = id.toLowerCase();
  return CLOUD_MODELS.find((m) => m.id.toLowerCase() === n);
}

export function inferAzureBaseModel(deploymentName: string): string | null {
  const n = deploymentName.toLowerCase();
  const compact = compactModelId(n);
  const hasBareGpt56Alias = compact.includes('gpt5.6');

  for (const model of AZURE_CATALOG) {
    if (hasBareGpt56Alias && model.id === 'gpt-5') continue;
    if (n.includes(model.id.toLowerCase()) || compact.includes(compactModelId(model.id))) {
      return model.id;
    }
  }

  if (hasBareGpt56Alias) return 'gpt-5.6-sol';

  const gpt5At = compact.indexOf('gpt5');
  if (gpt5At !== -1) {
    const suffix = compact.slice(gpt5At + 'gpt5'.length);
    if (suffix.includes('nano')) return 'gpt-5-nano';
    if (suffix.includes('mini')) return 'gpt-5-mini';
    return 'gpt-5';
  }

  if (compact.includes('gpt4.1nano')) return 'gpt-4.1-nano';
  if (compact.includes('gpt4.1mini')) return 'gpt-4.1-mini';
  if (compact.includes('gpt4.1')) return 'gpt-4.1';
  if (compact.includes('gpt4omini')) return 'gpt-4o-mini';
  if (compact.includes('gpt4o')) return 'gpt-4o';
  return null;
}

function catalogModelInfo(baseModelId: string): ModelInfo | undefined {
  const entry = catalogEntry(baseModelId);
  if (!entry?.contextWindow) return undefined;
  return {
    id: entry.id,
    name: entry.name,
    provider: 'openai',
    contextWindow: entry.contextWindow,
    isVisionCapable: entry.vision ?? false,
    inputCostPer1kTokens: 0,
    outputCostPer1kTokens: 0,
    maxOutputTokens: entry.maxOutputTokens ?? 16_000,
    supportsStreaming: true,
    isLocal: false,
    supportsToolUse: entry.toolUse ?? true,
    pricingUnknown: true,
  };
}

export function azureModelForDeployment(cfg: ProviderConfig): ModelInfo | null {
  if (cfg.type !== 'azure' || !cfg.deploymentName?.trim()) return null;
  const id = cfg.deploymentName.trim();
  const name = cfg.label?.trim() || id;
  const baseModelId = cfg.model?.trim() || inferAzureBaseModel(id) || undefined;
  const base = baseModelId
    ? (MODELS[baseModelId] ?? catalogModelInfo(baseModelId))
    : undefined;

  if (base && baseModelId) {
    const azurePrice = resolvePricing(
      { id, provider: 'azure', isLocal: false, baseModelId },
      { region: cfg.region },
    );
    const exactAzurePrice = !azurePrice.unknown && !azurePrice.estimatedFromProvider;

    const nativeToolsOnThisTransport = /^gpt-5\.6-(?:sol|terra|luna)$/i.test(baseModelId)
      ? false
      : (base.supportsToolUse ?? true);

    return {
      ...base,
      id,
      name,
      provider: 'azure',
      baseModelId,
      supportsToolUse: nativeToolsOnThisTransport,
      ...(!azurePrice.unknown
        ? {
            inputCostPer1kTokens: azurePrice.input,
            outputCostPer1kTokens: azurePrice.output,
            pricingUnknown: !exactAzurePrice,
          }
        : { pricingUnknown: true }),
    };
  }

  return {
    id,
    name,
    provider: 'azure',
    ...(baseModelId ? { baseModelId } : {}),
    contextWindow: 128_000,
    isVisionCapable: false,
    inputCostPer1kTokens: 0.0025,
    outputCostPer1kTokens: 0.01,
    maxOutputTokens: 16_000,
    supportsStreaming: true,
    isLocal: false,
    supportsToolUse: true,
    pricingUnknown: true,
  };
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

export class AzureOpenAIProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    const rawUrl = config.baseUrl ?? AZURE_BASE_URL_TEMPLATE.replace('{resource}', 'YOUR_RESOURCE');
    const endpoint = stripTrailingSlashes(rawUrl);
    super(
      {
        ...config,
        baseUrl: endpoint,
      },
      model,
    );

    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint,
      deployment: config.deploymentName ?? model.id,
      apiVersion: config.apiVersion ?? DEFAULT_AZURE_API_VERSION,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const fromDeployment = azureModelForDeployment(this.config);
    return [fromDeployment ?? this.model];
  }

  async isAvailable(): Promise<boolean> {
    const ping = (extra: Record<string, unknown>) =>
      this.client.chat.completions.create({
        model: this.model.id,
        messages: [{ role: 'user' as const, content: 'ping' }],
        ...extra,
      } as any);

    const reasoning = isReasoningModel(this.model.id);
    try {
      await ping(reasoning ? { max_completion_tokens: 16 } : { max_tokens: 1 });
      return true;
    } catch (err) {
      if (isParamShapeError(err)) {
        try {
          await ping({ max_completion_tokens: 16 });
          return true;
        } catch (err2) {
          return isParamShapeError(err2);
        }
      }
      return false;
    }
  }
}
