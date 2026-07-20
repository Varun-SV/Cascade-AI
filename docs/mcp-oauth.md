# OAuth-based MCP connectors

Connecting an MCP server can now run an **OAuth flow** (log in + authorize)
instead of pasting a token — the same "Connect" experience as Claude/desktop
connectors. Servers that don't support OAuth keep the **token-paste** path as a
fallback.

> Design + security only. No secrets, client IDs, or endpoints that aid an
> attacker live here.

## What does the work: the MCP SDK

We do **not** hand-roll the OAuth protocol. The `@modelcontextprotocol/sdk` we
already use ships a spec-complete OAuth 2.1 client:

- **Protected-resource discovery** (RFC 9728) — from the MCP server's
  `WWW-Authenticate` / `.well-known/oauth-protected-resource`.
- **Authorization-server metadata** (RFC 8414 / OIDC discovery).
- **Dynamic Client Registration** (RFC 7591) — no pre-shared client secret.
- **PKCE** (S256) authorize + token, **refresh**, and the `resource` parameter
  (RFC 8707).

It exposes this through an `OAuthClientProvider` interface that plugs into the
HTTP transport (`new StreamableHTTPClientTransport(url, { authProvider })`) plus
`transport.finishAuth(code)`. Our job is to implement that provider's
**storage + redirect**, once, and reuse it on every surface.

## The provider (SDK, shared)

`McpOAuthProvider implements OAuthClientProvider`, backed by a small pluggable
store and a redirect strategy:

| Provider hook | What we supply |
| --- | --- |
| `redirectUrl` | Cloud: our server callback. Desktop/CLI: a `127.0.0.1` loopback. |
| `clientMetadata` | Our app's registration request (redirect URIs, name, PKCE). |
| `clientInformation` / `saveClientInformation` | Persisted DCR result (client_id). |
| `tokens` / `saveTokens` | Persisted access + refresh tokens. |
| `saveCodeVerifier` / `codeVerifier` | PKCE verifier, held across the redirect. |
| `redirectToAuthorization(url)` | Cloud: hand the URL to the browser via our start endpoint. Desktop/CLI: open the system browser. |

The **store** is the only thing that differs per environment:

- **Cloud** — server-side, per `(user, server)`, in SQLite; tokens + refresh
  tokens **encrypted at rest** with a server key (defense-in-depth for the
  persistent volume; the server still decrypts them to call the MCP server
  during a run). Pending-flow state (PKCE verifier, state) lives in a short-TTL
  in-memory store keyed by the OAuth `state`, like `native-auth.ts`.
- **Desktop** — Electron `safeStorage` (same store as native login).
- **CLI** — `~/.cascade-ai` (`0600`).

## Flows

### Cloud (browser leg on our server)

1. In *Connectors*, the user picks **Connect** on an OAuth-capable server.
2. `POST /api/mcp/oauth/start` → the server runs discovery + DCR, gets the
   authorize URL from the provider, stashes the pending flow by `state`, and
   returns the URL.
3. The browser goes to the MCP server's authorization server; the user logs in
   and consents.
4. The AS redirects to `GET /api/mcp/oauth/callback?code=&state=`. The server
   resumes the pending flow, calls `transport.finishAuth(code)` → tokens, saves
   them (encrypted) + the server row, and returns the user to the app.
5. Runs attach the (auto-refreshing) access token when calling that server.

### Desktop / CLI (loopback — RFC 8252)

1. The client opens a one-shot `127.0.0.1` listener and starts the connect.
2. The provider opens the system browser to the authorize URL; the loopback
   catches `?code=`.
3. `transport.finishAuth(code)` → tokens saved locally (safeStorage / `0600`).
4. The server is added to `config.tools.mcpServers`; the client refreshes tokens
   on 401.

## Token-paste fallback

If a server advertises no OAuth (or its AS doesn't support Dynamic Client
Registration), Connect falls back to the existing **paste-a-token** path with a
short explanation. Nothing about the current token-paste connectors changes.

## Security

- **PKCE S256** every attempt; **`state`** validated on the callback.
- **No client secret shipped**: DCR yields a per-server client registration;
  native clients are public clients proven by PKCE.
- **SSRF guard**: the existing `validateRemoteMcpUrl` (https-only, no
  private/loopback hosts) still gates every server URL.
- **At rest**: cloud OAuth tokens encrypted with a server key; desktop in
  `safeStorage`; CLI `0600`. Refresh tokens are treated like the access token.
- **Never in the client bundle**: no provider secret, no pre-shared MCP secret.

## Endpoints (cloud)

| Method · Path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/mcp/oauth/start` | session | Begin an OAuth connect; returns the authorize URL |
| `GET /api/mcp/oauth/callback` | pending-flow `state` | Finish the exchange, store tokens, add the server |

The existing `POST /api/mcp/servers` (token-paste) and list/patch/delete routes
are unchanged.

## References

- MCP Authorization spec (OAuth 2.1) · RFC 7591 (DCR) · RFC 8414 / RFC 9728
  (metadata) · RFC 7636 (PKCE) · RFC 8252 (native apps) · RFC 8707 (resource).
- Built on the sign-in machinery in [`native-auth.md`](native-auth.md).
