/**
 * A resume identity that is unique to one LIVE tab.
 *
 * The server holds a dropped connection's runs and hands them back to whoever
 * reconnects with the same identity, so two live tabs sharing one id is not a
 * cosmetic problem: it is the cross-tab adoption bug — one tab's tokens
 * rendering in another's chat, and its Stop aborting a run it never started.
 *
 * `sessionStorage` alone does not give that guarantee. The HTML session storage
 * model *copies* a page session into a newly created auxiliary browsing
 * context, so a tab opened from another tab — and "duplicate tab" in the common
 * engines — starts life holding the parent's value. Reading it back therefore
 * proves only that some tab once stored it, not that this tab is that tab.
 *
 * So the id is CLAIMED rather than merely read: every tab announces the id it
 * intends to use, and a tab already using it says so, at which point the
 * newcomer rotates to a fresh one and persists that instead. The original keeps
 * its identity — and therefore its resumable runs — because it claimed first.
 */

const STORAGE_KEY = 'cascade.clientId';
const CHANNEL_NAME = 'cascade.client-id';

type ClaimMessage =
  | { type: 'claim'; id: string }
  | { type: 'taken'; id: string };

function read(): string | undefined {
  try { return sessionStorage.getItem(STORAGE_KEY) ?? undefined; } catch { return undefined; }
}

function write(id: string): boolean {
  try { sessionStorage.setItem(STORAGE_KEY, id); return true; } catch { return false; }
}

function mint(): string | undefined {
  try { return crypto.randomUUID(); } catch { return undefined; }
}

/**
 * The id this tab should connect with, plus a claim that rotates it if another
 * live tab answers to the same one.
 *
 * `onRotate` fires only in the collision case, and only after the replacement
 * is persisted — the caller reconnects with it so the server stops seeing two
 * sockets on one key. Everything degrades to "no resume identity" rather than
 * to a shared one: a tab that cannot store or mint an id is simply not
 * resumable, which is how the app behaved before runs were held at all.
 */
export function claimClientId(onRotate: (id: string) => void): string | undefined {
  let current = read() ?? mint();
  if (!current) return undefined;
  if (!write(current)) return undefined;

  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<ClaimMessage>) => {
      const message = event.data;
      if (!message || message.id !== current) return;

      if (message.type === 'claim') {
        // Another tab wants the id this one is already using. Ours by seniority.
        channel.postMessage({ type: 'taken', id: current } satisfies ClaimMessage);
        return;
      }

      // Ours was the copied one. Take a new identity and reconnect on it, so
      // the run the original tab is waiting on stays the original tab's.
      const fresh = mint();
      if (!fresh || !write(fresh)) return;
      current = fresh;
      onRotate(fresh);
    };
    channel.postMessage({ type: 'claim', id: current } satisfies ClaimMessage);
  } catch {
    // No BroadcastChannel: keep the stored id. A duplicated tab can still
    // collide, which is the behaviour before this existed, not a regression.
  }

  return current;
}
