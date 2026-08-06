import type { ProviderConfig } from './types.js';

/**
 * Provider types the app used to offer and no longer does.
 *
 * Narrowing `ProviderType` only changes what TypeScript accepts at build time.
 * It does nothing to the values already sitting in a user's browser: the key
 * vault is persisted as raw JSON in localStorage and read back with no runtime
 * validation, so an entry saved before the removal survives the upgrade intact
 * and is still sent verbatim on every `chat:run`. The SERVER's Zod enum then
 * rejects the whole payload — so a user who once selected a now-retired
 * provider cannot chat at all until they happen to open the key vault and
 * delete the row by hand.
 *
 * Account sync makes it worse: a restore merges the decrypted provider array
 * straight into local state, so even a cleaned vault gets the dead entry back
 * from a bundle uploaded before the upgrade.
 *
 * Mirrors src/config/retired-providers.ts. Deliberately duplicated rather than
 * imported: cloud/web is a separate Vite app that keeps its own copy of
 * `ProviderType` (lib/types.ts) and does not depend on the SDK bundle.
 */
export const RETIRED_PROVIDER_TYPES: Readonly<Record<string, string>> = {
  'github-models': 'GitHub Models was retired by GitHub on 30 July 2026',
};

export function isRetiredProviderType(type: unknown): boolean {
  return typeof type === 'string' && Object.hasOwn(RETIRED_PROVIDER_TYPES, type);
}

/**
 * Drops retired entries from a provider list, reporting which types went.
 *
 * Takes `unknown[]` because both call sites handle values that never passed
 * through a validator — localStorage JSON and a decrypted sync bundle.
 */
export function stripRetiredProviders(providers: unknown[]): {
  kept: ProviderConfig[];
  removed: string[];
} {
  const removed: string[] = [];
  const kept: ProviderConfig[] = [];
  for (const p of providers) {
    const type = (p as { type?: unknown } | null)?.type;
    if (isRetiredProviderType(type)) {
      if (!removed.includes(type as string)) removed.push(type as string);
      continue;
    }
    // Anything without a string `type` was never a usable provider entry —
    // hand-edited localStorage, a truncated write, a null from an older
    // schema. Drop it rather than passing it through: every consumer reads
    // `.type`, so a null here becomes a TypeError somewhere less obvious.
    // Not reported in `removed`, which is reserved for retirements the user
    // needs an explanation for; junk needs no notice.
    if (typeof type !== 'string') continue;
    kept.push(p as ProviderConfig);
  }
  return { kept, removed };
}

/** User-facing sentence for a one-time notice. */
export function describeRetiredRemoval(removed: string[]): string {
  const reasons = removed.map((t) => RETIRED_PROVIDER_TYPES[t] ?? t).join('; ');
  const noun = removed.length === 1 ? 'a saved provider' : 'saved providers';
  return `Removed ${noun} from your key vault: ${reasons}. Anything with an OpenAI-compatible endpoint still works — add it as "OpenAI-Compatible".`;
}
