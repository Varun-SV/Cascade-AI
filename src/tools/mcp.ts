// ─────────────────────────────────────────────
//  Cascade AI — MCP Tool Wrapper
// ─────────────────────────────────────────────

import type { ToolDefinition, ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { McpClient } from '../mcp/client.js';
import { mcpToolName } from './tool-name.js';

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
    inputSchema: Record<string, unknown>
  ) {
    super();
    this.mcpClient = mcpClient;
    this.serverName = serverName;
    this.toolName = toolName;
    // Provider-safe by construction — OpenAI and Azure reject a name with
    // colons in it, and used to reject the entire request along with it.
    // Execution uses the serverName/toolName fields above, never this string,
    // so the encoding is free to be lossy.
    this.name = mcpToolName(serverName, toolName);
    this.description = `[MCP:${serverName}] ${description}`;
    this.inputSchema = inputSchema;
  }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    return this.mcpClient.callTool(this.serverName, this.toolName, input);
  }
}
