// ─────────────────────────────────────────────
//  Cascade AI — MCP Client
// ─────────────────────────────────────────────

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { ToolDefinition } from '../types.js';

export interface McpServerConfig {
  name: string;
  // Local (stdio) transport — spawns a subprocess.
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Remote transport — hosted MCP server over Streamable HTTP (SSE fallback).
  url?: string;
  headers?: Record<string, string>;
}

/** True when the config targets a remote (hosted) MCP server rather than a
 *  local subprocess. Remote configs are the only ones safe to run hosted. */
export function isRemoteMcpServer(server: McpServerConfig): boolean {
  return typeof server.url === 'string' && server.url.length > 0;
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
  /**
   * Sink for non-fatal warnings. Hosts with a live TUI must route these
   * away from the terminal — a raw console write mid-frame corrupts Ink's
   * rendering. Defaults to console.warn.
   */
  onWarn?: (message: string) => void;
}

export class McpClient {
  private static activeProcessPids = new Set<number>();

  /** 
   * Forcefully kills all known MCP child processes. 
   * Call this from global process exit handlers to prevent zombie processes.
   */
  static killAllProcesses(): void {
    for (const pid of McpClient.activeProcessPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore errors (process already dead, etc.)
      }
    }
    McpClient.activeProcessPids.clear();
  }

  private clients: Map<string, Client> = new Map();
  private transports: Map<string, Transport> = new Map();
  private tools: Map<string, McpTool> = new Map();
  private trustedServers: Set<string>;
  private approvalCallback: McpApprovalCallback | undefined;

  private onWarn: (message: string) => void;

  constructor(options: McpClientOptions = {}) {
    this.trustedServers = new Set(options.trustedServers ?? []);
    this.approvalCallback = options.approvalCallback;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
  }

  async connect(server: McpServerConfig, opts: { authProvider?: OAuthClientProvider } = {}): Promise<void> {
    const remote = isRemoteMcpServer(server);

    // Connecting to an MCP server is the riskiest operation in the tool system:
    // a local server spawns an arbitrary subprocess; a remote one sends the
    // configured auth to a URL and runs whatever tools it advertises. Require
    // explicit trust before creating any transport.
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

    const client = new Client(
      { name: 'cascade-ai', version: '0.1.0' },
      { capabilities: {} },
    );

    let transport: Transport;
    if (remote) {
      transport = await this.connectRemote(server, client, opts.authProvider);
    } else {
      if (!server.command) {
        throw new Error(`MCP server "${server.name}" has neither a url nor a command.`);
      }
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
      });
      await client.connect(transport);
    }
    this.clients.set(server.name, client);
    this.transports.set(server.name, transport);

    // Track the child pid so global exit handlers can reap it (stdio only —
    // remote transports have no subprocess). Set after connect, when the SDK
    // has spawned the process and populated `pid`.
    if (transport instanceof StdioClientTransport && transport.pid) {
      McpClient.activeProcessPids.add(transport.pid);
    }

    // Discover tools from this server. If another server already registered
    // a tool with the same bare name, emit a console warning but keep the
    // new key distinct (we namespace internally as `<server>::<tool>`).
    const toolsResult = await client.listTools();
    for (const tool of toolsResult.tools) {
      for (const existing of this.tools.values()) {
        if (existing.name === tool.name && existing.serverName !== server.name) {
          this.onWarn(
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

  /**
   * Connect to a remote MCP server. Tries Streamable HTTP first (the current
   * transport); if that fails (a legacy server that only speaks SSE), retries
   * once over SSE. Auth headers ride on every request. Returns the live
   * transport so the caller can register it.
   */
  private async connectRemote(server: McpServerConfig, client: Client, authProvider?: OAuthClientProvider): Promise<Transport> {
    const url = new URL(server.url!);
    const headers = server.headers && Object.keys(server.headers).length ? server.headers : undefined;
    // An OAuth `authProvider` attaches (and auto-refreshes) the bearer token; a
    // static `headers` map is the token-paste path. They're mutually exclusive
    // in practice, but both may be passed to the transport harmlessly.
    const opts = {
      ...(authProvider ? { authProvider } : {}),
      ...(headers ? { requestInit: { headers } } : {}),
    };
    try {
      const http = new StreamableHTTPClientTransport(url, opts);
      await client.connect(http);
      return http;
    } catch (httpErr) {
      this.onWarn(`[mcp] Streamable HTTP failed for "${server.name}", falling back to SSE: ${String(httpErr)}`);
      const sse = new SSEClientTransport(url, opts);
      await client.connect(sse);
      return sse;
    }
  }

  async disconnect(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      const transport = this.transports.get(serverName);
      // Reap the child pid for stdio transports (remote transports have none).
      if (transport instanceof StdioClientTransport && transport.pid) {
        McpClient.activeProcessPids.delete(transport.pid);
      }

      await client.close();
      this.clients.delete(serverName);
      this.transports.delete(serverName);
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

  getActivePids(): number[] {
    const pids: number[] = [];
    for (const transport of this.transports.values()) {
      // Only stdio transports own a subprocess pid; remote transports have none.
      if (transport instanceof StdioClientTransport && transport.pid) pids.push(transport.pid);
    }
    return pids;
  }

  isConnected(serverName: string): boolean {
    return this.clients.has(serverName);
  }
}
