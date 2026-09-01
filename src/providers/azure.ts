// ─────────────────────────────────────────────
//  Cascade AI — Azure OpenAI Provider
// ─────────────────────────────────────────────

import { AzureOpenAI } from 'openai';
import { AZURE_BASE_URL_TEMPLATE, MODELS } from '../constants.js';
import type { ModelInfo, ProviderConfig } from '../types.js';
import { OpenAIProvider, isReasoningModel, isParamShapeError } from './openai.js';
import { resolvePricing } from '../core/router/pricing.js';
import cloudModelCatalog from './cloud-model-catalog.json' with { type: 'json' };

// Default Azure API version. Bumped from 2024-08-01-preview, which predates the
// gpt-5 / reasoning deployments and made their availability probe (and runs)
// fail as "deployment not found". Users can still override it per-deployment.
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
  // Match longer/more-specific ids first: gpt-5.6-sol before the generic gpt-5.
  .slice()
  .sort((a, b) => b.id.length - a.id.length || a.id.localeCompare(b.id));

/**
 * Selectable Azure base models, generated from the verified cloud-model catalog.
 *
 * Capability identity lives in cloud-model-catalog.json; price does NOT. The
 * same GPT model can cost a different amount on OpenAI vs Azure (and by Azure
 * region), so azureModelForDeployment() resolves economics from pricing-data
 * using provider='azure' + region rather than copying a model-global price.
 */
export const AZURE_BASE_MODELS: readonly string[] = AZURE_CATALOG.map((m) => m.id);

function compactModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

function catalogEntry(id: string): CloudCatalogEntry | undefined {
  const n = id.toLowerCase();
  return CLOUD_MODELS.find((m) => m.id.toLowerCase() === n);
}

/**
 * Best-effort guess of the canonical base model an Azure deployment backs, from
 * its (arbitrary) deployment name. The verified catalog is checked
 * most-specific → least-specific, then legacy family fallbacks preserve the old
 * behavior for deployment names such as `gpt5nano-prod` or an as-yet-unknown
 * gpt-5.x point release.
 *
 * The fallback path deliberately uses string scans instead of `gpt-?5.*mini`
 * style regular expressions. Deployment names are user/provider-controlled, and
 * an unbounded `.*` between two literals can trigger polynomial backtracking in
 * JS regex engines on adversarial inputs. `indexOf`/`includes` keeps this path
 * linear in the deployment-name length while preserving the same semantics.
 */
export function inferAzureBaseModel(deploymentName: string): string | null {
  const n = deploymentName.toLowerCase();
  const compact = compactModelId(n);
  const hasBareGpt56Alias = compact.includes('gpt5.6');

  for (const model of AZURE_CATALOG) {
    // A bare gpt-5.6 deployment name is OpenAI's Sol alias. Skip the generic
    // gpt-5 catalog entry here so it cannot swallow that signal before the
    // alias fallback below; explicit Sol/Terra/Luna entries still match first.
    if (hasBareGpt56Alias && model.id === 'gpt-5') continue;
    if (n.includes(model.id.toLowerCase()) || compact.includes(compactModelId(model.id))) {
      return model.id;
    }
  }

  // OpenAI documents bare `gpt-5.6` as the Sol alias. Keep that useful signal
  // even when an Azure deployment name omits the tier suffix. More-specific
  // catalog entries were checked above, so Terra/Luna cannot be swallowed here.
  if (hasBareGpt56Alias) return 'gpt-5.6-sol';

  // Legacy / forward-compatible GPT-5 family fallback. Search only the suffix
  // after the first family marker so names such as `prod-gpt5foo-mini` retain
  // the previous "gpt-5 ... mini" behavior without a backtracking regex.
  const gpt5At = compact.indexOf('gpt5');
  if (gpt5At !== -1) {
    const suffix = compact.slice(gpt5At + 'gpt5'.length);
    if (suffix.includes('nano')) return 'gpt-5-nano';
    if (suffix.includes('mini')) return 'gpt-5-mini';
    return 'gpt-5';
  }

  // Older families are simple literal variants after compaction; order the
  // specific variants before their base model so mini/nano cannot be swallowed.
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

/**
 * The ModelInfo for one configured Azure deployment. On Azure the deployment IS
 * the model (you address it by deployment name, and which base model backs it is
 * opaque to the API) — so each `providers[]` entry with a deploymentName becomes
 * one selectable model.
 *
 * Which base model it serves drives correct benchmark scoring + capabilities,
 * while economics stay provider-specific. An explicit `cfg.model` wins over
 * inference. Known legacy models come from MODELS; newer catalog models (for
 * example GPT-5.6 Sol/Terra/Luna and GPT-5.4 Nano) use the verified cloud
 * capability catalog until constants.ts catches up.
 */
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

export class AzureOpenAIProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, model: ModelInfo) {
    const rawUrl = config.baseUrl ?? AZURE_BASE_URL_TEMPLATE.replace('{resource}', 'YOUR_RESOURCE');
    const endpoint = rawUrl.replace(/\/+$/, '');
    super(
      {
        ...config,
        baseUrl: endpoint,
      },
      model,
    );

    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: endpoint,
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
