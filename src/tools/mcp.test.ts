import { describe, expect, it } from 'vitest';
import type { McpClient } from '../mcp/client.js';
import { McpToolWrapper, mcpServersIn } from './mcp.js';
import { ShellTool } from './shell.js';

const client = {} as McpClient;

describe('mcpServersIn', () => {
  it('groups registered MCP tools under the server that serves them', () => {
    // Registered as `mcp__filesystem__read_file`: `/mcp` split that on `::`,
    // got undefined for the server, and crashed.
    const read = new McpToolWrapper(client, 'filesystem', 'read_file', 'Read a file', {});
    const write = new McpToolWrapper(client, 'filesystem', 'write_file', 'Write a file', {});
    const issues = new McpToolWrapper(client, 'my github', 'list_issues', 'List issues', {});
    expect(read.name).toBe('mcp__filesystem__read_file');

    expect(mcpServersIn([read, new ShellTool(), undefined, write, issues])).toEqual([
      { server: 'filesystem', tools: [{ name: 'read_file', description: 'Read a file' }, { name: 'write_file', description: 'Write a file' }] },
      { server: 'my github', tools: [{ name: 'list_issues', description: 'List issues' }] },
    ]);
  });

  it('finds no servers when no MCP tool is registered', () => {
    expect(mcpServersIn([new ShellTool(), undefined])).toEqual([]);
  });
});
