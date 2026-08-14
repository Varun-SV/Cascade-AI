// ─────────────────────────────────────────────
//  Cascade AI — Config Manager
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CascadeConfig, Identity } from '../types.js';
import { Keystore } from './keystore.js';
import { CascadeIgnore } from './ignore.js';
import { loadCascadeMd, type CascadeMdContent } from './cascade-md.js';
import { MemoryStore } from '../memory/store.js';
import { validateConfig } from './validate.js';
import { loadGlobalCredentials, mergeGlobalCredentials, saveGlobalCredentials } from './global-credentials.js';
import {
  describeCleanup,
  didCleanupChangeAnything,
  filterRetiredCredentials,
  RETIRED_PROVIDER_TYPES,
  stripRetiredProviders,
  type RetiredProviderCleanup,
} from './retired-providers.js';
import { disambiguateMcpServerNames, type McpServerRename } from '../tools/tool-name.js';
import {
  CASCADE_CONFIG_FILE,
  CASCADE_DB_FILE,
  GLOBAL_CONFIG_DIR,
  GLOBAL_KEYSTORE_FILE,
} from '../constants.js';

// Provider types the setup wizard treats as key-optional (local servers need
// no credential — see cli/setup/index.tsx's `keyOptional`/ollama handling). A
// provider list is "usable" if it has at least one entry that either doesn't
// need a key or already has one. Shared by both `cascade`/`cascade run` entry
// points (src/cli/index.ts) so they can't drift out of sync with what the
// setup wizard actually allows to be saved as a complete config.
const KEY_OPTIONAL_PROVIDER_TYPES = new Set(['ollama', 'openai-compatible']);
export function hasUsableProvider(
  providers: Array<{ type: string; apiKey?: string; authToken?: string }> | undefined,
): boolean {
  if (!providers?.length) return false;
  // `authToken` counts as a credential, not just `apiKey`. `cascade link`
  // stores an adopted Anthropic OAuth token there (cli/commands/link.ts) and
  // AnthropicProvider.isAvailable() runs on it happily — so ignoring it here
  // declared a working install unconfigured: `cascade run` aborted with "No
  // providers configured" and the desktop reopened the full-screen wizard.
  return providers.some((p) => KEY_OPTIONAL_PROVIDER_TYPES.has(p.type) || !!p.apiKey || !!p.authToken);
}

/**
 * Write a provider's API key, clearing any bearer token it replaces.
 *
 * `AnthropicProvider` reads `authToken` in preference to `apiKey` whenever both
 * are set, so a settings save that wrote only the key left the key the user had
 * just typed silently unused — and from the UI that is indistinguishable from
 * the save having failed. Every place a key is written from user input goes
 * through here, because this was got wrong independently in three of them.
 */
export function applyProviderApiKey(
  providers: Array<{ type: string; apiKey?: string; authToken?: string; baseUrl?: string }>,
  type: string,
  apiKey: string,
  extra: { baseUrl?: string } = {},
): void {
  const existing = providers.find((p) => p.type === type);
  if (existing) {
    existing.apiKey = apiKey;
    existing.authToken = undefined;
    if (extra.baseUrl) existing.baseUrl = extra.baseUrl;
    return;
  }
  providers.push({ type, apiKey, ...(extra.baseUrl ? { baseUrl: extra.baseUrl } : {}) });
}

export class ConfigManager {
  private config!: CascadeConfig;
  private keystore!: Keystore;
  private ignore!: CascadeIgnore;
  private store!: MemoryStore;
  private cascadeMd: CascadeMdContent | null = null;
  private workspacePath: string;
  private globalDir: string;
  /**
   * What THIS load migrated out, if anything. Strictly per-load state: reset
   * at the top of every `load()`, because two places read it as a statement
   * about the load in progress — `injectEnvKeys()` asks whether an empty
   * provider list was emptied by a retirement, and the end of `load()` warns
   * and builds the user-facing notice from it. Left set, a second `load()` on
   * the same instance (`startRepl()` does one after its setup wizard) would
   * re-announce a migration that already happened and suppress the Ollama
   * fallback for a list that is empty for some unrelated reason.
   */
  private retiredCleanup?: RetiredProviderCleanup;
  /**
   * Human-readable migration notice held for a UI to display. `console.warn`
   * is not sufficient: the REPL clears the TTY immediately after load(), and
   * the desktop emits from the main process where nothing is rendered.
   */
  private pendingRetiredNotice?: string;

  /** Returns the pending migration notice once, then forgets it. */
  takeRetiredNotice(): string | undefined {
    const n = this.pendingRetiredNotice;
    this.pendingRetiredNotice = undefined;
    return n;
  }

  /** `globalDirOverride` exists for tests — never point it at the real home dir there. */
  constructor(workspacePath = process.cwd(), globalDirOverride?: string) {
    this.workspacePath = workspacePath;
    this.globalDir = globalDirOverride ?? path.join(os.homedir(), GLOBAL_CONFIG_DIR);
  }

  async load(): Promise<void> {
    // Note: loadConfig() resets `retiredCleanup` on entry, so everything below
    // reads this load's result and never a previous one's.
    this.config = await this.loadConfig();
    // Desktop and CLI share this one config file, and only the desktop's OAuth
    // connect flow ever checked for a colliding sanitized tool prefix —
    // `cascade mcp connect` did not, and a file that already contains a
    // colliding pair (hand-edited, imported, or written before that check
    // existed) stays broken until something fixes the names. Run on every
    // load rather than gating on a migration flag: disambiguateMcpServerNames
    // is a no-op when nothing collides, so the cost of checking is one pass
    // over a short list, and it also catches a collision introduced by an
    // import or a hand edit between two loads, not only a fresh install.
    const servers = this.config.tools?.mcpServers;
    const { servers: disambiguated, renames } = servers?.length
      ? disambiguateMcpServerNames(servers)
      : { servers, renames: [] as McpServerRename[] };
    const mcpNamesChanged = renames.length > 0;
    if (mcpNamesChanged && this.config.tools) {
      this.config.tools.mcpServers = disambiguated;
      // The server's OLD name is still referenced elsewhere in config — as an
      // exact match in `mcpTrusted` (McpClient.connect() checks it verbatim,
      // so a stale entry means the renamed server is no longer trusted and
      // either re-prompts interactively or is rejected outright in a headless
      // run) and as a prefix in `disabledTools`. Both have to follow the
      // rename or the migration trades one bug for another.
      this.renameMcpServerReferences(renames);
    }
    this.ignore = new CascadeIgnore();
    await this.ignore.load(this.workspacePath);
    this.cascadeMd = await loadCascadeMd(this.workspacePath);
    this.keystore = new Keystore(path.join(this.globalDir, GLOBAL_KEYSTORE_FILE));
    this.store = new MemoryStore(path.join(this.workspacePath, CASCADE_DB_FILE));
    // Fill in machine-global credentials (~/.cascade-ai/credentials.json) so
    // keys entered once are available in EVERY workspace — previously keys
    // lived only in the workspace config, so pointing the desktop app (or CLI)
    // at a different folder silently "forgot" them all. A workspace entry that
    // carries its own key still wins (per-project override).
    //
    // Filter the global store as well as the workspace file. This merge runs
    // AFTER validation and never passes through the schema, so a retired entry
    // in ~/.cascade-ai/credentials.json would otherwise be reinstated in
    // memory moments after being cleaned off disk — and would come back on
    // every load, in every workspace.
    const globalCreds = filterRetiredCredentials(loadGlobalCredentials(this.globalDir));
    if (globalCreds.removed.length > 0) {
      // Best-effort, like save()'s own global-store sync: an unwritable home
      // must not abort startup when the in-memory list is already clean.
      try {
        saveGlobalCredentials(this.globalDir, globalCreds.kept);
      } catch (err) {
        console.warn(`Could not rewrite the global credential store: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.retiredCleanup = {
        removed: [...new Set([...(this.retiredCleanup?.removed ?? []), ...globalCreds.removed])],
        clearedPins: this.retiredCleanup?.clearedPins ?? [],
      };
    }
    await this.injectEnvKeys();
    this.config.providers = mergeGlobalCredentials(this.config.providers, globalCreds.kept);

    // Purge AFTER both stores have been cleaned, not at store construction:
    // a retired provider that existed ONLY in ~/.cascade-ai/credentials.json
    // is not known until the filter above runs, and purging earlier would skip
    // exactly that case. The model cache outlives the provider, and the REPL's
    // loadCache() only re-discovers when the cache is EMPTY or >24h old — so
    // leftover rows read as "populated" and the providers that replaced it
    // show zero models until they age out.
    // Unconditional over every KNOWN retired type, not just the ones this load
    // happened to migrate. Someone who deleted the provider from their config
    // before upgrading has no migration to trigger on, yet their cache still
    // holds the rows — and the REPL reads any non-empty, non-stale cache as
    // authoritative, so the providers they DO have show zero models until the
    // 24-hour expiry. A delete of rows that are not there costs one no-op
    // statement per retired type.
    for (const type of Object.keys(RETIRED_PROVIDER_TYPES)) {
      try { this.store.purgeCachedModelsForRetiredProvider(type); } catch { /* the cache is disposable */ }
    }

    await this.ensureDefaultIdentity();
    // Persist the rename so it sticks — otherwise the fix applies for this
    // process only and the file on disk (and the next process to read it)
    // still has the collision.
    //
    // The retired-provider migration is deliberately NOT saved here: it was
    // already written from the raw file inside loadConfig(), before this
    // config was enriched with env and machine-global credentials. Saving it
    // here would push those secrets into the workspace file (see loadConfig).
    if (mcpNamesChanged) await this.save();
    if (this.retiredCleanup) {
      // console.warn alone is not enough — startRepl() clears the TTY right
      // after load() returns, and the desktop main process has no UI at all.
      // Keep the notice so each surface can show it once it has somewhere to
      // draw; the log line stays for headless runs.
      console.warn(describeCleanup(this.retiredCleanup));
      this.pendingRetiredNotice = describeCleanup(this.retiredCleanup);
    }
  }

  getConfig(): CascadeConfig {
    return this.config;
  }

  getKeystore(): Keystore {
    return this.keystore;
  }

  getIgnore(): CascadeIgnore {
    return this.ignore;
  }

  getStore(): MemoryStore {
    return this.store;
  }

  getCascadeMd(): CascadeMdContent | null {
    return this.cascadeMd;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async save(): Promise<void> {
    const configPath = path.join(this.workspacePath, CASCADE_CONFIG_FILE);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    // Sync credential-bearing provider entries to the global store so they
    // survive workspace switches. Best-effort: a read-only home dir must not
    // fail the workspace save.
    try {
      saveGlobalCredentials(this.globalDir, this.config.providers);
    } catch (err) {
      console.warn(`Failed to sync credentials to global store: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async updateConfig(updates: Partial<CascadeConfig>): Promise<void> {
    this.config = validateConfig({ ...this.config, ...updates });
    await this.save();
  }

  getApiKey(provider: string): string | undefined {
    const envMap: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GOOGLE_API_KEY',
      azure: 'AZURE_OPENAI_KEY',
      // Deliberately NOT `GITHUB_TOKEN`: that one is injected automatically by
      // GitHub Actions and is commonly exported in developer shells for `gh`
      // and git auth, and it will essentially never carry the fine-grained
      // `models: read` scope this provider needs. Adopting it would wire up a
      // provider that 403s on its first real call — a confusing failure for
      // something that is meant to be explicit opt-in BYOK.
    };
    const envKey = envMap[provider];
    if (envKey && process.env[envKey]) return process.env[envKey];
    if (this.keystore.isUnlocked()) {
      const key = this.keystore.get(`provider:${provider}`);
      if (key) return key;
    }
    const configProvider = this.config.providers.find(p => p.type === provider);
    return configProvider?.apiKey;
  }

  /**
   * The bearer token configured for a provider, if any.
   *
   * Companion to getApiKey(). A provider can be fully configured with only
   * this — `cascade link` and ANTHROPIC_AUTH_TOKEN both produce it — so any
   * surface that asks "is this provider set up" has to consult both, or it
   * reports a working install as unconfigured.
   */
  getAuthToken(provider: string): string | undefined {
    if (provider === 'anthropic' && process.env['ANTHROPIC_AUTH_TOKEN']) {
      return process.env['ANTHROPIC_AUTH_TOKEN'];
    }
    return this.config.providers.find((p) => p.type === provider)?.authToken;
  }

  private async loadConfig(): Promise<CascadeConfig> {
    // Reset on entry, not after the notice is built at the end of load(), so
    // the flag cannot outlive the load that set it even if that load throws
    // part way through. It lives here rather than in load() because this is
    // its only other writer — and because assigning `undefined` in load()
    // narrows the property to `never` for the reads further down it.
    this.retiredCleanup = undefined;
    const configPath = path.join(this.workspacePath, CASCADE_CONFIG_FILE);
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      // BEFORE validateConfig, not after: the schema no longer accepts a
      // retired provider type, so validating first turns an upgrade into a
      // hard CascadeConfigError with no path to repair (see
      // retired-providers.ts). Stripping first lets the file load, and
      // `retiredCleanup` tells load() to persist the cleaned version so the
      // next process does not repeat the work.
      const cleanup = stripRetiredProviders(parsed);
      if (didCleanupChangeAnything(cleanup)) {
        this.retiredCleanup = cleanup;
        // Persist HERE, from the raw parsed file, not via save() at the end of
        // load(). By then `this.config` has been enriched by injectEnvKeys()
        // and mergeGlobalCredentials(), and save() serializes the whole object
        // — so writing there would copy environment keys and machine-global
        // credentials (kept 0600 in ~/.cascade-ai) into a workspace file that
        // may be 0644, for projects that never had them. The migration must
        // not be a credential-exfiltration path.
        //
        // Best-effort: a read-only config directory (a container mount, a
        // locked-down home) must not abort load(). The in-memory config is
        // already clean and the run can proceed; we simply migrate again next
        // launch. Matches how save() already treats an unwritable global store.
        try {
          await fs.writeFile(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
        } catch (err) {
          console.warn(`Could not persist the retired-provider migration: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return validateConfig(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return validateConfig({});
      }
      throw err;
    }
  }

  private async injectEnvKeys(): Promise<void> {
    // Two different questions, previously conflated into one `isFirstRun`.
    //
    // "Is the list empty?" governs whether an environment key may seed a new
    // provider entry — and that must stay true after a retirement, or a user
    // whose only provider was retired but who has OPENAI_API_KEY exported ends
    // up with NOTHING and a "No providers configured" exit, holding a perfectly
    // usable credential.
    //
    // "Is this a genuine fresh install?" governs the keyless Ollama fallback
    // only. After a retirement an empty list means "we just took your provider
    // away", and appending Ollama there is actively harmful: hasUsableProvider()
    // accepts it without checking the daemon exists, so both the setup wizard
    // and the headless no-providers guard are skipped and the run reaches the
    // router with no usable model.
    // Both halves of the retirement cleanup — the workspace file (loadConfig)
    // and the global credential store (filtered just above) — are accumulated
    // into `retiredCleanup` BEFORE this runs. That ordering is load-bearing:
    // when the retired provider lived only in ~/.cascade-ai, computing this
    // any earlier saw an unset flag, called it a fresh install, and appended
    // the keyless Ollama entry this branch exists to prevent.
    const wasEmpty = this.config.providers.length === 0;
    const emptiedByRetirement = wasEmpty && !!this.retiredCleanup;

    const envProviders: Array<{ env: string; type: CascadeConfig['providers'][0]['type'] }> = [
      { env: 'ANTHROPIC_API_KEY', type: 'anthropic' },
      { env: 'OPENAI_API_KEY', type: 'openai' },
      { env: 'GOOGLE_API_KEY', type: 'gemini' },
      { env: 'AZURE_OPENAI_KEY', type: 'azure' },
    ];

    for (const { env, type } of envProviders) {
      const key = process.env[env];
      if (!key) continue;
      const existing = this.config.providers.find((p) => p.type === type);

      if (!existing && wasEmpty) {
        // Azure cannot be configured by a key alone. Without a deployment name
        // it resolves to no model at all (azureModelForDeployment returns
        // null), and without an endpoint the client falls back to a literal
        // `YOUR_RESOURCE` placeholder URL. Creating the entry regardless made
        // hasUsableProvider() true, so onboarding was skipped and the run
        // failed later with "No model available for tier" — exactly the
        // misdirection this area keeps producing. Filling the key into a
        // deployment the user HAS configured is the branch below, unaffected.
        if (type === 'azure') {
          const endpoint = process.env['AZURE_OPENAI_ENDPOINT'];
          const deploymentName = process.env['AZURE_OPENAI_DEPLOYMENT']
            ?? process.env['AZURE_OPENAI_DEPLOYMENT_NAME'];
          if (!endpoint || !deploymentName) continue;
          const apiVersion = process.env['AZURE_OPENAI_API_VERSION'];
          this.config.providers.push({
            type, apiKey: key, baseUrl: endpoint, deploymentName,
            ...(apiVersion ? { apiVersion } : {}),
          });
          continue;
        }
        this.config.providers.push({ type, apiKey: key });
      } else if (existing && !existing.apiKey) {
        existing.apiKey = key;
      }
    }

    // ANTHROPIC_AUTH_TOKEN is a bearer credential, not an API key — Anthropic
    // documents it for routing through an LLM gateway or proxy, where the
    // gateway issues the token and `baseUrl` points at it. It was the one
    // documented Anthropic credential no environment path picked up, so a user
    // following Anthropic's own instructions got "no providers configured".
    const authToken = process.env['ANTHROPIC_AUTH_TOKEN'];
    if (authToken) {
      const existing = this.config.providers.find((p) => p.type === 'anthropic');
      // A bearer is valid only at the gateway that issued it, so it is never
      // configured without one — otherwise the client defaults to
      // api.anthropic.com and sends the token to a host that should not see it,
      // while hasUsableProvider() accepts the entry and skips onboarding. Same
      // requirement credential discovery applies; it was missing here, which is
      // the same gap Azure had one layer down.
      const gateway = process.env['ANTHROPIC_BASE_URL'] ?? existing?.baseUrl;
      if (gateway) {
        if (!existing && wasEmpty) {
          this.config.providers.push({ type: 'anthropic', authToken, baseUrl: gateway });
        } else if (existing && !existing.apiKey && !existing.authToken) {
          existing.authToken = authToken;
          existing.baseUrl ??= gateway;
        }
      }
    }

    if (wasEmpty && !emptiedByRetirement && !this.config.providers.find((p) => p.type === 'ollama')) {
      this.config.providers.push({ type: 'ollama' });
    }
  }

  /**
   * Follow a disambiguation rename into `tools.mcpTrusted`.
   *
   * `mcpTrusted` is matched by EXACT name (`McpClient.connect()`). Two shapes
   * of rename reach here, and they need OPPOSITE treatment:
   *
   * - Distinct raw names that only collide via sanitizing (`foo bar` /
   *   `foo@bar`): each had its OWN trust entry, and the old string now belongs
   *   to nothing — the server that used it moved away, so the entry has to
   *   move with it. A plain rewrite is correct here.
   * - Literally identical names (a hand-edited or duplicated config: two rows
   *   both named `foo`): there is only ONE trust entry for both, since
   *   `mcpTrusted` itself is deduplicated. `this.config.tools.mcpServers` has
   *   already been updated to the disambiguated list by the time this runs
   *   (see `load()`), so the untouched survivor is STILL named `foo` — a plain
   *   rewrite would move the one entry entirely onto the renamed row and
   *   leave the survivor untrusted. The entry must be kept for the survivor
   *   AND granted to the renamed identity, not moved.
   *
   * Renames are grouped by `from` before either treatment is applied, and
   * each group is settled in one step. Two DIFFERENT rows can start out with
   * the exact same raw name and BOTH get renamed away (e.g. three servers
   * named `foo bar`, `foo@bar`, `foo@bar` — the two `foo@bar` rows collide
   * with `foo bar` and with each other, so both are renamed to distinct
   * identities while `foo bar` survives untouched). Processing renames one at
   * a time in that shape drops coverage: the first rename's REPLACE branch
   * would erase `from` from `trusted` entirely, so the guard on the second
   * rename with the same `from` sees it already gone and silently skips —
   * granting trust to only one of the two renamed identities. Grouping first
   * means every renamed identity that shares a `from` is added or substituted
   * together, in the one pass that still sees the original entry.
   *
   * `tools.disabledTools` deliberately gets no equivalent treatment. It's
   * matched by sanitized PREFIX, and a prefix collision is exactly what made
   * an existing entry ambiguous between the two servers in the first place —
   * there is no way to tell, from the stored string alone, which of the two
   * a denial was meant for. Leaving those entries untouched resolves that
   * ambiguity for free: the survivor keeps the original (now unique) prefix,
   * so an old entry keeps applying to it, while the renamed server starts
   * clean under its new prefix. Rewriting the entry to follow the rename
   * would do the opposite — move a denial that already worked for the
   * survivor onto a server it may never have meant to cover.
   */
  private renameMcpServerReferences(renames: McpServerRename[]): void {
    const tools = this.config.tools;
    if (!tools?.mcpTrusted?.length || !renames.length) return;
    const currentNames = new Set((tools.mcpServers ?? []).map((s) => s.name));

    const byFrom = new Map<string, string[]>();
    for (const { from, to } of renames) {
      const tos = byFrom.get(from);
      if (tos) tos.push(to);
      else byFrom.set(from, [to]);
    }

    let trusted = tools.mcpTrusted;
    for (const [from, tos] of byFrom) {
      if (!trusted.includes(from)) continue;
      trusted = currentNames.has(from)
        ? [...trusted, ...tos] // a survivor still holds `from` — ADD every renamed identity
        : [...trusted.filter((n) => n !== from), ...tos]; // `from` is now unused — replace with ALL renamed identities
    }
    tools.mcpTrusted = Array.from(new Set(trusted));
  }

  private async ensureDefaultIdentity(): Promise<void> {
    const existing = this.store.getDefaultIdentity();
    if (existing) return;
    const identity: Identity = {
      id: randomUUID(),
      name: 'Default',
      description: 'Default Cascade identity',
      createdAt: new Date().toISOString(),
      isDefault: true,
    };
    this.store.createIdentity(identity);
    this.config.defaultIdentityId = identity.id;
  }
}
