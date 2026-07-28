// ─────────────────────────────────────────────
//  Cascade AI — MCP tool discovery
// ─────────────────────────────────────────────
//
//  Settings needs to show what a connected server actually offers before a run
//  exists. Reported as: "when i have github connected using mcp connectors …
//  in settings as well i can not fine tune on what tools to be accessible and
//  selection." You cannot select from a list you have never been shown.
//
//  Discovery is deliberately a separate, short-lived connection rather than a
//  cache written during a run: a server's tool list changes when the user
//  re-authorises a connector or the vendor ships new endpoints, and a stale
//  list would silently hide tools the user does have.

import type { McpServerConfig } from '../types.js';
import { McpClient } from './client.js';
import { fileOAuthProvider } from './oauth.js';
import { mcpToolName } from '../tools/tool-name.js';

/** One tool a server advertises, named exactly as it is registered at run time. */
export interface DiscoveredMcpTool {
  /** The server that advertises it. */
  server: string;
  /** The server-side tool name (what the vendor calls it). */
  tool: string;
  /** The registered name — `mcp__server__tool`. This is the selection key. */
  name: string;
  description: string;
}

export interface McpDiscoveryResult {
  server: string;
  tools: DiscoveredMcpTool[];
  /** Set when the server could not be reached or refused the connection. */
  error?: string;
}

/**
 * Connect to each server, list its tools, disconnect.
 *
 * Servers are pre-trusted here because the caller has already added them —
 * discovery reads a list, it never invokes anything. A server that fails is
 * reported with its error rather than throwing, so one dead connector cannot
 * blank out the Settings panel for the working ones.
 */
export async function discoverMcpTools(servers: McpServerConfig[]): Promise<McpDiscoveryResult[]> {
  const results: McpDiscoveryResult[] = [];

  for (const server of servers) {
    // A fresh client per server: `getToolDefinitions()` is client-wide, so a
    // shared client would attribute every server's tools to whichever one
    // happened to connect, and one failure would poison the rest.
    const client = new McpClient({ trustedServers: [server.name] });
    try {
      const authProvider = server.oauthStore ? fileOAuthProvider(server.oauthStore) : undefined;
      await client.connect(server, authProvider ? { authProvider } : {});
      const tools = client.getToolDefinitions().flatMap((def): DiscoveredMcpTool[] => {
        const [, serverName, toolName] = def.name.split('::');
        if (!serverName || !toolName) return [];
        return [{
          server: serverName,
          tool: toolName,
          name: mcpToolName(serverName, toolName),
          description: def.description.replace(`[MCP:${serverName}] `, ''),
        }];
      });
      results.push({ server: server.name, tools });
    } catch (err) {
      results.push({
        server: server.name,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await client.disconnectAll().catch(() => { /* already gone */ });
    }
  }

  return results;
}
