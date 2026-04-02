// ─────────────────────────────────────────────
//  Cascade AI — MCP Client
// ─────────────────────────────────────────────

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition } from '../types.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpClient {
  private clients: Map<string, Client> = new Map();
  private tools: Map<string, McpTool> = new Map();

  async connect(server: McpServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
    });

    const client = new Client(
      { name: 'cascade-ai', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    await client.connect(transport);
    this.clients.set(server.name, client);

    // Discover tools from this server
    const toolsResult = await client.listTools();
    for (const tool of toolsResult.tools) {
      this.tools.set(`${server.name}::${tool.name}`, {
        serverName: server.name,
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      });
    }
  }

  async disconnect(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      await client.close();
      this.clients.delete(serverName);
      for (const key of this.tools.keys()) {
        if (key.startsWith(`${serverName}::`)) this.tools.delete(key);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.clients.keys()) {
      await this.disconnect(name);
    }
  }

  async callTool(serverName: string, toolName: string, input: Record<string, unknown>): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server not connected: ${serverName}`);

    const result = await client.callTool({ name: toolName, arguments: input });
    const content = result.content as Array<{ type: string; text?: string }>;
    return content.map((c) => c.text ?? '').join('\n');
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: `mcp::${t.serverName}::${t.name}`,
      description: `[MCP:${t.serverName}] ${t.description}`,
      inputSchema: t.inputSchema,
    }));
  }

  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }

  isConnected(serverName: string): boolean {
    return this.clients.has(serverName);
  }
}
