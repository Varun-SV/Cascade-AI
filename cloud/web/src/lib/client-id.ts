/**
 * This tab's resume identity.
 *
 * The server hands a dropped connection's runs to whoever reconnects with the
 * same identity, so two live tabs must never answer to one id. `sessionStorage`
 * does not give that on its own: the HTML session storage model *copies* a page
 * session into a newly created auxiliary browsing context, so a tab opened from
 * another — and "duplicate tab" in the common engines — starts life holding the
 * parent's value.
 *
 * Uniqueness is therefore **not** decided here. An earlier version tried, with
 * a BroadcastChannel claim and a short timeout, and that was a heuristic
 * wearing a guarantee's clothing: channel delivery has no upper bound, so a
 * busy or backgrounded tab objects late — after this tab has already connected
 * on the copied id and the server has already moved a live run to it. No finite
 * client-side wait can prove that nobody else holds an id.
 *
 * The server settles it instead, by asking the incumbent connection whether it
 * is still there (see `ownerIsAlive` in cloud/server/src/socket.ts). All this
 * module does is remember an identity across reloads — and adopt the new one
 * the server issues when it finds this tab colliding with a live one.
 */

const STORAGE_KEY = 'cascade.clientId';

/** The id to connect with, minting and persisting one on first use. */
export function clientId(): string | undefined {
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
  } catch {
    return undefined;
  }
  let fresh: string;
  try { fresh = crypto.randomUUID(); } catch { return undefined; }
  try { sessionStorage.setItem(STORAGE_KEY, fresh); } catch { return undefined; }
  return fresh;
}

/**
 * Adopt the identity the server issued after finding this tab colliding.
 *
 * Persisted so the collision is not repeated on the next reload — the copied
 * value in storage is what would otherwise come back.
 */
export function adoptAssignedClientId(assigned: string): void {
  try { sessionStorage.setItem(STORAGE_KEY, assigned); } catch { /* not resumable; still connected */ }
}
