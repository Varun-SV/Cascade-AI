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

/**
 * Gate called before each MCP server is spawned. Lets the caller (REPL or
 * SDK) prompt the user for explicit approval of a subprocess binary.
 * Return `true` to allow, `false` to reject.
 */
export type McpApprovalCallback = (server: McpServerConfig) => Promise<boolean> | boolean;

export interface McpClientOptions {
  /** Names of servers the user has already trusted (config.mcp.trusted). */
  trustedServers?: string[];
  /** Approval gate invoked when a server is NOT in the trusted list. */
  approvalCallback?: McpApprovalCallback;
}

export class McpClient {
  private clients: Map<string, Client> = new Map();
  private tools: Map<string, McpTool> = new Map();
  private trustedServers: Set<string>;
  private approvalCallback: McpApprovalCallback | undefined;

  constructor(options: McpClientOptions = {}) {
    this.trustedServers = new Set(options.trustedServers ?? []);
    this.approvalCallback = options.approvalCallback;
  }

  async connect(server: McpServerConfig): Promise<void> {
    // Spawning an arbitrary subprocess is the riskiest operation in the
    // tool system — the MCP command could be anything, including curl or a
    // shell. Require explicit trust before transport creation.
    if (!this.trustedServers.has(server.name)) {
      const approved = this.approvalCallback
        ? await this.approvalCallback(server)
        : false;
      if (!approved) {
        throw new Error(
          `MCP server "${server.name}" is not trusted. Add it to config.mcp.trusted or approve interactively before connecting.`,
        );
      }
      this.trustedServers.add(server.name);
    }

    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
    });

    const client = new Client(
      { name: 'cascade-ai', version: '0.1.0' },
      { capabilities: {} },
    );

    await client.connect(transport);
    this.clients.set(server.name, client);

    // Discover tools from this server. If another server already registered
    // a tool with the same bare name, emit a console warning but keep the
    // new key distinct (we namespace internally as `<server>::<tool>`).
    const toolsResult = await client.listTools();
    for (const tool of toolsResult.tools) {
      for (const existing of this.tools.values()) {
        if (existing.name === tool.name && existing.serverName !== server.name) {
          console.warn(
            `[mcp] Tool "${tool.name}" is exposed by both "${existing.serverName}" and "${server.name}". ` +
            `Cascade disambiguates internally via mcp::<server>::<tool>.`,
          );
          break;
        }
      }
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
