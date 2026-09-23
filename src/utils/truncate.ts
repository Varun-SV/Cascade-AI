// ─────────────────────────────────────────────
//  Cascade AI — Context truncation helper
// ─────────────────────────────────────────────

/**
 * Bound a piece of text destined for an agent's conversation context.
 *
 * A worker's loop re-sends its ENTIRE accumulated context on every LLM call
 * (up to 15 iterations), so one unbounded tool result — a big file read, a
 * chatty shell command — multiplies into hundreds of thousands of tokens
 * across the run. Keep the head (where structure and answers usually live)
 * and a slice of the tail (where errors and exit summaries land), with an
 * explicit marker so the model knows content was elided.
 */
export function truncateForContext(text: string, maxChars = 12_000): string {
  const kept = contextParts(text, maxChars);
  if (!kept) return text;
  const elided = text.length - kept.head.length - kept.tail.length;
  return `${kept.head}\n\n[... ${elided.toLocaleString()} characters elided to keep context small — re-read the file with a line range if you need the middle ...]\n\n${kept.tail}`;
}

/**
 * The two parts of `text` that `truncateForContext` keeps, or undefined when
 * it keeps the whole. For whatever must know exactly what the model was shown.
 */
export function contextParts(text: string, maxChars = 12_000): { head: string; tail: string } | undefined {
  if (text.length <= maxChars) return undefined;
  const headLen = Math.floor(maxChars * 0.75);
  return { head: text.slice(0, headLen), tail: text.slice(-(maxChars - headLen)) };
}
