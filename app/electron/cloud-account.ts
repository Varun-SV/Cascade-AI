// The account a cloud request was meant for, checked in the main process just
// before the request goes out. The renderer copies a run to the account the
// run ended under; if another account has signed in since (even while an
// earlier request of the same copy was in flight), the request must not go
// out under the new account's session.

/** The account a request is meant for: a user on a given server. */
export interface ExpectedAccount { userId: string; serverUrl: string }

/**
 * True when a request meant for `expected` must not go out under the session
 * signed in now (`signedInUserId` on `serverUrl`; undefined when signed out).
 * A caller that names no account (the chat views) is not checked; one that
 * names an account it cannot describe properly is refused.
 */
export function accountMismatch(expected: unknown, signedInUserId: string | undefined, serverUrl: string): boolean {
  if (expected === undefined || expected === null) return false;
  if (typeof expected !== 'object') return true;
  const e = expected as Record<string, unknown>;
  if (typeof e['userId'] !== 'string' || typeof e['serverUrl'] !== 'string') return true;
  return !signedInUserId || e['userId'] !== signedInUserId || e['serverUrl'] !== serverUrl;
}

/** What a refused request answers, so the renderer can tell it from a failure. */
export const ACCOUNT_CHANGED = { ok: false as const, accountChanged: true as const, error: 'Signed in to another account.' };

/**
 * True for the error `CloudClient` throws when the sign-in changed while a
 * refresh was out (matched by its code: the core bundle is loaded separately).
 */
export function isAccountChangedError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'CLOUD_ACCOUNT_CHANGED';
}

/**
 * Thrown just before a run-mirror request would go out while syncing is off
 * now: nothing of that request is sent. Matched by its code, like the
 * client's account error.
 */
export class SyncOffError extends Error {
  readonly code = 'CLOUD_SYNC_OFF';
  constructor() { super('Cloud sync is off.'); this.name = 'SyncOffError'; }
}

/** True for the error `sendGate` throws. */
export function isSyncOffError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'CLOUD_SYNC_OFF';
}

/**
 * A client's `beforeSend` for the run mirror: checked right before each
 * request leaves (after a token refresh, and before a retry after a 401), so
 * an opt-out kept while a request waits stops it there.
 */
export function sendGate(allowed: () => boolean): () => void {
  return () => {
    let ok = false;
    try { ok = allowed() === true; } catch { ok = false; }
    if (!ok) throw new SyncOffError();
  };
}

type SessionLike = { user: { id: string }; refreshToken?: string; serverUrl?: string };

/** A session store, as `CloudClient` reads and writes it. */
export interface SessionStoreLike<S extends SessionLike> {
  load(): S | null;
  save(session: S): void;
  clear(): void;
  replace?(prev: S, next: S): boolean;
}

/**
 * The shared session store, seen only as `userId`'s: while another account is
 * signed in it reads as signed out, and a refresh neither saves over nor
 * clears that account's sign-in. A client built on it can therefore never
 * send a request, or retry one after refreshing on a 401, under anyone else.
 */
export function pinnedStore<S extends SessionLike>(store: SessionStoreLike<S>, userId: string): SessionStoreLike<S> {
  const mine = (): S | null => { const s = store.load(); return s && s.user?.id === userId ? s : null; };
  return {
    load: mine,
    save: (session) => { if (session.user?.id === userId && mine()) store.save(session); },
    clear: () => { if (mine()) store.clear(); },
    // A refresh's rotated tokens replace only the very session it started
    // from (same refresh token and server), never a newer sign-in of the
    // same account.
    replace: (prev, next) => {
      const now = mine();
      if (!now || next.user?.id !== userId || prev.user?.id !== userId) return false;
      if (now.refreshToken !== prev.refreshToken || now.serverUrl !== prev.serverUrl) return false;
      store.save(next);
      return true;
    },
  };
}
