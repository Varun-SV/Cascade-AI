import { describe, expect, it } from 'vitest';
import { CONNECTOR_CATALOG, connectorCatalog, getConnector, validateRemoteMcpUrl } from './mcp.js';

describe('connector catalog', () => {
  it('exposes github with a fixed hosted url', () => {
    const gh = getConnector('github');
    expect(gh).toBeDefined();
    expect(gh!.url).toMatch(/^https:\/\//);
    expect(gh!.requiresUrl).toBe(false);
  });
  it('marks byo-url connectors as requiring a url', () => {
    expect(getConnector('slack')!.requiresUrl).toBe(true);
    expect(getConnector('google')!.requiresUrl).toBe(true);
  });
  it('catalog() returns every entry', () => {
    expect(connectorCatalog().length).toBe(CONNECTOR_CATALOG.length);
  });
});

describe('validateRemoteMcpUrl', () => {
  it('accepts a public https url', () => {
    const r = validateRemoteMcpUrl('https://api.githubcopilot.com/mcp/');
    expect(r.ok).toBe(true);
  });
  it('rejects http (non-tls)', () => {
    const r = validateRemoteMcpUrl('http://example.com/mcp');
    expect(r.ok).toBe(false);
  });
  it('rejects loopback and localhost', () => {
    expect(validateRemoteMcpUrl('https://localhost/mcp').ok).toBe(false);
    expect(validateRemoteMcpUrl('https://127.0.0.1/mcp').ok).toBe(false);
  });
  it('rejects private ranges and the metadata endpoint', () => {
    expect(validateRemoteMcpUrl('https://10.0.0.5/mcp').ok).toBe(false);
    expect(validateRemoteMcpUrl('https://192.168.1.10/mcp').ok).toBe(false);
    expect(validateRemoteMcpUrl('https://172.16.9.9/mcp').ok).toBe(false);
    expect(validateRemoteMcpUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false);
  });
  it('rejects garbage', () => {
    expect(validateRemoteMcpUrl('not a url').ok).toBe(false);
  });
});
