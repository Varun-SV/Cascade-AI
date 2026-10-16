import { stripTrailingSlashes } from './net.js';

/**
 * Whether a gitignore-style pattern could name something inside `rel/` by
 * that name: `alias/secret.txt` inside `alias`.
 *
 * A pattern must match a named segment of the prefix: an unanchored `.env`
 * alone does not name `alias`, while a globstar followed by alias/secret.txt does.
 */
export function reachesUnder(pattern: string, rel: string): boolean {
  return gitignoreRules([pattern]).some((rule) => ruleReachesUnder(rule, rel));
}

function ruleReachesUnder(rule: string, rel: string): boolean {
  const p = stripTrailingSlashes(rule);
  if (!p.includes('/')) return false;
  const segments = p.replace(/^\/+/, '').split('/');
  const names = rel.split('/');
  const seen = new Map<string, boolean>();
  const matches = (pi: number, ni: number, named: boolean): boolean => {
    if (ni === names.length) return named && pi < segments.length;
    if (pi === segments.length) return false;
    const key = `${pi}:${ni}:${named}`;
    if (seen.has(key)) return seen.get(key)!;
    const segment = segments[pi]!;
    const result = segment === '**'
      ? matches(pi + 1, ni, named) || matches(pi, ni + 1, named)
      : segmentMatches(segment, names[ni]!) && matches(pi + 1, ni + 1, true);
    seen.set(key, result);
    return result;
  };
  return matches(0, 0, false);
}

/**
 * One path segment of a gitignore pattern against one name. A class (`[ab]`)
 * is taken to match; a backslash makes the character after it literal.
 */
function segmentMatches(segment: string, name: string): boolean {
  if (segment.includes('[')) return true;
  const literal = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === '\\' && i + 1 < segment.length) source += literal(segment[++i]!);
    else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += literal(c);
  }
  // `ignore` uses case-insensitive matching by default on every platform.
  return new RegExp(`^${source}$`, 'i').test(name);
}

/**
 * The rules in gitignore-style patterns, read as the privacy matcher reads
 * them: a trailing line break dropped, and a trailing run of spaces unless
 * its first is escaped (`secret\ `), as git does; leading whitespace and
 * tabs kept; blank ones, comments, negations and one ending in a lone
 * backslash (no rule at all) left out. Escapes stay in, as git's pathspec
 * globs read them the same way.
 */
export function gitignoreRules(patterns: string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    // The matcher's own test: a backslash with nothing to escape.
    if (pattern.endsWith('\\') && !pattern.endsWith('\\\\')) continue;
    let end = pattern.length;
    while (end > 0 && (pattern[end - 1] === '\n' || pattern[end - 1] === '\r')) end--;
    const rule = trimTrailingSpaces(pattern.slice(pattern.startsWith('\uFEFF') ? 1 : 0, end));
    if (!rule || rule.startsWith('#') || rule.startsWith('!')) continue;
    out.push(rule);
  }
  return out;
}

/** `line` without its trailing spaces, but for one escaped by an odd run of backslashes before it. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') end--;
  if (end === line.length) return line;
  let slashes = 0;
  while (end - slashes > 0 && line[end - slashes - 1] === '\\') slashes++;
  return line.slice(0, slashes % 2 === 1 ? end + 1 : end);
}

