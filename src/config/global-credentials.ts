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
//  key once, keep it everywhere.
//
//  Keys are kept nowhere else: a project's config (config/project-state.ts)
//  holds its providers without them. The keys a project's config held when
//  keys moved here stay that project's own, under `projects[<project>]`: it
//  goes on using them ahead of the machine-wide ones and of the environment,
//  as it did when they were in its config.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig } from '../types.js';
import { GLOBAL_CREDENTIALS_FILE } from '../constants.js';
import { normalizeAzureEndpoint } from './azure-endpoint.js';
import { credentialEndpointsConflict } from './endpoint-identity.js';
import { withLock } from '../utils/file-lock.js';

interface CredentialsFile {
  version: 1;
  providers: ProviderConfig[];
  /** A project's own keys, where they differ from the machine-wide ones; by project state folder name. */
  projects?: Record<string, ProviderConfig[]>;
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

const isProvider = (p: unknown): p is ProviderConfig =>
  Boolean(p) && typeof (p as { type?: unknown }).type === 'string';

/**
 * The whole file. Missing → empty. One that is there but cannot be read —
 * cut short, edited by hand — reads as empty too, unless `strict`: a change
 * written over it would lose every key it holds, so a change throws instead.
 */
function readCredentialsFile(globalDir: string, strict = false): CredentialsFile {
  const file = credentialsPath(globalDir);
  let parsed: Partial<CredentialsFile>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<CredentialsFile>;
    if (!parsed || typeof parsed !== 'object' || (parsed.providers !== undefined && !Array.isArray(parsed.providers))) {
      throw new Error('it is not a list of providers');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || !strict) return { version: 1, providers: [] };
    throw new Error(`The provider keys were not saved: ${file} cannot be read (${err instanceof Error ? err.message : String(err)}), and saving would replace every key in it. Fix the file, or move it aside to start afresh.`);
  }
  const projects: Record<string, ProviderConfig[]> = {};
  for (const [id, rows] of Object.entries(parsed.projects ?? {})) {
    if (Array.isArray(rows)) projects[id] = rows.filter(isProvider);
  }
  return {
    version: 1,
    providers: Array.isArray(parsed.providers) ? parsed.providers.filter(isProvider) : [],
    ...(Object.keys(projects).length ? { projects } : {}),
  };
}

/**
 * Change the file: read it and write it back holding its lock, so two
 * processes saving at once — two projects, or the desktop and the CLI — each
 * start from what the other wrote, rather than the last one dropping the
 * other's change. The write goes through a file of this writer's own and a
 * rename, so a reader never sees half of it.
 */
function updateCredentialsFile(globalDir: string, change: (file: CredentialsFile) => CredentialsFile): void {
  fs.mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  const filePath = credentialsPath(globalDir);
  withLock(`${filePath}.lock`, 'save the provider keys', () => {
    const body = change(readCredentialsFile(globalDir, true));
    const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    // rename preserves the tmp file's 0600; chmod again defensively in case an
    // older file existed with looser permissions.
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  });
}

/** Read the global credentials file. Missing or corrupt → empty list (never throws). */
export function loadGlobalCredentials(globalDir: string): ProviderConfig[] {
  return readCredentialsFile(globalDir).providers;
}

/** A project's own keys, where they differ from the machine-wide ones. */
export function loadProjectCredentials(globalDir: string, project: string): ProviderConfig[] {
  return readCredentialsFile(globalDir).projects?.[project] ?? [];
}

/** Providers as a project's config keeps them: with no key or token in them. */
export function withoutCredentials(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.map((p) => {
    const { apiKey: _apiKey, authToken: _authToken, ...rest } = p;
    return rest as ProviderConfig;
  });
}

/** Whether a row carries a key or a token. */
function credentialled(p: ProviderConfig): boolean {
  return Boolean(p.apiKey || p.authToken);
}

/** The entry among `rows` that is the same provider entry as `p`. */
function sameEntryIn(rows: ProviderConfig[], p: ProviderConfig): ProviderConfig | undefined {
  return p.type === 'azure'
    ? rows.find((r) => r.type === 'azure' && sameAzureEntry(r, p))
    : rows.find((r) => r.type !== 'azure' && providerKey(r) === providerKey(p));
}

/**
 * Store the keys a project's providers carry, as a save does — where a save
 * used to write them into both the project's config and this file. The
 * machine-wide list follows this project's, as it did; and an entry that is
 * this project's own keeps up with it, or goes when its key is removed.
 */
export function saveProjectCredentials(globalDir: string, project: string, providers: ProviderConfig[]): () => void {
  let before: { shared: ProviderConfig[]; own: ProviderConfig[] } | undefined;
  updateCredentialsFile(globalDir, (file) => {
    before = { shared: file.providers, own: file.projects?.[project] ?? [] };
    const own = (file.projects?.[project] ?? []).flatMap((mine) => {
      const now = sameEntryIn(providers, mine);
      return now && credentialled(now) ? [{ ...now }] : [];
    });
    return withProject(file, project, own, providers.filter(isPersistable));
  });
  // Puts back what this save changed, for a caller whose other half — the
  // project's config — could not be written after it.
  return () => {
    if (before) updateCredentialsFile(globalDir, (file) => withProject(file, project, before!.own, before!.shared));
  };
}

/**
 * Take the keys out of a project's config into this file: each becomes the
 * project's own, and the machine-wide one too where there was none.
 */
export function adoptProjectCredentials(globalDir: string, project: string, providers: ProviderConfig[]): void {
  const withKeys = providers.filter(credentialled);
  if (withKeys.length === 0) return;
  updateCredentialsFile(globalDir, (file) => {
    const shared = [...file.providers];
    const own = [...(file.projects?.[project] ?? [])];
    for (const p of withKeys) {
      const mine = sameEntryIn(own, p);
      if (mine) Object.assign(mine, { ...p });
      else own.push({ ...p });
      const there = sameEntryIn(shared, p);
      if (!there) shared.push({ ...p });
      else if (!credentialled(there)) Object.assign(there, { ...p });
    }
    return withProject(file, project, own, shared);
  });
}

/** A project's own keys, under the name its state folder has now — after the project moved. */
export function renameProjectCredentials(globalDir: string, from: string, to: string): void {
  if (!readCredentialsFile(globalDir, true).projects?.[from]) return;
  updateCredentialsFile(globalDir, (file) => {
    const projects = { ...(file.projects ?? {}) };
    const own = projects[from];
    if (!own) return file;
    delete projects[from];
    projects[to] = own;
    return { ...file, projects };
  });
}

function withProject(file: CredentialsFile, project: string, own: ProviderConfig[], shared: ProviderConfig[]): CredentialsFile {
  const projects = { ...(file.projects ?? {}) };
  if (own.length) projects[project] = own;
  else delete projects[project];
  return { version: 1, providers: shared, ...(Object.keys(projects).length ? { projects } : {}) };
}

/**
 * Write the credential-bearing provider entries to the global file
 * (0600, directory 0700, atomic tmp+rename). The given list is authoritative:
 * ConfigManager merges the global file into its config at load time, so by
 * save time the config's providers are a superset of the global entries minus
 * anything the user explicitly removed — meaning removal sticks too.
 */
export function saveGlobalCredentials(globalDir: string, providers: ProviderConfig[]): void {
  updateCredentialsFile(globalDir, (file) => ({ ...file, providers: providers.filter(isPersistable) }));
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
 *   There is NO exception for Azure. An earlier version made one, reasoning
 *   that a matching deployment name pins its resource — but it does not: a
 *   deployment name is unique only WITHIN a resource, which is why `cascade
 *   link` refuses to reuse one across resources in the first place. So a
 *   workspace row `{ deploymentName: 'prod', apiKey: 'resource-B-key' }` took
 *   the endpoint off a stale global `prod` on resource A, and a resource-B key
 *   was addressed to resource A.
 *
 *   The safe case survives untouched, because it is the credentialless one: a
 *   row with no key and no endpoint still adopts BOTH atomically from the
 *   global row, which is what the store exists for. Only a row that already
 *   owns a resource-scoped credential is refused an endpoint inferred from a
 *   name.
 *
 * The rule covers `apiKey` exactly as it does `authToken`: the environment path
 * already treats `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` as a pair, and an
 * OpenAI-compatible key is endpoint-bound too. Non-Azure rows still match on
 * provider type alone, so this pairing is the only thing standing between two
 * hosts for one provider type.
 */
function fillFrom(existing: ProviderConfig, g: ProviderConfig): void {
  const credentialled = Boolean(existing.apiKey || existing.authToken);
  // Provider-aware, and evaluated even when one side omits the URL. Comparing
  // only when BOTH rows had a `baseUrl` treated a missing one as compatible
  // with anything — so a global `{ anthropic, apiKey }`, which is a PUBLIC-host
  // key, merged into a workspace row pointing at a corporate gateway and was
  // sent there. `credentialEndpointsConflict` resolves that omission to the
  // provider's default before comparing, while still reporting no conflict for
  // a type that genuinely has no default (an Azure row naming only its
  // deployment must still adopt endpoint and key together).
  const endpointsDiffer = credentialEndpointsConflict(existing.type, existing.baseUrl, g.baseUrl);

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
  if (!credentialled && !existing.baseUrl && g.baseUrl) existing.baseUrl = g.baseUrl;
  if (!existing.apiVersion && g.apiVersion) existing.apiVersion = g.apiVersion;
  if (!existing.label && g.label) existing.label = g.label;
}
