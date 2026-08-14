// ─────────────────────────────────────────────
//  Cascade AI — Retired Provider Migration
// ─────────────────────────────────────────────
//
//  Removing a provider type from `ProviderType` narrows the config schema, and
//  a narrowed schema REJECTS a file that was perfectly valid one version ago.
//  `ConfigManager.loadConfig()` hands the parsed file straight to
//  `validateConfig()`, which throws `CascadeConfigError` — so without this
//  module, upgrading with a retired provider still in `.cascade/config.json`
//  does not degrade, it stops the CLI at startup, and the desktop app reports
//  "Could not load Cascade config" with no way to repair it from Settings
//  (the config manager it would repair through never finishes constructing).
//
//  So retirement has to be a MIGRATION, not just a type change: strip the dead
//  entries from the raw object BEFORE validation, and again from the global
//  credentials store, which is merged in afterwards and would otherwise put
//  the entry straight back.

/**
 * Provider types Cascade used to support and no longer does, with the reason
 * shown to the user. Keyed by the exact string that appeared in `providers[].type`.
 */
export const RETIRED_PROVIDER_TYPES: Readonly<Record<string, string>> = {
  'github-models': 'GitHub retired GitHub Models on 30 July 2026; models.github.ai no longer responds.',
};

export function isRetiredProviderType(type: unknown): type is string {
  return typeof type === 'string' && Object.hasOwn(RETIRED_PROVIDER_TYPES, type);
}

export interface RetiredProviderCleanup {
  /** Retired `providers[]` types that were dropped, in first-seen order. */
  removed: string[];
  /** Tier keys (`t1`/`t2`/`t3`) whose pin named a retired provider and was cleared. */
  clearedPins: string[];
  /**
   * Dead Claude subscription credentials dropped from an incoming sync bundle.
   *
   * Reported here rather than left to `removed`, which names retired provider
   * TYPES — `anthropic` is not retired, its credential is. Without this a
   * bundle whose only content was the dead token produced an empty cleanup, so
   * both callers announced a clean sync while the one key it carried had been
   * discarded.
   */
  revokedCredentials?: number;
}

/** True when anything was actually removed — the signal to persist and warn. */
export function didCleanupChangeAnything(c: RetiredProviderCleanup): boolean {
  return c.removed.length > 0 || c.clearedPins.length > 0 || (c.revokedCredentials ?? 0) > 0;
}

/**
 * Strips retired providers from a RAW, not-yet-validated config object,
 * mutating it in place and reporting what it touched.
 *
 * Deliberately operates on `unknown` rather than `CascadeConfig`: by the time
 * a value is a `CascadeConfig` it has already been through the Zod schema that
 * rejects these entries, so a typed signature would describe a state that can
 * never occur. Anything unexpected is left alone — this runs before
 * validation, so a malformed file must still reach `validateConfig()` and get
 * that function's real error message rather than a confusing one from here.
 */
export function stripRetiredProviders(raw: unknown): RetiredProviderCleanup {
  const cleanup: RetiredProviderCleanup = { removed: [], clearedPins: [] };
  if (typeof raw !== 'object' || raw === null) return cleanup;
  const cfg = raw as Record<string, unknown>;

  if (Array.isArray(cfg['providers'])) {
    const kept = (cfg['providers'] as unknown[]).filter((p) => {
      const type = (p as { type?: unknown } | null)?.type;
      if (!isRetiredProviderType(type)) return true;
      if (!cleanup.removed.includes(type)) cleanup.removed.push(type);
      return false;
    });
    cfg['providers'] = kept;
  }

  cleanup.clearedPins = clearRetiredPins(cfg['models']);

  return cleanup;
}

/**
 * Clears `provider:model` tier pins naming a retired provider, mutating the
 * given models object in place and returning the tier keys it cleared.
 *
 * Split out from `stripRetiredProviders` because the sync merge has to ask the
 * question a second time, about a DIFFERENT object: stripping the incoming
 * bundle says nothing about what the merged result ends up pinned to (see
 * `applySyncBundle`). Takes `unknown` for the same reason its caller does —
 * it runs on raw, not-yet-validated data.
 */
export function clearRetiredPins(models: unknown): string[] {
  // A tier pin outlives the provider entry and is stored as a plain
  // `provider:model` string, so it survives a `providers[]` filter untouched.
  // Left in place it resolves to nothing and fails the run with "provider ...
  // is not available" on every single request — the pin has to go too, and
  // clearing it returns that tier to Auto, which is the working default.
  const cleared: string[] = [];
  if (typeof models !== 'object' || models === null) return cleared;
  const tiers = models as Record<string, unknown>;
  for (const tier of ['t1', 't2', 't3'] as const) {
    const pin = tiers[tier];
    if (typeof pin !== 'string') continue;
    // Lowercased to match how the pin is actually parsed: selector.ts's
    // resolveDynamicModel() does `parts[0].toLowerCase()`, so a hand-written
    // `GitHub-Models:openai/gpt-4o` was a VALID pin. Comparing the raw case
    // here would leave exactly those pins behind after their provider is
    // gone — and a leftover pin is worse than none, because the router then
    // either rejects it or misreads the literal id as another provider's.
    const prefix = pin.slice(0, pin.indexOf(':')).toLowerCase();
    if (pin.includes(':') && isRetiredProviderType(prefix)) {
      delete tiers[tier];
      cleared.push(tier);
    }
  }
  return cleared;
}

/**
 * Drops retired entries from a global-credentials provider list.
 *
 * Separate from `stripRetiredProviders` because the credentials file is merged
 * in AFTER workspace validation (see ConfigManager.load) and never goes
 * through the schema at all — `loadGlobalCredentials` admits any object with a
 * string `type`. Cleaning only the workspace file would therefore fix nothing
 * for anyone whose key was stored machine-globally: the entry would be gone
 * from disk and back in memory a few lines later.
 */
export function filterRetiredCredentials<T extends { type: string }>(providers: T[]): {
  kept: T[];
  removed: string[];
} {
  const removed: string[] = [];
  const kept = providers.filter((p) => {
    if (!isRetiredProviderType(p.type)) return true;
    if (!removed.includes(p.type)) removed.push(p.type);
    return false;
  });
  return { kept, removed };
}

/** One-line, user-facing explanation of what was migrated and why. */
export function describeCleanup(c: RetiredProviderCleanup): string {
  const parts: string[] = [];
  for (const type of c.removed) {
    parts.push(`removed the retired "${type}" provider (${RETIRED_PROVIDER_TYPES[type]})`);
  }
  if ((c.revokedCredentials ?? 0) > 0) {
    parts.push('discarded a linked Claude subscription token, which Anthropic no longer permits third-party tools to use');
  }
  if (c.clearedPins.length > 0) {
    parts.push(`reset ${c.clearedPins.map((t) => t.toUpperCase()).join('/')} to Auto, since the pin named it`);
  }
  return `Cascade config migration: ${parts.join('; ')}.`;
}
