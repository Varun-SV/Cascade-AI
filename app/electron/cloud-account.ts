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
