import type { ProviderConfig } from '../lib/types.js';
import { describeRetiredRemoval, stripRetiredProviders } from '../lib/retired-providers.js';

const STORAGE_KEY = 'cascade-cloud-keys';

/**
 * Set by loadKeys() when it drops a retired provider, read once by the app
 * shell. A module-level slot rather than a return value because loadKeys() is
 * called from a `useState` initializer, which cannot also set another piece of
 * state — and the user has to be TOLD their vault changed, or a key silently
 * disappearing looks like data loss.
 */
let retiredNotice: string | null = null;

/** Returns the pending retired-provider notice exactly once, then forgets it. */
export function takeRetiredProviderNotice(): string | null {
  const n = retiredNotice;
  retiredNotice = null;
  return n;
}

/**
 * Keys never leave the browser except as part of a chat:run payload — this
 * is the ONLY place they are persisted. See KeyVault.tsx for the same
 * promise surfaced in the UI copy.
 *
 * Retired provider types are stripped here rather than anywhere downstream:
 * this is the single point every consumer reads through, and the stored value
 * predates any schema, so an entry saved by an older build is otherwise
 * carried straight into a `chat:run` payload the server now rejects outright.
 * The cleaned list is written back immediately so the migration happens once.
 */
export function loadKeys(): ProviderConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const { kept, removed } = stripRetiredProviders(parsed);
    if (removed.length > 0) {
      retiredNotice = describeRetiredRemoval(removed);
      // Best-effort. localStorage can refuse a write (quota, a security policy,
      // Safari private mode) and letting that throw would fall to the catch
      // below and return [] — discarding every provider that had just parsed
      // cleanly, so the user cannot chat at all. The migration is a
      // convenience; the keys are the point. Worst case it runs again next
      // load.
      try { saveKeys(kept); } catch { /* re-migrate next load */ }
    }
    return kept;
  } catch {
    return [];
  }
}

export function saveKeys(keys: ProviderConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}
