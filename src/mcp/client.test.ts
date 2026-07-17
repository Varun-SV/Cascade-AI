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
