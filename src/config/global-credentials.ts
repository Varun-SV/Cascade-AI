// ─────────────────────────────────────────────
//  Cascade AI — Global credentials store
// ─────────────────────────────────────────────
//
//  Provider credentials (API keys, Azure deployments, custom endpoints) live in
//  ONE machine-global file — `~/.cascade-ai/credentials.json`, chmod 600 — the
//  same pattern as Claude Code's ~/.claude/.credentials.json or the gh CLI.
//
//  Why: keys used to exist only in the per-workspace `.cascade/config.json`, so
//  switching the desktop app (or CLI) to a different folder silently "forgot"
//  every key. Now ConfigManager merges this file into whatever workspace config
//  it loads, and syncs credential-bearing entries back on every save — enter a
//  key once, keep it everywhere. A workspace config that carries its own key
//  for a provider still wins (per-project override).

import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig } from '../types.js';
import { GLOBAL_CREDENTIALS_FILE } from '../constants.js';
import { normalizeAzureEndpoint } from './azure-endpoint.js';
import { sameEndpoint } from '../utils/net.js';

interface CredentialsFile {
  version: 1;
  providers: ProviderConfig[];
}

export function credentialsPath(globalDir: string): string {
  return path.join(globalDir, GLOBAL_CREDENTIALS_FILE);
}

/**
 * Identity of a NON-Azure provider entry. Every other type is a singleton, so
 * the type alone is the key. Azure is matched by `sameAzureEntry` instead —
 * see there for why a single string key cannot express it.
 */
function providerKey(p: ProviderConfig): string {
  return p.type;
}

/** The endpoint of an Azure row, normalized, or undefined when it has none. */
function azureEndpoint(p: ProviderConfig): string | undefined {
  // An absent baseUrl must stay nullish rather than normalizing to the empty
  // string, or "has no endpoint" and "has an empty endpoint" stop being
  // distinguishable and the fallbacks below become unreachable.
  return p.baseUrl === undefined ? undefined : normalizeAzureEndpoint(p.baseUrl);
}

/**
 * Whether two Azure rows are the same entry.
 *
 * Azure keys are RESOURCE-scoped and the deployment name is only unique within
 * a resource, so identity needs both — but not symmetrically, which is why
 * this is a predicate rather than a key string.
 *
 * Keying on `deploymentName` alone (what this did) meant the endpoint never
 * participated in the normal routed shape, where a deployment name is always
 * present. A global row for resource A named `prod` then collided with a
 * workspace row named `prod` on resource B: the merge below keeps B's own
 * `baseUrl` but fills its missing `apiKey`, so resource A's key was sent to
 * resource B. `cascade link` already refuses to reuse a deployment name across
 * resources for exactly this reason; the global store now holds the same
 * invariant.
 *
 * The rule: every REAL identifier present on both rows must agree, and at least
 * one must be present on both. That keeps the case the store exists for — a
 * workspace row naming only `deploymentName`, adopting the endpoint AND key
 * from the global row — because an identifier absent on one side is not a
 * disagreement. Only a row that names a DIFFERENT resource is rejected.
 *
 * `label` is a FALLBACK, never a constraint. It is a display name the user
 * types, so two rows for the same deployment on the same resource routinely
 * carry different ones ("project prod" vs "prod"). Weighing it beside the real
 * identifiers made that pair non-matching: the global row was appended instead
 * of filling the workspace row, and since the router binds an Azure model with
 * `configs.find(... deploymentName === model.id)`, the first — keyless —
 * workspace row won and every request failed while a correctly keyed duplicate
 * sat behind it. So label decides only when neither resource nor deployment
 * can, which is the role it had before.
 */
function sameAzureEntry(a: ProviderConfig, b: ProviderConfig): boolean {
  const strong: Array<[string | undefined, string | undefined]> = [
    [a.deploymentName, b.deploymentName],
    [azureEndpoint(a), azureEndpoint(b)],
  ];
  let shared = 0;
  for (const [x, y] of strong) {
    if (!x || !y) continue;      // absent on one side — says nothing either way
    if (x !== y) return false;   // present on both and different — different entries
    shared++;
  }
  if (shared > 0) return true;

  // No real identifier is stated on BOTH sides. Label decides only when neither
  // side states one at all — never to join rows whose strong identities are
  // merely uncorrelated. A workspace row `{ deploymentName: 'prod', label:
  // 'main' }` and a global row `{ baseUrl: resourceA, label: 'main' }` each
  // name something real, and nothing relates the two; joining them on a display
  // name the user typed would assign resource A's key to `prod` on a guess.
  // Label is metadata, not identity.
  const aNamesSomething = Boolean(a.deploymentName || azureEndpoint(a));
  const bNamesSomething = Boolean(b.deploymentName || azureEndpoint(b));
  if (aNamesSomething || bNamesSomething) return false;

  return Boolean(a.label && b.label && a.label === b.label);
}

/** An entry is worth persisting globally if it carries a credential or endpoint. */
function isPersistable(p: ProviderConfig): boolean {
  return Boolean(p.apiKey || p.authToken || p.type === 'azure' || p.baseUrl);
}

/** Read the global credentials file. Missing or corrupt → empty list (never throws). */
export function loadGlobalCredentials(globalDir: string): ProviderConfig[] {
  try {
    const raw = fs.readFileSync(credentialsPath(globalDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
    if (!Array.isArray(parsed.providers)) return [];
    return parsed.providers.filter(
      (p): p is ProviderConfig => Boolean(p) && typeof (p as { type?: unknown }).type === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Write the credential-bearing provider entries to the global file
 * (0600, directory 0700, atomic tmp+rename). The given list is authoritative:
 * ConfigManager merges the global file into its config at load time, so by
 * save time the config's providers are a superset of the global entries minus
 * anything the user explicitly removed — meaning removal sticks too.
 */
export function saveGlobalCredentials(globalDir: string, providers: ProviderConfig[]): void {
  const filePath = credentialsPath(globalDir);
  fs.mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  const body: CredentialsFile = { version: 1, providers: providers.filter(isPersistable) };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  // rename preserves the tmp file's 0600; chmod again defensively in case an
  // older file existed with looser permissions.
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
}

/**
 * Merge global credentials into a workspace's provider list.
 *
 * - A global entry with no workspace counterpart is appended.
 * - A workspace entry missing its key (or endpoint) is filled from the global
 *   entry for the same provider.
 * - A workspace entry that has its own key keeps it (per-project override).
 */
export function mergeGlobalCredentials(
  workspaceProviders: ProviderConfig[],
  globalProviders: ProviderConfig[],
): ProviderConfig[] {
  const merged = [...workspaceProviders];
  const byKey = new Map(merged.filter((p) => p.type !== 'azure').map((p) => [providerKey(p), p]));

  for (const g of globalProviders) {
    // An Azure global row that names a RESOURCE but no deployment is a
    // resource-scoped key, and Azure keys are resource-scoped by definition —
    // so it belongs to every deployment on that resource, not just whichever
    // one `find` happened to reach first. With `find`, the second and later
    // deployments stayed keyless and failed every request while the first
    // worked, which reads as "Azure is broken on this machine".
    if (g.type === 'azure' && !g.deploymentName?.trim() && azureEndpoint(g)) {
      const onResource = merged.filter((p) => p.type === 'azure' && sameAzureEntry(p, g));
      if (onResource.length > 0) {
        for (const row of onResource) fillFrom(row, g);
        continue;
      }
    }
    // Azure is otherwise scanned rather than looked up: its identity is a
    // predicate over two rows (see sameAzureEntry), not a string one row can
    // produce alone.
    const existing = g.type === 'azure'
      ? merged.find((p) => p.type === 'azure' && sameAzureEntry(p, g))
      : byKey.get(providerKey(g));
    if (!existing) {
      merged.push({ ...g });
      if (g.type !== 'azure') byKey.set(providerKey(g), merged[merged.length - 1]!);
      continue;
    }
    // `apiKey` and `authToken` are COMPETING credentials for one provider, not
    // two independent fields — AnthropicProvider prefers the bearer when both
    // are set. Filling one beside the other therefore silently overrides the
    // credential already there: a workspace row holding a freshly exported API
    // key would gain the global row's stale bearer and send THAT to the newly
    // exported gateway. A row that already has a credential keeps it and gains
    // no rival; only a row with neither adopts one.
    fillFrom(existing, g);
  }
  return merged;
}

/**
 * Fill a workspace row's empty slots from a matching global row.
 *
 * A credential and the endpoint it was issued for are ONE unit, in BOTH
 * directions:
 *
 * - A secret is never imported into a row naming a different host. That way
 *   round, a workspace row naming gateway B with no credential adopted the
 *   global row's secret from gateway A, and the result passed every usability
 *   check on the way to the wire.
 * - An endpoint is never grafted onto a row that already has its OWN
 *   credential — UNLESS the two rows matched on something specific. That way
 *   round, a workspace row holding a project API key and no endpoint silently
 *   acquired the global row's corporate gateway, sending a key to a host it was
 *   never paired with.
 *
 *   `strongMatch` is what separates the two cases, and it is not a hedge. A
 *   non-Azure row matches on provider TYPE alone — "some anthropic row" — which
 *   says nothing about which host either means, so an endpoint from it is a
 *   guess. An Azure row matches through `sameAzureEntry`, on an agreeing
 *   deployment name or resource; a deployment name pins its resource, so the
 *   global row is not guessing where that deployment lives, it is the only
 *   record of it. An Azure deployment with no endpoint cannot route a request
 *   at all, so refusing the fill there would break the case the store exists
 *   for.
 *
 * The rule covers `apiKey` exactly as it does `authToken`: the environment path
 * already treats `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` as a pair, and an
 * OpenAI-compatible key is endpoint-bound too. Non-Azure rows still match on
 * provider type alone, so this pairing is the only thing standing between two
 * hosts for one provider type.
 */
function fillFrom(existing: ProviderConfig, g: ProviderConfig): void {
  const strongMatch = g.type === 'azure';
  const credentialled = Boolean(existing.apiKey || existing.authToken);
  const endpointsDiffer = Boolean(
    existing.baseUrl && g.baseUrl && !sameEndpoint(existing.baseUrl, g.baseUrl),
  );

  if (!credentialled && !endpointsDiffer && g.apiKey) {
    existing.apiKey = g.apiKey;
    if (g.baseUrl) existing.baseUrl = g.baseUrl;
  }
  // A bearer additionally REQUIRES a gateway: without one there is nowhere it
  // can be sent, so adopting it would only make the row look configured.
  if (!credentialled && !endpointsDiffer && !existing.apiKey && g.authToken && g.baseUrl) {
    existing.authToken = g.authToken;
    existing.baseUrl = g.baseUrl;
  }
  if ((!credentialled || strongMatch) && !existing.baseUrl && g.baseUrl) existing.baseUrl = g.baseUrl;
  if (!existing.apiVersion && g.apiVersion) existing.apiVersion = g.apiVersion;
  if (!existing.label && g.label) existing.label = g.label;
}
