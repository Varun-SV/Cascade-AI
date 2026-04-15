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
  private mcpClient: McpClient;
  private serverName: string;
  private toolName: string;
  private toolDescription: string;
  private inputSchema: Record<string, unknown>;

  constructor(
    mcpClient: McpClient,
    serverName: string,
    toolName: string,
    description: string,
    inputSchema: Record<string, unknown>
  ) {
    super(`mcp::${serverName}::${toolName}`);
    this.mcpClient = mcpClient;
    this.serverName = serverName;
    this.toolName = toolName;
    this.toolDescription = description;
    this.inputSchema = inputSchema;
  }

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: `[MCP:${this.serverName}] ${this.toolDescription}`,
      inputSchema: this.inputSchema,
    };
  }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    return this.mcpClient.callTool(this.serverName, this.toolName, input);
  }
}
