// ─────────────────────────────────────────────
//  Cascade AI — MCP Tool Wrapper
// ─────────────────────────────────────────────

import type { ToolDefinition, ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { McpClient } from '../mcp/client.js';
import { isReadOnlyMcpToolName, mcpToolName } from './tool-name.js';

/**
 * A wrapper for a single tool exposed by an MCP server.
 */
export class McpToolWrapper extends BaseTool {
  public readonly name: string;
  public readonly description: string;
  public readonly inputSchema: Record<string, unknown>;

  private mcpClient: McpClient;
  private serverName: string;
  private toolName: string;

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
