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
  for (const model of AZURE_CATALOG) {
    if (n.includes(model.id.toLowerCase()) || compact.includes(compactModelId(model.id))) {
      return model.id;
    }
  }

  // OpenAI documents bare `gpt-5.6` as the Sol alias. Keep that useful signal
  // even when an Azure deployment name omits the tier suffix. More-specific
  // catalog entries were checked above, so Terra/Luna cannot be swallowed here.
  if (compact.includes('gpt5.6')) return 'gpt-5.6-sol';

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
    // Azure gets its OWN price lookup. resolvePricing may fall back to OpenAI if
    // the Azure dataset has no row; that is useful as an estimate, but must not
    // masquerade as a confirmed Azure quote. pricingUnknown remains true in
    // that case so cost-sensitive routing/budgeting stays conservative.
    const azurePrice = resolvePricing(
      { id, provider: 'azure', isLocal: false, baseModelId },
      { region: cfg.region },
    );
    const exactAzurePrice = !azurePrice.unknown && !azurePrice.estimatedFromProvider;

    // Microsoft documents GPT-5.6 function tools on Chat Completions only with
    // reasoning_effort=none. Cascade's Azure transport does not currently send
    // that knob, so advertise the TRANSPORT truth (text-tool fallback) instead
    // of claiming native tool use and then failing the request.
    const nativeToolsOnThisTransport = /^gpt-5\.6-(?:sol|terra|luna)$/i.test(baseModelId)
      ? false
      : (base.supportsToolUse ?? true);

    return {
      ...base,
      id,               // callable deployment name
      name,
      provider: 'azure',
      baseModelId,      // canonical identity for benchmark + provider pricing
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
    pricingUnknown: true,
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
