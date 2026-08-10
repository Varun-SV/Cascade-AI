// ─────────────────────────────────────────────
//  Cascade Web — Client-side request limits
// ─────────────────────────────────────────────
//
// The server no longer caps prompt length in its schema (see `prompt` in
// cloud/server/src/runs.ts): a 20k-character ceiling rejected exactly the long
// inputs Cascade is for. What remains is a TRANSPORT limit — socket.io is
// configured with `maxHttpBufferSize: 2 * 1024 * 1024` in
// cloud/server/src/socket.ts — and that one fails in the worst possible way.
//
// An oversized frame is rejected by the transport BEFORE any handler runs, so
// there is no Zod error, no `chat:run` ack, and nothing for the UI to show:
// the socket simply drops or disconnects and the message appears to hang
// forever. A schema rejection at least answers. So the client has to be the
// thing that says "too long", and it has to say it below the boundary rather
// than at it.

/** The server's socket.io frame ceiling. Keep in sync with socket.ts. */
export const MAX_SOCKET_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Largest prompt we will emit, in UTF-8 bytes.
 *
 * Held ~200 KB under the frame ceiling because the prompt is not the only
 * thing in the payload — provider entries (with keys and base URLs), search
 * config, attachment ids and the per-tier knobs ride along, and the frame is
 * measured after JSON encoding, which expands quotes, backslashes and control
 * characters. Guarding at exactly 2 MB would let a prompt just under the line
 * push the encoded frame just over it, which is the silent-hang case again.
 */
export const MAX_PROMPT_BYTES = 1_900_000;

/** UTF-8 byte length — `String.length` counts UTF-16 units, which under-counts. */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Human-readable size for an error message ("1.9 MB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Returns an error message when `text` is too large to send, or null when it
 * is fine. Phrased so the user knows what to do — the failure is about the
 * size of this one message, not about their account or the server.
 *
 * This is the CHEAP, EARLY check, and it is deliberately not the only one.
 * Measuring the raw text cannot bound the frame on its own: socket.io's default
 * parser JSON-encodes the payload, and encoding is not length-preserving — a
 * backslash, a quote or a control character becomes two characters, so text
 * made mostly of them nearly doubles on the wire. 1.1 MB of backslashes passes
 * this check and produces a ~2.2 MB frame. `payloadTooLargeError` below is the
 * authoritative one; this exists so an obviously oversized paste is rejected
 * before the UI does any work for it.
 */
export function promptTooLargeError(text: string): string | null {
  const size = byteLength(text);
  if (size <= MAX_PROMPT_BYTES) return null;
  return tooLargeMessage(size);
}

/**
 * The real check: measures what will actually be put on the wire.
 *
 * socket.io wraps the payload in a small packet envelope (packet type, event
 * name, namespace, ack id) on top of this, which is why the budget is the
 * ~200 KB-under-2 MB `MAX_PROMPT_BYTES` rather than the frame ceiling itself.
 * Returns null when the payload is fine.
 */
export function payloadTooLargeError(payload: unknown): string | null {
  let size: number;
  try {
    size = byteLength(JSON.stringify(payload) ?? '');
  } catch {
    // A payload that cannot be serialized is not one we can size. Let it
    // through — socket.io's own encoder is the thing that will complain, and
    // inventing a size error here would be a confusing lie.
    return null;
  }
  if (size <= MAX_PROMPT_BYTES) return null;
  return tooLargeMessage(size);
}

function tooLargeMessage(size: number): string {
  return `That message is ${formatBytes(size)}, over the ${formatBytes(MAX_PROMPT_BYTES)} limit for a single message. Send it in smaller pieces, or attach it as a file.`;
}
