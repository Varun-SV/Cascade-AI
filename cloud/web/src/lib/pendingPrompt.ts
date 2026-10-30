// A prompt a visitor poured into the landing page, carried across sign-in so
// the chat opens with it in the composer — never sent on its own.
//
// sessionStorage, not memory: GitHub and Google sign-in navigate away and
// back, which unmounts everything. sessionStorage survives that round trip in
// the same tab and nowhere else — not other tabs, not a later visit — and the
// entry also expires, and is removed the moment the chat takes it.

const KEY = 'cascade-cloud-pending-prompt';
/** How long a poured prompt waits for its sign-in. */
export const PENDING_PROMPT_TTL_MS = 30 * 60 * 1000;

export function savePendingPrompt(text: string, now = Date.now()): void {
  const prompt = text.trim();
  try {
    if (!prompt) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify({ prompt, at: now }));
  } catch { /* storage unavailable: the visitor just retypes it */ }
}

/** The pending prompt, if one is waiting and fresh. Always clears the entry. */
export function takePendingPrompt(now = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const { prompt, at } = JSON.parse(raw) as { prompt?: unknown; at?: unknown };
    if (typeof prompt !== 'string' || !prompt.trim() || typeof at !== 'number') return null;
    return now - at <= PENDING_PROMPT_TTL_MS ? prompt : null;
  } catch {
    return null;
  }
}
