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
}

// Curated connectors. GitHub publishes a universal hosted MCP server, so its
// URL is fixed and a Personal Access Token is all that's needed. Slack/Google
// don't expose a single token-based endpoint, so they're "bring your MCP URL"
// presets — the framework is identical, the user just supplies the endpoint of
// the MCP bridge they run for that app.
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
