/**
 * A resume identity that is unique to one LIVE tab, settled before it is used.
 *
 * The server hands a dropped connection's runs to whoever reconnects with the
 * same identity — and, since it must treat a same-key socket as the client
 * genuinely coming back, it transfers those runs immediately. Two live tabs
 * sharing one id is therefore not a cosmetic problem: it is one tab's run
 * being taken out from under it.
 *
 * `sessionStorage` alone does not prevent that. The HTML session storage model
 * *copies* a page session into a newly created auxiliary browsing context, so a
 * tab opened from another — and "duplicate tab" in the common engines — starts
 * life holding the parent's value. Reading it back proves only that some tab
 * once stored it, not that this tab is that tab.
 *
 * So the id is CLAIMED, and — critically — the claim is **settled before the
 * socket connects**. An earlier version returned the stored id immediately and
 * rotated afterwards, on the theory that briefly sharing a key was harmless.
 * It is not: within that window the server has already moved the original
 * tab's run to the duplicate, and the duplicate then rotates away and takes
 * the run with it. The window has to not exist.
 */

const STORAGE_KEY = 'cascade.clientId';
const CHANNEL_NAME = 'cascade.client-id';

/**
 * How long to wait for another tab to object.
 *
 * A BroadcastChannel round trip between same-origin tabs is a structured
 * clone and a task, not a network hop, so this is generous. It is paid only
 * when an id was READ from storage — a freshly minted one cannot be a copy of
 * anybody's, so a first-ever load connects with no delay at all.
 */
const CLAIM_SETTLE_MS = 50;

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
 * The identity to connect with, once it is known to be this tab's alone.
 *
 * Resolves with `undefined` when no identity can be established at all (no
 * storage, or no way to mint one), which simply makes that tab non-resumable —
 * how the app behaved before runs were held across a drop.
 *
 * The channel listener outlives the promise on purpose: this tab must go on
 * answering later claims, so that a tab duplicated from it rotates in turn.
 */
export function claimClientId(): Promise<string | undefined> {
  const stored = read();
  let current = stored ?? mint();
  if (!current || !write(current)) return Promise.resolve(undefined);

  // Nothing to settle: an id this tab just minted cannot be a copy.
  if (!stored) return Promise.resolve(current);

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    // No channel, no collision detection. The stored id is used as-is, which
    // is the behaviour that existed before any of this — not a regression.
    return Promise.resolve(current);
  }

  const claimed: string = current;
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const settle = (id: string | undefined) => { if (!settled) { settled = true; resolve(id); } };
    const timer = setTimeout(() => settle(current), CLAIM_SETTLE_MS);
    // `current` moves on rotation; `claimed` is what was posted.
    void claimed;

    channel.onmessage = (event: MessageEvent<ClaimMessage>) => {
      const message = event.data;
      if (!message || message.id !== current) return;

      if (message.type === 'claim') {
        // Another tab wants the id this one is using. Ours by seniority.
        channel.postMessage({ type: 'taken', id: message.id } satisfies ClaimMessage);
        return;
      }

      // Ours was the copied one. Take a new identity before connecting at all,
      // so the original tab's run is never briefly ours to take.
      clearTimeout(timer);
      const fresh = mint();
      if (!fresh || !write(fresh)) { settle(undefined); return; }
      current = fresh;
      settle(fresh);
    };

    channel.postMessage({ type: 'claim', id: claimed } satisfies ClaimMessage);
  });
}
