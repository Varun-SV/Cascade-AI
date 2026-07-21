import { describe, expect, it } from 'vitest';
import { CONNECTOR_CATALOG, connectorCatalog, getConnector, validateRemoteMcpUrl } from './mcp.js';

describe('connector catalog', () => {
  it('exposes github with a fixed hosted url', () => {
    const gh = getConnector('github');
    expect(gh).toBeDefined();
    expect(gh!.url).toMatch(/^https:\/\//);
    expect(gh!.requiresUrl).toBe(false);
  });
  it('treats github as token-based, not one-click OAuth (no DCR support)', () => {
    const gh = getConnector('github');
    expect(gh!.oauth).toBeFalsy();          // GitHub OAuth has no Dynamic Client Registration
    expect(gh!.tokenLabel.trim().length).toBeGreaterThan(0); // → a PAT the user pastes
  });
  it('marks byo-url connectors as requiring a url', () => {
    expect(getConnector('slack')!.requiresUrl).toBe(true);
    expect(getConnector('google')!.requiresUrl).toBe(true);
  });
  it('catalog() returns every entry', () => {
    expect(connectorCatalog().length).toBe(CONNECTOR_CATALOG.length);
  });

  it('ships the expanded one-click OAuth directory (Notion, Linear, Sentry, Stripe, Atlassian)', () => {
    for (const id of ['notion', 'linear', 'sentry', 'stripe', 'atlassian']) {
      const c = getConnector(id);
      expect(c, id).toBeDefined();
      expect(c!.oauth, id).toBe(true);       // one-click: no token to paste
      expect(c!.requiresUrl, id).toBe(false); // hardcoded hosted URL — user never types it
      expect(c!.url, id).toMatch(/^https:\/\//);
    }
  });

  it('every hosted (non byo-url) connector has a valid https endpoint', () => {
    for (const c of CONNECTOR_CATALOG) {
      if (c.requiresUrl) continue;
      expect(c.url, c.id).toBeDefined();
      expect(validateRemoteMcpUrl(c.url!).ok, `${c.id} → ${c.url}`).toBe(true);
    }
  });

  it('has unique ids and no empty names/descriptions', () => {
    const ids = CONNECTOR_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CONNECTOR_CATALOG) {
      expect(c.name.trim().length, c.id).toBeGreaterThan(0);
      expect(c.description.trim().length, c.id).toBeGreaterThan(0);
    }
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
