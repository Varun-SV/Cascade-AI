// ─────────────────────────────────────────────
//  Cascade AI — which Azure resource does this key belong to?
// ─────────────────────────────────────────────
//
//  One invariant, asked by three callers that each had their own copy of it:
//  `cascade link azure` (cli/commands/link.ts), the automatic environment
//  injection (ConfigManager.azureEntriesForEnv) and `cascade doctor`. Every
//  round of review in this area has found the copies disagreeing — first on
//  whether an endpointless row counts as a resource, then on whether a named
//  deployment is created or silently dropped, and finally on what happens when
//  the same deployment name exists on two resources.
//
//  That last one is the reason this file exists rather than a fourth patch.
//  Both surviving copies resolved a named deployment with `find(...)`, which
//  takes whichever row happens to come first — so with `prod` on resource A and
//  on resource B, an exported key rotated an arbitrary one of them. Cascade's
//  own collision checks exist precisely because that name can occur twice.

import { normalizeAzureEndpoint, sameAzureEndpoint } from './azure-endpoint.js';

/** The minimum shape this reasoning needs from a provider entry. */
export interface AzureRow {
  type: string;
  baseUrl?: string;
  deploymentName?: string;
}

export type AzureRouting<T extends AzureRow = AzureRow> =
  /** The key belongs to this resource; `rows` are the entries on it. */
  | { ok: true; resource: string; rows: T[]; createDeployment?: string }
  /** Cannot be decided safely. `reason` says which refusal to print. */
  | {
    ok: false;
    reason: 'no-routable-rows' | 'endpoint-not-configured' | 'ambiguous-resource' | 'name-on-another-resource';
    /** The distinct resources in play, for the message. */
    resources: string[];
  };

/** Rows that can actually route a request: a deployment needs its resource URL. */
export function routableAzureRows<T extends AzureRow>(rows: readonly T[]): T[] {
  return rows.filter((p) => p.type === 'azure' && p.baseUrl?.trim());
}

/**
 * Decide which Azure resource an exported key belongs to, and what to do.
 *
 * `view` is every row that can inform the decision — the workspace plus, where
 * the caller has it, the machine-global store. `write` is the subset the caller
 * may actually modify; rows are returned from it.
 *
 * The rules, in order:
 *
 * - An explicit endpoint always wins, and must name a configured resource.
 * - Otherwise a deployment name may pin the resource — but ONLY if every row
 *   carrying that name resolves to one resource. Two resources sharing a name
 *   is a genuine ambiguity and is refused, not guessed.
 * - Otherwise a single configured resource is unambiguous on its own.
 *
 * When an endpoint IS given and the named deployment already exists on a
 * different resource, that is the collision `azureRoutedTarget()` refuses:
 * deployment names are model ids in Cascade, so the second row could never be
 * selected. Reported rather than silently discarded, which is what the
 * environment path did — it saw the name on the other resource, skipped the
 * upsert, rotated the anchor's siblings and reported success.
 */
export function resolveAzureRouting<T extends AzureRow>(
  view: readonly AzureRow[],
  write: readonly T[],
  env: { endpoint?: string; deployment?: string },
): AzureRouting<T> {
  const rows = routableAzureRows(view);
  const resourcesOf = (list: readonly AzureRow[]) =>
    [...new Set(list.map((p) => normalizeAzureEndpoint(p.baseUrl)))];
  if (rows.length === 0) return { ok: false, reason: 'no-routable-rows', resources: [] };

  const endpoint = env.endpoint?.trim();
  const deployment = env.deployment?.trim();
  const named = deployment
    ? rows.filter((p) => (p.deploymentName?.trim() ?? '') === deployment)
    : [];

  let anchor: AzureRow | undefined;
  if (endpoint) {
    anchor = rows.find((p) => sameAzureEndpoint(p.baseUrl, endpoint));
    if (!anchor) {
      return { ok: false, reason: 'endpoint-not-configured', resources: resourcesOf(rows) };
    }
    // The name is already a model id on some OTHER resource.
    const elsewhere = named.filter((p) => !sameAzureEndpoint(p.baseUrl, endpoint));
    if (elsewhere.length > 0) {
      return { ok: false, reason: 'name-on-another-resource', resources: resourcesOf(elsewhere) };
    }
  } else if (named.length > 0) {
    const owners = resourcesOf(named);
    // `find()` used to take whichever came first. A deployment name is unique
    // only within a resource, so two owners is an ambiguity, not a tiebreak.
    if (owners.length > 1) return { ok: false, reason: 'ambiguous-resource', resources: owners };
    anchor = named[0];
  } else {
    const all = resourcesOf(rows);
    if (all.length !== 1) return { ok: false, reason: 'ambiguous-resource', resources: all };
    anchor = rows[0];
  }

  const resource = anchor!.baseUrl!;
  // Scoped to the SELECTED resource, and only after the collision checks above:
  // a name on another resource must raise, never suppress the upsert here.
  const onResource = routableAzureRows(write).filter((p) => sameAzureEndpoint(p.baseUrl, resource));
  const alreadyThere = deployment
    ? onResource.some((p) => (p.deploymentName?.trim() ?? '') === deployment)
      || named.some((p) => sameAzureEndpoint(p.baseUrl, resource))
    : true;

  return {
    ok: true,
    resource,
    rows: onResource,
    ...(deployment && !alreadyThere ? { createDeployment: deployment } : {}),
  };
}
