// ─────────────────────────────────────────────
//  Cascade AI — MCP Tool Wrapper
// ─────────────────────────────────────────────

import type { ToolDefinition, ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { McpClient } from '../mcp/client.js';

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
    this.name = `mcp::${serverName}::${toolName}`;
    this.description = `[MCP:${serverName}] ${description}`;
    this.inputSchema = inputSchema;
  }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    return this.mcpClient.callTool(this.serverName, this.toolName, input);
  }
}
