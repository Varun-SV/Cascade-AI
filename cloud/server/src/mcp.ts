// ─────────────────────────────────────────────
//  Cascade Cloud — Remote MCP servers & connectors
// ─────────────────────────────────────────────
//
// The hosted server can attach *remote* MCP servers (Streamable HTTP / SSE) as
// tool sources for a run. It never spawns local subprocesses — only URL-based
// servers are allowed. "Connectors" are curated presets on top of the same
// mechanism: picking GitHub fills in its hosted MCP endpoint and asks for a
// token; the generic path lets a user point at any remote MCP server.

/** A connector preset shown in the UI. Maps an app onto a remote MCP server. */
export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  description: string;
  /** Fixed endpoint when the app publishes a universal hosted MCP server;
   *  omitted when the user must supply their own MCP server URL. */
  url?: string;
  /** HTTP header the token is sent in (e.g. 'Authorization'). */
  authHeader: string;
  /** Prefix prepended to the pasted token (e.g. 'Bearer '). */
  authPrefix: string;
  /** What the user should paste (shown as the field label/help). */
  tokenLabel: string;
  /** Where to get that token. */
  docsUrl: string;
  /** True when the user must provide the MCP server URL themselves. */
  requiresUrl: boolean;
  /** The hosted server speaks OAuth 2.1 — the client can one-click "Connect"
   *  (browser sign-in) with no token to paste. Discovery/DCR happens at connect
   *  time; a token remains available as a fallback. */
  oauth?: boolean;
  /** Brand colour for the UI badge (hex). Optional. */
  color?: string;
}

// Curated connector directory. Each entry maps an app onto a *known* hosted
// remote MCP endpoint so the user never types a URL — exactly how Claude's
// connector directory feels. The ones with `oauth: true` need no token at all:
// click Connect → the provider's sign-in page → done (OAuth 2.1 + PKCE, with
// discovery/DCR handled by our MCP OAuth stack). URLs are the services' own
// documented hosted endpoints; if one ever changes, the connect fails gracefully
// and the user can still fall back to the "Custom MCP server" option.
//
// Only services that publish a single public hosted endpoint are one-click.
// Slack/Google have no universal hosted MCP server yet, so they stay "bring your
// MCP URL" — the friction there is an ecosystem gap, not ours.
export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, issues, and PRs via GitHub’s hosted MCP server.',
    url: 'https://api.githubcopilot.com/mcp/',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tokenLabel: 'GitHub Personal Access Token (fine-grained)',
    docsUrl: 'https://github.com/settings/personal-access-tokens',
    requiresUrl: false,
    // Token, NOT one-click OAuth: GitHub's OAuth has no Dynamic Client
    // Registration, so our DCR-based flow can't self-register — auth is a
    // Personal Access Token pasted into the form.
    oauth: false,
    color: '#f0f6fc',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read & write pages, databases and blocks in your workspace.',
    url: 'https://mcp.notion.com/mcp',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tokenLabel: 'Notion integration token',
    docsUrl: 'https://www.notion.com/help/mcp-connections-for-custom-agents',
    requiresUrl: false,
    oauth: true,
    color: '#e6e6e6',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects and cycles from your Linear workspace.',
    url: 'https://mcp.linear.app/mcp',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tokenLabel: 'Linear API key',
    docsUrl: 'https://linear.app/docs/mcp',
    requiresUrl: false,
    oauth: true,
    color: '#5e6ad2',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Errors, issues and releases from your Sentry projects.',
    url: 'https://mcp.sentry.dev/mcp',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tokenLabel: 'Sentry auth token',
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    requiresUrl: false,
    oauth: true,
    color: '#6559c6',
  },
  {
    id: 'atlassian',
    name: 'Jira & Confluence',
    description: 'Atlassian’s official server for Jira, Confluence & more.',
    url: 'https://mcp.atlassian.com/v1/mcp',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tokenLabel: 'Atlassian API token',
    docsUrl: 'https://www.atlassian.com/platform/remote-mcp-server',
    requiresUrl: false,
    oauth: true,
    color: '#0c66e4',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Query and manage payments, customers and products.',
    url: 'https://mcp.stripe.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tokenLabel: 'Stripe restricted API key',
    docsUrl: 'https://docs.stripe.com/mcp',
    requiresUrl: false,
    oauth: true,
    color: '#635bff',
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs',
    description: 'Search Cloudflare’s documentation. Public — no sign-in needed.',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tokenLabel: '',
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/',
    requiresUrl: false,
    oauth: false,
    color: '#f6821f',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Channels & messages. Point at your Slack MCP server endpoint.',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tokenLabel: 'Slack Bot/User OAuth token',
    docsUrl: 'https://api.slack.com/apps',
    requiresUrl: true,
    color: '#611f69',
  },
  {
    id: 'google',
    name: 'Google',
    description: 'Drive, Gmail & Calendar. Point at your Google MCP server endpoint.',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tokenLabel: 'Google OAuth access token',
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    requiresUrl: true,
    color: '#4285f4',
  },
];

export function getConnector(id: string): ConnectorCatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((c) => c.id === id);
}

/** Catalog view for the client (no secrets — these are static presets). */
export function connectorCatalog(): ConnectorCatalogEntry[] {
  return CONNECTOR_CATALOG;
}

// Literal private / loopback / link-local ranges we refuse to connect to, so a
// user can't turn the hosted server into an SSRF proxy for internal services or
// the cloud metadata endpoint. DNS rebinding is out of scope for v1; this blocks
// the obvious literal-IP and localhost cases.
const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '127.0.0.1', '::1', 'metadata.google.internal']);

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;                        // 10.0.0.0/8
  if (a === 127) return true;                       // loopback
  if (a === 169 && b === 254) return true;          // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 0) return true;
  return false;
}

/**
 * Validate a remote MCP server URL before storing/connecting. Requires HTTPS
 * and rejects private/loopback/metadata hosts (SSRF guard). Returns a reason
 * string when invalid so the API can surface it.
 */
export function validateRemoteMcpUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'Enter a valid URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'MCP server URL must use https.' };
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || isPrivateIpv4(host)) {
    return { ok: false, reason: 'That host is not allowed (private/loopback addresses are blocked).' };
  }
  return { ok: true, url: parsed.toString() };
}
