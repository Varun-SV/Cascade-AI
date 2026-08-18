import type { ProviderConfig } from '../lib/types.js';
import { describeRetiredRemoval, stripRetiredProviders } from '../lib/retired-providers.js';
import { describeRevokedRemoval, stripRevokedCredentials, webUnusableReason, withoutBearer } from '../lib/revoked-credentials.js';

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
 * Every credential migration runs here rather than anywhere downstream: this is
 * the single point every consumer reads through, and the stored value predates
 * any schema, so an entry saved by an older build is otherwise carried straight
 * into a `chat:run` payload. Three of them apply — retired provider types,
 * revoked Claude subscription tokens, and rows whose only credential is a
 * bearer the browser has no way to send. Locally-addressed endpoints are NOT
 * migrated away here (see the loop below): the restore path refuses to
 * introduce one, but a user may have typed it themselves.
 *
 * The account pull applies the same rules, but only to what it pulls. Before
 * 0.75 the browser merge stored incoming rows verbatim, so a desktop bundle
 * could already have put such a credential in localStorage — and cleaning only
 * on the next pull left it being sent in every run until the user happened to
 * sync again. The cleaned list is written back immediately so it happens once.
 */
export function loadKeys(): ProviderConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const { kept: live, removed } = stripRetiredProviders(parsed);

    // The same migration the account pull applies, run over what is ALREADY in
    // the vault. Before 0.75 the browser merge stored incoming rows verbatim,
    // so a desktop bundle could put a subscription token — or a bearer-only
    // Anthropic row — straight into `cascade-cloud-keys`. Cleaning only on the
    // next pull left that credential being sent in every `chat:run` until the
    // user happened to sync again, which many never will.
    const { kept: notRevoked, removed: revoked } = stripRevokedCredentials(live);
    const kept: ProviderConfig[] = [];
    let unusable = 0;
    let strippedBearer = false;
    for (const row of notRevoked) {
      // ONLY the credential cases. A `local-endpoint` row is dropped on RESTORE,
      // where it arrives from a desktop bundle and the user never asked for it
      // here — but not on load: KeyVault does not validate the URL field, so a
      // user can and does type `http://localhost:8000/v1` into it themselves,
      // and deleting that on the next page load is data loss dressed up as a
      // migration. It fails server-side, visibly, which is the user's own
      // entry failing rather than Cascade quietly discarding it.
      if (webUnusableReason(row) === 'bearer-only') { unusable++; continue; }
      // A bearer on an otherwise-usable row goes too: the web never sends it,
      // and keeping it lets a later push hand it back to a native client that
      // prefers it over the key.
      if ((row as { authToken?: unknown }).authToken !== undefined) strippedBearer = true;
      kept.push(withoutBearer(row));
    }

    const notices = [
      removed.length > 0 ? describeRetiredRemoval(removed) : '',
      revoked > 0 ? describeRevokedRemoval() : '',
      unusable > 0
        ? `${unusable} stored gateway token${unusable === 1 ? '' : 's'} could not be used from the browser and `
          + `${unusable === 1 ? 'was' : 'were'} removed — a gateway token still works in the desktop app or CLI.`
        : '',
    ].filter(Boolean);

    // `strippedBearer` is part of the condition, not just the notices: a row can
    // be kept and still have changed, and without persisting that the token is
    // re-read from localStorage on the next load and pushed on the next sync.
    if (notices.length > 0 || kept.length !== parsed.length || strippedBearer) {
      retiredNotice = notices.join(' ') || null;
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
