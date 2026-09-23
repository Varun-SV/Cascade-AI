import { describe, it, expect } from 'vitest';
import { McpClient, isRemoteMcpServer } from './client.js';

describe('isRemoteMcpServer', () => {
  it('is true when a url is set', () => {
    expect(isRemoteMcpServer({ name: 'x', url: 'https://mcp.example.com/mcp' })).toBe(true);
  });
  it('is false for a stdio command config', () => {
    expect(isRemoteMcpServer({ name: 'x', command: 'node', args: ['server.js'] })).toBe(false);
  });
  it('is false when url is empty', () => {
    expect(isRemoteMcpServer({ name: 'x', url: '' })).toBe(false);
  });
});

describe('McpClient.connect validation', () => {
  it('rejects a config with neither url nor command (trusted, so it reaches transport)', async () => {
    const client = new McpClient({ trustedServers: ['bad'] });
    await expect(client.connect({ name: 'bad' })).rejects.toThrow(/neither a url nor a command/);
  });

  it('rejects an untrusted server when there is no approval callback', async () => {
    const client = new McpClient();
    await expect(client.connect({ name: 'untrusted', url: 'https://mcp.example.com/mcp' })).rejects.toThrow(/not trusted/);
  });
});

describe('McpClient.callTool', () => {
  function withTool(result: unknown): McpClient {
    const client = new McpClient();
    (client as unknown as { clients: Map<string, unknown> }).clients.set('srv', { callTool: async () => result });
    return client;
  }

  it('says a failed call failed — the protocol flag, not the wording, decides', async () => {
    // isError was dropped and the text joined as content, so a failing MCP
    // tool read as a result to the model and to the self-test.
    const client = withTool({ isError: true, content: [{ type: 'text', text: 'rate limited' }] });
    expect(await client.callTool('srv', 't', {})).toBe('Tool error: rate limited');
  });

  it('says so even when the failure came with no words', async () => {
    const client = withTool({ isError: true, content: [] });
    expect(await client.callTool('srv', 't', {})).toBe('Tool error: the MCP tool reported an error');
  });

  it('returns a successful call\u2019s text unchanged, however it begins', async () => {
    const client = withTool({ content: [{ type: 'text', text: 'Error: this line is data' }, { type: 'text', text: 'more' }] });
    expect(await client.callTool('srv', 't', {})).toBe('Error: this line is data\nmore');
  });
});
