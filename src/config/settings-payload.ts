// ─────────────────────────────────────────────
//  Cascade AI — applying a Settings save
// ─────────────────────────────────────────────
//
//  One function for the whole payload, because there are two live callers and
//  they had drifted apart on WHICH FIELDS EXIST.
//
//  The desktop IPC handler applied keys, endpoints, Azure deployments, models,
//  six budget fields, the web-search backends and the advanced allowlist. The
//  socket handler — reached by a standalone `cascade dashboard`, and by the
//  desktop whenever the Electron bridge is unavailable — applied keys,
//  endpoints, models and two budget fields, and silently ignored the rest while
//  the panel reported the save as successful. The panel sends ONE payload to
//  both, so every field it offered on that path was a control that appeared to
//  work and did nothing.
//
//  Credential rules live next door in `credential-write.ts`; this is everything
//  else, plus the ordering between them.

import type { CascadeConfig } from '../types.js';
import { sameAzureEndpoint } from './azure-endpoint.js';
import { applySettingsCredentials, type SettingsCredentialResult } from './credential-write.js';
import { validateConfig } from './validate.js';
import { hasProviderCredential } from './index.js';

/** One Azure deployment as the settings panel sends it. */
export interface AzureDeploymentInput {
  label?: string;
  apiKey?: string;
  baseUrl?: string;
  deploymentName?: string;
  apiVersion?: string;
  /**
   * Base-model override and pricing region.
   *
   * The panel has no controls for these, but the config does and
   * `azureModelForDeployment()` reads both — `model` for the real base-model
   * identity, `region` for Azure's regional pricing. The save REPLACES the
   * whole Azure list, so leaving them out of the DTO meant an unrelated or
   * no-op Settings save silently dropped a base-model mapping and a region,
   * changing routing and cost accounting through controls that were never
   * shown. Round-tripped so a replacement is a replacement of the fields the
   * editor owns, not of the row.
   */
  model?: string;
  region?: string;
}

/** The complete Settings save, as both surfaces send it. */
export interface SettingsPayload {
  keys?: Record<string, string | undefined>;
  endpoints?: Record<string, string | undefined>;
  models?: Record<string, string | undefined>;
  budget?: {
    maxCostPerRun?: number;
    autoBias?: string;
    dailyBudgetUsd?: number;
    sessionBudgetUsd?: number;
    maxTokensPerRun?: number;
    warnAtPct?: number;
  };
  azureDeployments?: AzureDeploymentInput[];
  webSearch?: { searxngUrl?: string; braveApiKey?: string; tavilyApiKey?: string };
  advanced?: Record<string, unknown>;
}

/**
 * The prior Azure row a saved deployment may inherit its key from.
 *
 * Matched on deployment name AND resource. An Azure key is resource-scoped, so
 * matching the name alone meant moving deployment "prod" from resource A to
 * resource B with a blank key field copied A's key onto B — a credential sent
 * to a resource that never issued it.
 */
export function priorAzureRow<T extends { deploymentName?: string; baseUrl?: string; model?: string; region?: string }>(
  prior: readonly T[],
  incoming: { deploymentName?: string; baseUrl?: string },
): T | undefined {
  if (!incoming.deploymentName) return undefined;
  return prior.find((p) => p.deploymentName === incoming.deploymentName
    && sameAzureEndpoint(p.baseUrl, incoming.baseUrl));
}

/** Apply the whole payload to a live config, in place. */
export function applySettingsPayload(
  config: CascadeConfig,
  data: SettingsPayload,
): SettingsCredentialResult {
  if (!Array.isArray(config.providers)) config.providers = [];
  const result = applySettingsCredentials(config.providers, data);

  // Azure supports multiple deployments — unlike every other provider type it
  // cannot be addressed by a bare `type`, so it gets its own replace-the-list
  // field rather than an entry in `keys`/`endpoints`.
  if (Array.isArray(data.azureDeployments)) {
    const priorAzure = config.providers.filter((p) => p.type === 'azure');
    const nonAzure = config.providers.filter((p) => p.type !== 'azure');
    const nextAzure = data.azureDeployments
      .map((d) => {
        // A row whose resource changed inherits nothing and needs a key typed
        // in the same save: an Azure key belongs to ONE resource.
        const prior = priorAzureRow(priorAzure, d);
        const apiKey = d.apiKey ? d.apiKey : prior?.apiKey;
        // Fields the editor does not address are carried over from the matching
        // prior row, exactly as its key is. Rebuilding the row from the DTO
        // alone made every save a lossy rewrite of everything the panel happens
        // not to show.
        const model = d.model ?? prior?.model;
        const region = d.region ?? prior?.region;
        return {
          type: 'azure' as const,
          ...(d.label ? { label: d.label } : {}),
          ...(d.baseUrl ? { baseUrl: d.baseUrl } : {}),
          ...(d.deploymentName ? { deploymentName: d.deploymentName } : {}),
          ...(d.apiVersion ? { apiVersion: d.apiVersion } : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(model ? { model } : {}),
          ...(region ? { region } : {}),
        };
      })
      // Drop rows the user added then left completely empty.
      .filter((d) => d.apiKey || d.baseUrl || d.deploymentName);
    config.providers = [...nonAzure, ...nextAzure];
  }

  if (data.models) {
    const models = (config.models ?? {}) as Record<string, string | undefined>;
    // 'auto' / '' mean "no override — let routing pick", so the binding is
    // DELETED rather than stored, or the router hunts for a model called "auto".
    for (const [tier, val] of Object.entries(data.models)) {
      if (val && val !== 'auto') models[tier] = val;
      else delete models[tier];
    }
    config.models = models as CascadeConfig['models'];
  }

  if (data.budget) {
    const b = data.budget;
    config.budget = config.budget ?? {};
    // Each cap is OPTIONAL and the panel says so: blank means no cap. Acting
    // only on numbers made a blank field mean "preserve", so an existing cap
    // could not be removed — the save ACK then rehydrated the old value and the
    // control was simply impossible to clear.
    //
    // Present-but-not-a-number is the clear; an ABSENT property still means the
    // surface is not speaking for that field. Same contract as `endpoints`.
    const cap = (
      key: keyof typeof b,
      target: 'maxCostPerRunUsd' | 'dailyBudgetUsd' | 'sessionBudgetUsd' | 'maxTokensPerRun' | 'warnAtPct',
      accept: (n: number) => boolean,
      round = false,
    ): void => {
      if (!Object.hasOwn(b, key)) return;
      const v = b[key];
      // A value the schema would reject is treated as "no cap" rather than
      // stored: `maxCostPerRunUsd` is `.positive()`, so writing the 0 this
      // panel allows produced a config file that fails validation on the very
      // next load.
      if (typeof v === 'number' && accept(v)) config.budget[target] = round ? Math.floor(v) : v;
      else delete config.budget[target];
    };
    cap('maxCostPerRun', 'maxCostPerRunUsd', (n) => n > 0);
    cap('dailyBudgetUsd', 'dailyBudgetUsd', (n) => n > 0);
    cap('sessionBudgetUsd', 'sessionBudgetUsd', (n) => n > 0);
    cap('maxTokensPerRun', 'maxTokensPerRun', (n) => n > 0, true);
    cap('warnAtPct', 'warnAtPct', (n) => n > 0 && n <= 100);
    if (b.autoBias === 'balanced' || b.autoBias === 'quality' || b.autoBias === 'cost') {
      config.autoBias = b.autoBias;
    }
  }

  // Web-search backends: the URL is set/cleared directly ('' clears it); API
  // keys keep the "blank means keep the existing key" semantics of the provider
  // key fields.
  if (data.webSearch && typeof data.webSearch === 'object') {
    config.tools = config.tools ?? {};
    const prior = (config.tools.webSearch ?? {}) as { searxngUrl?: string; braveApiKey?: string; tavilyApiKey?: string };
    const next = { ...prior };
    if (typeof data.webSearch.searxngUrl === 'string') next.searxngUrl = data.webSearch.searxngUrl.trim() || undefined;
    if (data.webSearch.braveApiKey) next.braveApiKey = data.webSearch.braveApiKey;
    if (data.webSearch.tavilyApiKey) next.tavilyApiKey = data.webSearch.tavilyApiKey;
    config.tools.webSearch = next;
  }

  // Advanced settings: every field is individually validated against an
  // explicit allowlist — an unknown or malformed key is IGNORED, never written,
  // so a renderer cannot inject arbitrary config.
  if (data.advanced && typeof data.advanced === 'object') {
    const a = data.advanced;
    const num = (v: unknown, min: number, max: number): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
    };
    if (a['autonomy'] === 'manual' || a['autonomy'] === 'auto') config.autonomy = a['autonomy'];
    if (['never', 'complex', 'all', 'always'].includes(a['planApproval'] as string)) config.planApproval = a['planApproval'] as CascadeConfig['planApproval'];
    // Floor is the SCHEMA's (`z.number().int().min(1000)`), not zero: a 0 here
    // saved a config that failed validation on the next load.
    { const n = num(a['approvalTimeoutMs'], 1000, 86_400_000); if (n !== undefined) config.approvalTimeoutMs = Math.floor(n); }
    if (['auto', 'parallel', 'sequential'].includes(a['t3Execution'] as string)) config.t3Execution = a['t3Execution'] as CascadeConfig['t3Execution'];
    { const n = num(a['localConcurrency'], 1, 16); if (n !== undefined) config.localConcurrency = Math.floor(n); }
    // Floors are the SCHEMA's (`min(1000)`), not a stricter guess: 1–9 seconds
    // is a valid config that this writer was silently discarding while the
    // panel reported the save as successful.
    { const n = num(a['localInferenceTimeoutMs'], 1000, 3_600_000); if (n !== undefined) config.localInferenceTimeoutMs = Math.floor(n); }
    { const n = num(a['cloudInferenceTimeoutMs'], 1000, 3_600_000); if (n !== undefined) config.cloudInferenceTimeoutMs = Math.floor(n); }
    if (typeof a['reflectionEnabled'] === 'boolean') config.reflection = { ...(config.reflection ?? {}), enabled: a['reflectionEnabled'] };
    if (typeof a['cascadeAuto'] === 'boolean') config.cascadeAuto = a['cascadeAuto'];
    if (['auto', 'T1', 'T2', 'T3'].includes(a['forceTier'] as string)) config.routing = { ...(config.routing ?? {}), forceTier: a['forceTier'] as NonNullable<CascadeConfig['routing']>['forceTier'] };
    if (typeof a['benchmarksLive'] === 'boolean') config.benchmarks = { ...(config.benchmarks ?? {}), live: a['benchmarksLive'] };
    if (['isolate', 'worker', 'auto'].includes(a['dynamicToolSandbox'] as string)) config.tools = { ...(config.tools ?? {}), dynamicToolSandbox: a['dynamicToolSandbox'] as NonNullable<CascadeConfig['tools']>['dynamicToolSandbox'] };
    if (typeof a['factsExtraction'] === 'boolean') config.knowledge = { ...(config.knowledge ?? {}), factsExtraction: a['factsExtraction'] };
    if (typeof a['rememberSessions'] === 'boolean') config.memory = { ...(config.memory ?? {}), rememberSessions: a['rememberSessions'] };
    if (typeof a['enableToolCreation'] === 'boolean') config.enableToolCreation = a['enableToolCreation'];
    if (typeof a['persistDynamicTools'] === 'boolean') config.persistDynamicTools = a['persistDynamicTools'];
    if (typeof a['telemetryEnabled'] === 'boolean') config.telemetry = { ...(config.telemetry ?? {}), enabled: a['telemetryEnabled'] };
  }

  return result;
}

/**
 * The redacted Settings snapshot, as the panel reads it back.
 *
 * The read counterpart to `applySettingsPayload`, and it has to be as complete
 * as the write is. The desktop's IPC reply carried every section; the socket's
 * `config:current` carried models, two budget fields, key status and endpoints.
 * That was merely incomplete while the socket save was also partial — and
 * became DESTRUCTIVE the moment the save started applying the whole payload:
 * the panel keeps its own defaults for anything a snapshot does not fill
 * (`azureDeployments: []`, a blank SearXNG URL, the advanced defaults) and
 * serializes them on every save. A socket-only save of an unrelated setting
 * could therefore delete every Azure deployment and reset advanced knobs the
 * user had never seen.
 *
 * Secrets never come back — only whether one is set.
 */
export interface SettingsSnapshot {
  models: Record<string, string>;
  budget: {
    maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number;
    sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number;
  };
  providersWithKey: string[];
  endpoints: Record<string, string>;
  azureDeployments: Array<{
    label?: string; baseUrl?: string; deploymentName?: string; apiVersion?: string;
    model?: string; region?: string; hasKey: boolean;
  }>;
  webSearch: { searxngUrl?: string; hasBraveKey: boolean; hasTavilyKey: boolean };
  advanced: Record<string, unknown>;
}

export function settingsSnapshot(config: CascadeConfig): SettingsSnapshot {
  const providers = (config.providers ?? []) as Array<{
    type: string; apiKey?: string; authToken?: string; baseUrl?: string;
    label?: string; deploymentName?: string; apiVersion?: string;
    model?: string; region?: string;
  }>;
  const endpoints: Record<string, string> = {};
  for (const p of providers) {
    // Azure is addressed per deployment, so it cannot be represented in a
    // one-entry-per-type map; it gets its own rows below.
    if (p?.type && p?.baseUrl && p.type !== 'azure') endpoints[p.type] = p.baseUrl;
  }
  const ws = (config.tools?.webSearch ?? {}) as { searxngUrl?: string; braveApiKey?: string; tavilyApiKey?: string };
  return {
    models: (config.models ?? {}) as Record<string, string>,
    budget: {
      maxCostPerRun: config.budget?.maxCostPerRunUsd,
      autoBias: config.autoBias,
      dailyBudgetUsd: config.budget?.dailyBudgetUsd,
      sessionBudgetUsd: config.budget?.sessionBudgetUsd,
      maxTokensPerRun: config.budget?.maxTokensPerRun,
      warnAtPct: config.budget?.warnAtPct,
    },
    // Through the shared predicate: `authToken` is a credential too, and
    // counting only `apiKey` showed a bearer-configured provider as unconfigured.
    providersWithKey: providers.filter((p) => hasProviderCredential(p)).map((p) => p.type),
    endpoints,
    azureDeployments: providers
      .filter((p) => p.type === 'azure')
      .map((p) => ({
        label: p.label,
        baseUrl: p.baseUrl,
        deploymentName: p.deploymentName,
        apiVersion: p.apiVersion,
        // Surfaced so a panel that round-trips the snapshot cannot drop them.
        model: p.model,
        region: p.region,
        hasKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
      })),
    webSearch: {
      searxngUrl: ws.searxngUrl,
      hasBraveKey: typeof ws.braveApiKey === 'string' && ws.braveApiKey.length > 0,
      hasTavilyKey: typeof ws.tavilyApiKey === 'string' && ws.tavilyApiKey.length > 0,
    },
    advanced: {
      autonomy: config.autonomy,
      planApproval: config.planApproval,
      approvalTimeoutMs: config.approvalTimeoutMs,
      t3Execution: config.t3Execution,
      localConcurrency: config.localConcurrency,
      localInferenceTimeoutMs: config.localInferenceTimeoutMs,
      cloudInferenceTimeoutMs: config.cloudInferenceTimeoutMs,
      reflectionEnabled: config.reflection?.enabled,
      cascadeAuto: config.cascadeAuto,
      forceTier: config.routing?.forceTier,
      benchmarksLive: config.benchmarks?.live,
      dynamicToolSandbox: config.tools?.dynamicToolSandbox,
      factsExtraction: config.knowledge?.factsExtraction,
      rememberSessions: config.memory?.rememberSessions,
      enableToolCreation: config.enableToolCreation,
      persistDynamicTools: config.persistDynamicTools,
      telemetryEnabled: config.telemetry?.enabled,
    },
  };
}

/** The outcome of a settings save, for whichever surface asked for it. */
export interface SettingsCommitResult {
  /** False only when nothing was stored — the live config is untouched. */
  ok: boolean;
  /** Credentials deliberately not written, with the reason to show the user. */
  refused: SettingsCredentialResult['refused'];
  /** Why the save failed, when it did. */
  error?: string;
}

/**
 * Apply a settings save as a TRANSACTION, for every surface that has one.
 *
 * Both writers had the same bug and it was fixed in only one of them: the
 * payload was applied to the LIVE config and persisted afterwards, so a failed
 * write left the change running while the caller was told it had not saved. The
 * socket handler was made transactional; the desktop IPC bridge — the primary
 * path, tried before the socket — was not. Rather than stage in two places,
 * both call this.
 *
 * The order matters and each step exists for a reported failure:
 *
 *  1. apply the payload to a COPY, so a rejected save never runs;
 *  2. VALIDATE, and keep what the validator returns — it applies schema
 *     defaults, and discarding it left a config missing the fields a cleared
 *     cap should have fallen back to until the next restart re-applied them;
 *  3. write that validated copy, and only then
 *  4. adopt it into the live object IN PLACE, because the desktop main process
 *     holds a reference to it and swapping would strand that alias.
 *
 * Writing BEFORE adopting is the part that took two attempts. An earlier
 * revision adopted first and rolled back on failure, which reads as
 * equivalent and is not: `write()` is asynchronous filesystem I/O, and the
 * embedded `DashboardServer` reads that same live object when a run starts. A
 * run beginning inside that window used configuration that was never
 * persisted — and for an endpoint or credential change, may already have sent
 * the new secret somewhere — before the failed write rolled memory back and
 * the panel truthfully reported that nothing had saved. Handing the writer the
 * validated config as an argument, rather than letting it read the live one,
 * is what removes the window rather than narrowing it.
 *
 * There is consequently no rollback image: nothing is modified until the write
 * has landed.
 *
 * The caller syncs machine-global credentials only when this returns `ok`.
 */
export async function commitSettings(
  live: CascadeConfig,
  data: SettingsPayload,
  write: (config: CascadeConfig) => Promise<{ ok: true } | { ok: false; error: string }> | ({ ok: true } | { ok: false; error: string }),
): Promise<SettingsCommitResult> {
  const staged = structuredClone(live);
  const { refused } = applySettingsPayload(staged, data);

  let committed: CascadeConfig;
  try {
    committed = validateConfig(staged);
  } catch (err) {
    return {
      ok: false,
      refused,
      error: `Those settings are not valid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The writer is HANDED the config. It must not reach for the live one, which
  // is still the old configuration and stays that way until this resolves.
  const written = await write(committed);
  if (!written.ok) {
    return { ok: false, refused, error: `Could not write the config file: ${written.error}` };
  }
  replaceInPlace(live, committed);
  return { ok: true, refused };
}

/**
 * Overwrite one config object's contents with another's, keeping its identity.
 *
 * `Object.assign` alone would leave behind keys the save REMOVED — a cleared
 * budget cap, a retired provider — so they are deleted first.
 */
function replaceInPlace(target: CascadeConfig, source: CascadeConfig): void {
  const t = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(t)) delete t[key];
  Object.assign(t, structuredClone(source));
}
