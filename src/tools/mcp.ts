// ─────────────────────────────────────────────
//  Cascade AI — MCP Tool Wrapper
// ─────────────────────────────────────────────

import type { ToolDefinition, ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { McpClient } from '../mcp/client.js';
import { isReadOnlyMcpToolName, mcpToolName } from './tool-name.js';

/** One connected MCP server and the tools it serves, as registered. */
export interface McpServerTools {
  server: string;
  tools: Array<{ name: string; description: string }>;
}

/**
 * The MCP servers behind `tools`, each with its tools. Read from the wrappers
 * rather than parsed out of the registered names: those are
 * `mcp__server__tool` after sanitising and de-duplication, which cannot be
 * split back into the server a tool came from.
 */
export function mcpServersIn(tools: Iterable<BaseTool | undefined>): McpServerTools[] {
  const servers = new Map<string, McpServerTools['tools']>();
  for (const tool of tools) {
    if (!(tool instanceof McpToolWrapper)) continue;
    const list = servers.get(tool.serverName) ?? [];
    list.push({ name: tool.toolName, description: tool.description.replace(`[MCP:${tool.serverName}] `, '') });
    servers.set(tool.serverName, list);
  }
  return Array.from(servers, ([server, list]) => ({ server, tools: list }));
}

/**
 * A wrapper for a single tool exposed by an MCP server.
 */
export class McpToolWrapper extends BaseTool {
  public readonly name: string;
  public readonly description: string;
  public readonly inputSchema: Record<string, unknown>;

  private mcpClient: McpClient;
  /** The server that serves this tool, and the tool's own name there. */
  readonly serverName: string;
  readonly toolName: string;

  constructor(
    mcpClient: McpClient,
    serverName: string,
    toolName: string,
    description: string,
    inputSchema: Record<string, unknown>,
    /**
     * The registered name, when the caller is de-duplicating a whole server's
     * tools at once (see `createMcpToolNamer`). Two raw names can sanitise onto
     * one, and the registry keys by name — so the caller that can see the
     * collision is the one that has to resolve it. Omitted, the plain encoding
     * is used, which is right for a single wrapper built in isolation.
     */
    registeredName?: string,
  ) {
    super();
    this.mcpClient = mcpClient;
    this.serverName = serverName;
    this.toolName = toolName;
    // Provider-safe by construction — OpenAI and Azure reject a name with
    // colons in it, and used to reject the entire request along with it.
    // Execution uses the serverName/toolName fields above, never this string,
    // so the encoding is free to be lossy.
    this.name = registeredName ?? mcpToolName(serverName, toolName);
    this.description = `[MCP:${serverName}] ${description}`;
    this.inputSchema = inputSchema;
  }

  // Every built-in tool of comparable risk (shell, git, file writes, the
  // built-in github tool) overrides this to true. An MCP tool never did —
  // BaseTool's default (false) meant a connected server's create/delete/push
  // actions ran with zero human approval, whatever they did. MCP carries no
  // standard "this mutates state" flag, so default to dangerous and name the
  // exception (a read-only-looking verb) rather than the other way around.
  isDangerous(): boolean {
    return !isReadOnlyMcpToolName(this.toolName);
  }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    return this.mcpClient.callTool(this.serverName, this.toolName, input);
  }
}
