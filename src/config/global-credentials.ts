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
 * The rule: every identifier present on BOTH rows must agree, and at least one
 * must be present on both. That keeps the case the store exists for — a
 * workspace row naming only `deploymentName`, adopting the endpoint AND key
 * from the global row — because an identifier absent on one side is not a
 * disagreement. Only a row that names a DIFFERENT resource is rejected.
 */
function sameAzureEntry(a: ProviderConfig, b: ProviderConfig): boolean {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [a.deploymentName, b.deploymentName],
    [azureEndpoint(a), azureEndpoint(b)],
    [a.label, b.label],
  ];
  let shared = 0;
  for (const [x, y] of pairs) {
    if (!x || !y) continue;      // absent on one side — says nothing either way
    if (x !== y) return false;   // present on both and different — different entries
    shared++;
  }
  return shared > 0;
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
    // Azure is scanned rather than looked up: its identity is a predicate over
    // two rows (see sameAzureEntry), not a string one row can produce alone.
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
    const credentialled = Boolean(existing.apiKey || existing.authToken);
    if (!credentialled && g.apiKey) existing.apiKey = g.apiKey;
    if (!credentialled && !existing.apiKey && g.authToken) existing.authToken = g.authToken;
    if (!existing.baseUrl && g.baseUrl) existing.baseUrl = g.baseUrl;
    if (!existing.apiVersion && g.apiVersion) existing.apiVersion = g.apiVersion;
    if (!existing.label && g.label) existing.label = g.label;
  }
  return merged;
}
