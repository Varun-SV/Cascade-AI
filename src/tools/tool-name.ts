// ─────────────────────────────────────────────
//  Cascade AI — Provider-safe tool names
// ─────────────────────────────────────────────
//
//  A tool name is not free-form. OpenAI and Azure validate it against
//  `^[a-zA-Z0-9_-]+$` and reject the whole request otherwise:
//
//    400 Invalid 'tools[2].function.name': string does not match pattern
//        '^[a-zA-Z0-9_-]+$'.
//
//  Cascade named MCP tools `mcp::<server>::<tool>`. The colons are illegal, so
//  with any MCP server connected and an OpenAI or Azure model selected, EVERY
//  request failed — the same shape as the Gemini `x-mcp-header` bug: MCP
//  metadata reaching a provider that validates what other providers ignore.
//  Anthropic accepts the colons, which is why this went unnoticed there.
//
//  Names are therefore built provider-safe at the source rather than patched at
//  each provider boundary. There is exactly one legal alphabet; encoding to it
//  once is simpler than three sanitisers that can disagree.
//
//  The separator is `__` because it survives the alphabet, reads clearly, and
//  keeps the prefix greppable. Execution never parses the name back — the
//  wrapper holds server and tool as separate fields — so this is a display and
//  wire identity only.

import { randomUUID } from 'node:crypto';

/** Prefix marking a tool that came from an MCP server. */
export const MCP_TOOL_PREFIX = 'mcp__';

/** The alphabet OpenAI and Azure accept. Gemini and Anthropic are laxer. */
const LEGAL_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Fold one path segment onto the legal alphabet.
 *
 * Every illegal run collapses to a single `_` so a server named "My Server!"
 * and one named "My  Server" don't produce visually identical but distinct
 * names. Empty input yields `_`, because a zero-length segment would make the
 * assembled name ambiguous.
 */
export function sanitizeToolNameSegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9-]+/g, '_');
  // Trim the separator off both ends with a scan, not `/^_+|_+$/g`. That
  // pattern backtracks quadratically on an INTERIOR run — `a` + `_`x50000 + `b`
  // took 2.7s — because `_+$` is retried from every position in the run and
  // fails the anchor each time.
  //
  // It was not reachable here: `_` is outside the allowed class above, so the
  // collapse already guarantees no run longer than one. But that safety rests
  // on a non-obvious interaction between two adjacent lines, and would quietly
  // disappear if the allowed class ever gained `_` or the trim moved. A scan
  // costs nothing and doesn't need the argument.
  let start = 0;
  let end = cleaned.length;
  while (start < end && cleaned[start] === '_') start++;
  while (end > start && cleaned[end - 1] === '_') end--;
  return cleaned.slice(start, end) || '_';
}

/** Provider-safe name for a tool exposed by an MCP server. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeToolNameSegment(serverName)}__${sanitizeToolNameSegment(toolName)}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * A name for a NEW MCP server connection that won't collide, on its sanitized
 * tool prefix, with any name already in use.
 *
 * Compared by prefix, not by the raw name: `foo bar` and `foo@bar` are
 * different strings but both register as `mcp__foo_bar__…`, so a check against
 * raw names would accept a pair that still collides downstream — the exact gap
 * that let two connectors' tools overwrite each other in the registry.
 *
 * Mirrored on the cloud side (`cloud/server/src/db.ts` `uniqueMcpServerName`,
 * DB-backed instead of array-backed) — kept in sync by hand since the two sides
 * don't share a runtime, but the algorithm and suffix format must match or a
 * name that's unique on one side could still collide on the other after a sync
 * pull (see `mergeMcpServers` in `src/cloud/keysync.ts`, which performs the
 * same comparison for that reason).
 */
export function uniqueMcpServerName(desired: string, existingNames: string[]): string {
  const taken = new Set(existingNames.map(mcpServerPrefix));
  if (!taken.has(mcpServerPrefix(desired))) return desired;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${desired} (${n})`;
    if (!taken.has(mcpServerPrefix(candidate))) return candidate;
  }
  // Unreached in practice (1000 same-named collisions), but this name becomes
  // part of the filesystem path an OAuth token is stored under
  // (`storePathFor` in cloudAuth.ts / cli/commands/mcp.ts), so the fallback
  // needs a CSPRNG rather than Math.random() — matching the cloud twin above,
  // which already uses randomUUID() for the same reason.
  return `${desired} (${randomUUID().slice(0, 8)})`;
}

/**
 * Rename pre-existing entries whose sanitized prefixes collide.
 *
 * For config loaded from disk (desktop and CLI share one config file), rather
 * than a fresh connection — `uniqueMcpServerName` only guards a NEW entry, so a
 * file that already contains a colliding pair (hand-edited, or written by a
 * CLI version that predates the check) stays broken until something touches it.
 * The FIRST entry of each colliding group keeps its name, since that connection
 * is presumably already working; later ones are suffixed exactly as
 * `uniqueMcpServerName` would have produced had they been added after this
 * existed. A no-op when nothing collides, so callers can run it unconditionally
 * on every load without needing a one-time migration flag.
 */
export function disambiguateMcpServerNames<T extends { name: string }>(servers: T[]): T[] {
  const seenNames: string[] = [];
  let changed = false;
  const result = servers.map((s) => {
    const name = uniqueMcpServerName(s.name, seenNames);
    seenNames.push(name);
    if (name === s.name) return s;
    changed = true;
    return { ...s, name };
  });
  return changed ? result : servers;
}

/**
 * Assign a UNIQUE registered name to every tool in one set, suffixing collisions.
 *
 * Sanitising is lossy by design, so two raw names can land on one: a server
 * advertising `list files` and `list@files` yields `mcp__srv__list_files`
 * twice. That is harmless as display and fatal as identity — `ToolRegistry`
 * keys by name, so the second wrapper silently replaces the first, and a picker
 * keyed by the same value shows two checkboxes that control one tool.
 *
 * Batch, not streaming, and the result does not depend on the order the tools
 * arrive in. That matters because these names are PERSISTED: a user's deny list
 * stores them, discovery and the run are separate live connections, and MCP does
 * not promise a stable order for `tools/list`. An arrival-order counter would
 * hand the unsuffixed key to a different raw tool between two runs, so a saved
 * denial would silently move to a tool the user never switched off.
 *
 * Within a colliding group the clean name goes to the pair that needs no
 * folding at all (server AND tool both already legal), because a legal raw
 * identity can never be displaced by a folded one added later. Failing that,
 * the lexicographically first `server::tool` pair wins — comparing the pair,
 * not just the tool name, so two DIFFERENT servers that collided on their own
 * sanitised prefix (see the account-merge case in keysync.ts) still break the
 * tie deterministically even when they happen to share a tool name. The rest
 * get `_2`, `_3`, … in that same order.
 */
export function assignMcpToolNames(tools: Array<{ server: string; tool: string }>): string[] {
  const names: string[] = new Array(tools.length);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < tools.length; i++) {
    const base = mcpToolName(tools[i]!.server, tools[i]!.tool);
    names[i] = base;
    const g = groups.get(base);
    if (g) g.push(i); else groups.set(base, [i]);
  }

  for (const [base, idx] of groups) {
    if (idx.length === 1) continue;
    const raw = (i: number) => `${tools[i]!.server}::${tools[i]!.tool}`;
    const isClean = (i: number) => sanitizeToolNameSegment(tools[i]!.server) === tools[i]!.server
      && sanitizeToolNameSegment(tools[i]!.tool) === tools[i]!.tool;
    const ordered = [...idx].sort((a, b) => {
      const la = isClean(a) ? 0 : 1;
      const lb = isClean(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      const ra = raw(a);
      const rb = raw(b);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
    ordered.forEach((i, rank) => { names[i] = rank === 0 ? base : `${base}_${rank + 1}`; });
  }
  return names;
}

/**
 * Prefix matching every tool from one server, for filtering.
 *
 * Also lets a host drop a server's per-tool selections when the server itself
 * is removed — otherwise a tool switched off before removal stays off when the
 * same connector is added back, with nothing on screen explaining why.
 */
export function mcpServerPrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeToolNameSegment(serverName)}__`;
}

/**
 * True when a name is accepted by the strictest provider Cascade talks to.
 *
 * Used by tests to hold the whole tool surface — built-ins, MCP, and
 * runtime-synthesised tools — to the alphabet, so the next tool with a colon or
 * a space in its name fails in CI rather than in someone's chat.
 */
export function isProviderSafeToolName(name: string): boolean {
  return LEGAL_NAME.test(name);
}
