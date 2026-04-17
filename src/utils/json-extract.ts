// ─────────────────────────────────────────────
//  Cascade AI — Brace-Balanced JSON Extractor
// ─────────────────────────────────────────────

/**
 * Extract the first top-level JSON object from a string by scanning braces,
 * respecting string literals and escapes. Greedy `/\{[\s\S]*\}/` regexes
 * over-match when the model wraps JSON in markdown fences with sample braces
 * inside code comments; this walker ignores any brace inside a string and
 * unbalances correctly on the first complete object.
 *
 * Returns the JSON slice including the outer braces, or `null` if no balanced
 * object is found.
 */
export function extractFirstJsonObject(input: string): string | null {
  if (!input) return null;
  const start = input.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Parse the first balanced JSON object. Returns `null` on any failure so
 * callers can provide their own fallback.
 */
export function parseFirstJsonObject<T = unknown>(input: string): T | null {
  const slice = extractFirstJsonObject(input);
  if (!slice) return null;
  try {
    return JSON.parse(slice) as T;
  } catch {
    return null;
  }
}
