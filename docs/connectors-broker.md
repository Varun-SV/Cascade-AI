# Connect broker — one-click connectors with our own OAuth apps

Some services publish a hosted MCP server but their OAuth **cannot self-register a
client** (no [Dynamic Client Registration, RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)).
**GitHub is the canonical case**: its hosted MCP server at
`https://api.githubcopilot.com/mcp/` authenticates with a user token, but you can
only obtain that token through a **pre-registered** OAuth App. So the automatic,
zero-config OAuth flow in [`mcp-oauth.ts`](../cloud/server/src/mcp-oauth.ts) —
which relies on discovery + DCR — can't reach it, and GitHub falls back to
"paste a Personal Access Token."

The **connect broker** closes that gap without asking the user for a token: **we**
register one OAuth app per provider and run the handshake ourselves.

## How it works

1. **We register an OAuth app** with the provider (one-time, manual) and set its
   credentials as server-side env — for GitHub, `CONNECT_GITHUB_CLIENT_ID` and
   `CONNECT_GITHUB_CLIENT_SECRET`. The secret **never leaves the server**.
2. The connector directory advertises the connector as `broker: true` only when
   both env vars are present (`brokerConfigured`). Otherwise the UI shows the
   normal token-paste form — **fully backward-compatible**.
3. **`POST /api/connect/:provider/start`** (session-authed) mints a single-use
   `state`, stores a pending flow `{ userId, providerId }`, and returns the
   provider's `authorize` URL. The browser navigates there.
4. The user approves on the provider's consent page. The provider redirects to
   **`GET /api/connect/:provider/callback?code&state`**.
5. The callback looks up the pending flow by `state` (CSRF + user binding; it must
   match the provider it was minted for), exchanges the `code` for a user token
   **server-side with the client secret**, stores it **encrypted** in the existing
   `mcp_servers` table (`oauth_json`) pointed at the provider's hosted MCP URL,
   and redirects back to the web app with `?mcp=connected`.
6. Runs pick the token up through the existing
   [`resolveRunMcpServers`](../cloud/server/src/mcp-oauth.ts) path — decrypt →
   `Authorization: Bearer <token>` → the provider's MCP endpoint.

It is a **confidential client**: the token exchange carries the client secret, so
`state` alone is sufficient anti-forgery — no PKCE.

## Registering the GitHub OAuth App

Create a **new, dedicated** OAuth App (do *not* reuse the login app — login only
needs `read:user`, connectors need repo access):

- **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
- **Authorization callback URL:** `<OAUTH_REDIRECT_BASE_URL>/api/connect/github/callback`
  (same host as the login callback, `…/auth/github/callback`).
- Set `CONNECT_GITHUB_CLIENT_ID` and `CONNECT_GITHUB_CLIENT_SECRET` on the cloud
  server. Scopes are requested at authorize time (`repo read:org read:user`), not
  at registration.

## Adding another provider

Add an entry to `BROKER_PROVIDERS` in
[`connect-broker.ts`](../cloud/server/src/connect-broker.ts) (authorize/token
URLs, scopes, hosted MCP URL, and the two env-var names) and register the app.
Everything else — routes, storage, run injection, UI — is provider-agnostic.

## Not this

We deliberately do **not** re-host the providers' MCP servers ourselves. The
vendor hosts a better one, and proxying every user's data through us would be a
needless liability. The broker owns only the **auth handshake**; the data path
stays vendor → user token → vendor's MCP server. Providers that already support
DCR (Notion, Linear, Sentry, Stripe, Atlassian) need no broker at all.
