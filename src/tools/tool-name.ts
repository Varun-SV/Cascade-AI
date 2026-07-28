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
 * Hand out a UNIQUE registered name per tool, suffixing folded collisions.
 *
 * Sanitising is lossy by design, so two raw names can land on one: a server
 * advertising `list files` and `list@files` yields `mcp__srv__list_files`
 * twice. That is harmless as display and fatal as identity — `ToolRegistry`
 * keys by name, so the second wrapper silently replaces the first, and a picker
 * keyed by the same value shows two checkboxes that control one tool.
 *
 * The first claimant keeps the clean name, so a selection made before a
 * colliding tool appeared still matches. Later ones get `_2`, `_3`, …
 *
 * Deterministic in the order names are requested. Discovery and registration
 * both walk `McpClient.getToolDefinitions()` in that order, which is what makes
 * the name shown in Settings the same name the run registers — if they used
 * separate schemes, a checkbox would deny a tool that never existed.
 */
export function createMcpToolNamer(): (serverName: string, toolName: string) => string {
  const taken = new Set<string>();
  return (serverName, toolName) => {
    const base = mcpToolName(serverName, toolName);
    if (!taken.has(base)) { taken.add(base); return base; }
    let n = 2;
    while (taken.has(`${base}_${n}`)) n++;
    const unique = `${base}_${n}`;
    taken.add(unique);
    return unique;
  };
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
