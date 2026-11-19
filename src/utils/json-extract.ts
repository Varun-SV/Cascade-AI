// ─────────────────────────────────────────────
//  Cascade AI — Brace-Balanced JSON Extractor
// ─────────────────────────────────────────────

import { withoutReasoning } from './reasoning.js';

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
 * Parse the first JSON object a model wrote. Returns `null` on any failure so
 * callers can provide their own fallback. See `parseModelJson`.
 */
export function parseFirstJsonObject<T = unknown>(input: string): T | null {
  return parseModelJson<T>(input, 'object');
}

/** What follows a bracket that opens JSON rather than prose: a value, or the end of an empty one. */
const OPENS_JSON = /^\s*(?:[{["\]}\d-]|true\b|false\b|null\b)/;

/** At most this many opening brackets are tried, so a huge reply stays cheap. */
const MAX_STARTS = 64;

/**
 * The first JSON object or array of the requested shape in a model's reply.
 *
 * Written for every model, not only the ones that answer cleanly:
 *  - the reasoning is set aside first (`<think>` blocks; see utils/reasoning),
 *    so a bracket in the thinking is never mistaken for the answer;
 *  - a reply that is the JSON itself is taken whole; otherwise fenced ```json
 *    blocks are tried before the prose around them. A fence counts only at
 *    the start of a line with a real line break after its tag, which a fence
 *    inside a JSON string value (where line breaks are escaped) never has;
 *  - each opening bracket is tried in turn, string-aware, so prose such as
 *    "[see below]" before the real array doesn't end the search;
 *  - common slips are repaired: trailing commas, // and block comments,
 *    curly quotes, and Python's True / False / None.
 *
 * Returns `null` when nothing of that shape parses.
 */
export function parseModelJson<T = unknown>(input: string, shape: 'object' | 'array'): T | null {
  if (!input) return null;
  const answer = withoutReasoning(input);
  const open = shape === 'array' ? '[' : '{';
  const close = shape === 'array' ? ']' : '}';
  const whole = answer.trim();
  if (whole.startsWith(open)) {
    const parsed = parseLenient(whole);
    if (parsed !== undefined && (shape === 'array' ? Array.isArray(parsed) : isPlainObject(parsed))) return parsed as T;
  }
  const candidates: string[] = [];
  for (const m of answer.matchAll(/(?:^|\n)[ \t]*```[\w-]*[ \t]*\n([\s\S]*?)\n[ \t]*```/g)) {
    if (m[1]!.includes(open)) candidates.push(m[1]!);
  }
  candidates.push(answer);
  for (const text of candidates) {
    let tries = 0;
    for (let i = text.indexOf(open); i !== -1 && tries < MAX_STARTS; i = text.indexOf(open, i + 1)) {
      tries++;
      const end = balancedEnd(text, i, open, close);
      // A bracket that opens JSON and never closes is a payload cut short:
      // everything after it is inside it, and an inner array or object (an
      // assignment's `constraints: []`) must not be taken for the whole. A
      // bracket in prose ("[unfinished note") is passed over.
      if (end === -1) {
        if (OPENS_JSON.test(text.slice(i + 1, i + 40))) break;
        continue;
      }
      const parsed = parseLenient(text.slice(i, end + 1));
      if (parsed !== undefined && (shape === 'array' ? Array.isArray(parsed) : isPlainObject(parsed))) {
        return parsed as T;
      }
      // Likewise a closed one that opens JSON but won't parse: its inner
      // brackets belong to it, so the search resumes after it.
      if (OPENS_JSON.test(text.slice(i + 1, i + 40))) i = end;
    }
  }
  return null;
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Where the bracket at `start` closes, ignoring brackets inside strings; -1 if it never does. */
function balancedEnd(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote = '';
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"') { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/** JSON.parse, then once more after repairing the usual slips; undefined if neither parses. */
function parseLenient(slice: string): unknown {
  try { return JSON.parse(slice); } catch { /* repaired below */ }
  try { return JSON.parse(repair(slice)); } catch { return undefined; }
}

/** Trailing commas, comments, curly quotes and Python literals, outside strings. */
export function repair(slice: string): string {
  const text = slice.replace(/[\u201C\u201D]/g, '"');
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    const word = /^(True|False|None)\b/.exec(text.slice(i, i + 6));
    if (word && !/[\w$]/.test(text[i - 1] ?? '')) {
      out += word[1] === 'True' ? 'true' : word[1] === 'False' ? 'false' : 'null';
      i += word[1]!.length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}
