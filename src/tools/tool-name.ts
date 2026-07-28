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
  const cleaned = segment.replace(/[^a-zA-Z0-9-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || '_';
}

/** Provider-safe name for a tool exposed by an MCP server. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeToolNameSegment(serverName)}__${sanitizeToolNameSegment(toolName)}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** Prefix matching every tool from one server, for filtering. */
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
