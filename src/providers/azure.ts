// ─────────────────────────────────────────────
//  Cascade AI — Azure OpenAI Provider
// ─────────────────────────────────────────────

import { AzureOpenAI } from 'openai';
import { AZURE_BASE_URL_TEMPLATE, MODELS } from '../constants.js';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider, isReasoningModel, isParamShapeError } from './openai.js';
import { resolvePricing } from '../core/router/pricing.js';

// GPT-5.6 is documented on Azure Chat Completions with the 2025-04-01-preview
// data-plane API. Users can still pin a different version per deployment.
const DEFAULT_AZURE_API_VERSION = '2025-04-01-preview';

/**
 * Current Azure/OpenAI base-model metadata that is newer than Cascade's bundled
 * fallback catalogue, or whose published limits changed after that catalogue
 * was written. Keeping this beside the Azure picker means a newly-selected
 * deployment gets the right context/output/vision shape even before constants.ts
 * is refreshed. Pricing is still resolved through the authoritative pricing
 * dataset below; these rates are only the last-resort published list prices.
 */
const AZURE_CURRENT_BASE_MODELS: Readonly<Record<string, ModelInfo>> = {
  'gpt-5.6-sol': {
    id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai',
    contextWindow: 1_050_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.004, outputCostPer1kTokens: 0.02,
    maxOutputTokens: 128_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
  'gpt-5.6-terra': {
    id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'openai',
    contextWindow: 1_050_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.002, outputCostPer1kTokens: 0.012,
    maxOutputTokens: 128_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
  'gpt-5.6-luna': {
    id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai',
    contextWindow: 1_050_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.0002, outputCostPer1kTokens: 0.0012,
    maxOutputTokens: 128_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
  'gpt-5.5': {
    id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai',
    contextWindow: 1_050_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.005, outputCostPer1kTokens: 0.03,
    maxOutputTokens: 128_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
  'gpt-5.4': {
    id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai',
    contextWindow: 1_050_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.0025, outputCostPer1kTokens: 0.015,
    maxOutputTokens: 128_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai',
    contextWindow: 400_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.00075, outputCostPer1kTokens: 0.0045,
    maxOutputTokens: 128_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
  'gpt-5.4-nano': {
    id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', provider: 'openai',
    contextWindow: 400_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.0002, outputCostPer1kTokens: 0.00125,
    maxOutputTokens: 128_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
  'gpt-5.2': {
    id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai',
    contextWindow: 400_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.00175, outputCostPer1kTokens: 0.014,
    maxOutputTokens: 128_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
  'gpt-5.1': {
    id: 'gpt-5.1', name: 'GPT-5.1', provider: 'openai',
    contextWindow: 400_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.00125, outputCostPer1kTokens: 0.01,
    maxOutputTokens: 128_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
  'o3': {
    id: 'o3', name: 'o3', provider: 'openai',
    contextWindow: 200_000, isVisionCapable: true,
    inputCostPer1kTokens: 0.002, outputCostPer1kTokens: 0.008,
    maxOutputTokens: 100_000, supportsStreaming: true, isLocal: false, supportsToolUse: true,
  },
};

/**
 * Base models an Azure deployment can be mapped onto, most-specific first.
 *
 * This is the single source for BOTH deployment-name inference and every UI
 * picker served through /api/config. It intentionally contains models Cascade's
 * Chat-Completions provider can actually call; Responses-only Pro/Codex models,
 * media models, and deprecated aliases are not advertised here.
 */
const AZURE_BASE_MODEL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/gpt-?5\.6.*sol/, 'gpt-5.6-sol'],
  [/gpt-?5\.6.*terra/, 'gpt-5.6-terra'],
  [/gpt-?5\.6.*luna/, 'gpt-5.6-luna'],
  [/gpt-?5\.5/, 'gpt-5.5'],
  [/gpt-?5\.4.*nano/, 'gpt-5.4-nano'],
  [/gpt-?5\.4.*mini/, 'gpt-5.4-mini'],
  [/gpt-?5\.4/, 'gpt-5.4'],
  [/gpt-?5\.2/, 'gpt-5.2'],
  [/gpt-?5\.1/, 'gpt-5.1'],
  [/gpt-?5.*nano/, 'gpt-5-nano'],
  [/gpt-?5.*mini/, 'gpt-5-mini'],
  [/gpt-?5/, 'gpt-5'],
  [/gpt-?4\.1-nano/, 'gpt-4.1-nano'],
  [/gpt-?4\.1-mini/, 'gpt-4.1-mini'],
  [/gpt-?4\.1/, 'gpt-4.1'],
  [/gpt-?4o-mini/, 'gpt-4o-mini'],
  [/gpt-?4o/, 'gpt-4o'],
  [/^o3(?:-|$)/, 'o3'],
];

/** Selectable base models, in the order a picker should show them. */
export const AZURE_BASE_MODELS: readonly string[] = AZURE_BASE_MODEL_RULES.map(([, id]) => id);

export function inferAzureBaseModel(deploymentName: string): string | null {
  const n = deploymentName.toLowerCase();
  for (const [re, base] of AZURE_BASE_MODEL_RULES) if (re.test(n)) return base;
  return null;
}

/** Resolve published metadata, preferring the current Azure/OpenAI overlay. */
function azureBaseModelInfo(baseModelId: string): ModelInfo | undefined {
  return AZURE_CURRENT_BASE_MODELS[baseModelId] ?? MODELS[baseModelId];
}

/**
 * The ModelInfo for one configured Azure deployment. On Azure the deployment IS
 * the model (you address it by deployment name, and which base model backs it is
 * opaque to the API) — so each `providers[]` entry with a deploymentName becomes
 * one selectable model.
 *
 * Which base model it serves drives correct benchmark scoring + pricing, so we
 * resolve it: an explicit `cfg.model` (user override) wins, else we infer it from
 * the deployment name. When resolved to a known catalog model, this deployment
 * INHERITS that model's real economics (context window, pricing, vision, output
 * cap) while keeping the deployment name as its callable `id` and carrying the
 * base identity in `baseModelId`. Unresolved deployments fall back to neutral
 * GPT-4o-class defaults (an estimate, not $0), exactly as before.
 */
export function azureModelForDeployment(cfg: ProviderConfig): ModelInfo | null {
  if (cfg.type !== 'azure' || !cfg.deploymentName?.trim()) return null;
  const id = cfg.deploymentName.trim();
  const name = cfg.label?.trim() || id;
  const baseModelId = cfg.model?.trim() || inferAzureBaseModel(id) || undefined;
  const base = baseModelId ? azureBaseModelInfo(baseModelId) : undefined;
  if (base) {
    // Azure charges its own rates for the same model, and they vary by region.
    // Prefer the dataset's Azure entry for the configured region; it falls back
    // to OpenAI list price only when Azure has no entry, and the published
    // metadata value above is the last resort.
    const azurePrice = resolvePricing(
      { id, provider: 'azure', isLocal: false, baseModelId },
      { region: cfg.region },
    );
    return {
      ...base,
      id,               // callable deployment name
      name,
      provider: 'azure',
      baseModelId,      // real identity for benchmark + live pricing
      supportsToolUse: base.supportsToolUse ?? true,
      ...(azurePrice.unknown
        ? {}
        : {
            inputCostPer1kTokens: azurePrice.input,
            outputCostPer1kTokens: azurePrice.output,
            pricingUnknown: false,
          }),
    };
  }
  // Unknown base — keep neutral defaults so cost/context read as an estimate.
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
  };
}

export class AzureOpenAIProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    const rawUrl = config.baseUrl ?? AZURE_BASE_URL_TEMPLATE.replace('{resource}', 'YOUR_RESOURCE');
    const endpoint = rawUrl.replace(/\/+$/, ''); // Strip trailing slashes
    super(
      {
        ...config,
        baseUrl: endpoint, // Kept for superclass compatibility if it reads it
      },
      model,
    );

    // Use the official AzureOpenAI SDK class which correctly handles pathing and API keys natively
    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: endpoint,
      deployment: config.deploymentName ?? model.id,
      apiVersion: config.apiVersion ?? DEFAULT_AZURE_API_VERSION,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    // Azure has no queryable model catalog — the configured deployment IS the
    // model. Surface it under its deployment name (previously this returned
    // the synthesized 'azure' seed, so real deployments never appeared in any
    // model list and the desktop's Azure dropdown stayed empty).
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

    // Reasoning deployments (o1/o3, gpt-5*) reject max_tokens and a custom
    // temperature; give them max_completion_tokens (with enough budget to answer
    // past their internal reasoning) up front, others the cheap max_tokens: 1.
    const reasoning = isReasoningModel(this.model.id);
    try {
      await ping(reasoning ? { max_completion_tokens: 16 } : { max_tokens: 1 });
      return true;
    } catch (err) {
      // Wrong param shape → retry the other way. Crucially, a param complaint
      // proves the deployment EXISTS and is reachable, so treat it as available
      // rather than marking the whole provider down (which surfaced downstream
      // as "No model available for tier T1").
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
