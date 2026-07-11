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
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.75);
  const tailLen = maxChars - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  const elided = text.length - headLen - tailLen;
  return `${head}\n\n[... ${elided.toLocaleString()} characters elided to keep context small — re-read the file with a line range if you need the middle ...]\n\n${tail}`;
}
