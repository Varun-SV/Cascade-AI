# Native login & session continuity

Optional sign-in for the **desktop app** and **CLI** that reuses the cloud
server's OAuth, so a user can carry sessions and settings from the web onto
their machine — **without any OAuth client secret ever shipping in a native
app**.

> This document describes design + security only. It contains no secrets,
> endpoints, or values that aid an attacker, and is updated as each phase lands.

## The one rule: no secret in the client

A desktop app or CLI is a **public client** — anyone can unzip the bundle and
read whatever's inside, so a client secret can't be secret there. Instead of
hiding one, we remove the need for one:

- The cloud server is already a **confidential** OAuth client (it holds the
  Google/GitHub client secrets and does the code→profile exchange).
- Native clients authenticate **against the cloud server**, which runs the
  existing web OAuth on their behalf. Provider secrets never leave the server.
- **PKCE** (RFC 7636, S256) proves the client that started a flow is the one
  redeeming the code — the job a secret would otherwise do.

Because the browser leg reuses the existing web callback, **Google/GitHub never
see the loopback redirect**, so there are **no provider-console changes**.

## Two flows

### Loopback (desktop) — RFC 8252

1. The app opens a local listener on `http://127.0.0.1:<random-port>` and makes
   a PKCE verifier + challenge.
2. It opens the system browser to `GET /auth/native/:provider` with the loopback
   `redirect_uri`, the `code_challenge`, and an app `state`.
3. The server runs the normal web OAuth; the **shared callback** detects the
   pending native flow (keyed by the validated OAuth state) and 302s a one-time
   code to the loopback listener.
4. The app posts the code + PKCE verifier to `POST /api/native/token` and gets
   an access + refresh token.

### Device code (CLI) — RFC 8628 shape

1. `POST /api/native/device` → `{ device_code, user_code, verification_uri,
   interval, expires_in }`.
2. The CLI prints "enter `WXYZ-1234` at `/activate`" and polls
   `POST /api/native/device/token`.
3. The user opens `/activate` (must be signed in on the web) and approves the
   `user_code` → `POST /api/native/device/approve`.
4. The next poll returns the tokens.

## Token model

| Token | Form | TTL | Sent as | Stored |
| --- | --- | --- | --- | --- |
| Access | JWT (`aud: "native"`, same signer as the web session) | ~1 hour | `Authorization: Bearer` | memory / short-lived |
| Refresh | Opaque random, **hashed at rest**, **single-use (rotates)** | ~60 days | `POST /api/native/refresh` | Encrypted via Electron `safeStorage` — OS keychain / DPAPI, or an AES-256-GCM key file `0600` where no keyring exists (desktop) · `~/.cascade-ai/cloud-session.json` `0600` (CLI) |

`sessionMiddleware` accepts `Authorization: Bearer` in addition to the web
cookie, so every existing authed route serves native clients unchanged.

## Endpoints (Phase 1 — server)

| Method · Path | Auth | Purpose |
| --- | --- | --- |
| `GET /auth/native/:provider` | none → provider | Start the loopback flow (validates loopback `redirect_uri` + PKCE) |
| `POST /api/native/token` | PKCE | Redeem the one-time loopback code → tokens |
| `POST /api/native/device` | none | Start the device flow |
| `POST /api/native/device/token` | device_code | Poll → `authorization_pending` / `slow_down` / tokens |
| `POST /api/native/device/approve` | web session | Approve a `user_code` (bound to the signed-in user) |
| `GET /activate` | web session (optional) | Self-contained device-approval page |
| `POST /api/native/refresh` | refresh token | Rotate → fresh tokens |
| `POST /api/native/logout` | refresh token | Revoke the presented refresh token |

Ephemeral artifacts (pending loopback state, one-time codes, device codes) live
in an in-memory, self-expiring store (like `handoff.ts`). Refresh tokens persist
in SQLite, hashed.

## Security

- **PKCE S256** per attempt; the code redeems only with the matching verifier.
- **CSRF**: an opaque OAuth `state`, validated against its cookie.
- **Loopback**: exact `127.0.0.1` / `::1` / `localhost` **http** only — never a
  public URL; one-time code, ≤60 s TTL, single-use.
- **Device**: short TTL, rate-limited polling (`slow_down`); `/activate`
  requires a web session so approval binds to a real user.
- **Tokens**: short access TTL + rotating single-use refresh; refresh hashed at
  rest; logout revokes; `revokeAllRefreshTokens` supports account switching.
- **Never** in the client: no provider secret, no provider token, no password.

## Key sync (built on this login) — decided, upcoming

Once signed in, a user's settings follow them across web/desktop/CLI:

- **End-to-end encrypted**, passphrase per device (AES-GCM + PBKDF2, reusing the
  web KeyVault's `keys/crypto.ts` parameters so blobs interoperate). The
  passphrase never leaves the device (cached in the OS keychain); the server
  stores **only ciphertext it cannot read**.
- **Transport**: the Cascade account (server = ciphertext relay).
- **Scope**: LLM provider keys, web-search backend keys, MCP/connector tokens,
  and non-secret preferences.

## OAuth-based MCP connectors — decided, upcoming

For MCP servers that support the MCP Authorization spec (OAuth 2.1 + PKCE +
dynamic client registration), "Connect" runs an OAuth flow (login + authorize)
instead of pasting a token — the same broker/loopback machinery as above.
Token-paste remains the fallback for servers without OAuth.

## Phasing

1. **Server** — native-auth endpoints + Bearer support. ✅ implemented
2. **CLI** — `login` / `logout` / `whoami` / `sessions` (+ `sessions show <id>`).
   Device flow; access + rotating refresh token stored at
   `~/.cascade-ai/cloud-session.json` (0600). Server URL via `--server` /
   `CASCADE_CLOUD_URL` (default `app.cascadeai.in`). ✅ implemented.
   *Follow-up (2b): resume a pulled cloud chat live in the REPL.*
3. **Desktop** — sign-in (loopback flow) + browse/continue cloud chats. ✅
   implemented. The Electron **main process** runs the loopback dance via the
   shared `CloudClient.runLoopbackLogin` (system browser + a one-shot
   `127.0.0.1` listener + PKCE), opening the provider with `shell.openExternal`.
   Tokens are encrypted at rest with `safeStorage` (AES-256-GCM key-file
   fallback where no keyring exists) and exposed to the renderer over a narrow
   `cloud:*` IPC surface (`status` / `login` / `logout` / `sessions` /
   `messages`) — the renderer never touches a token. Sign-in and a **Your cloud
   chats** browser are folded into the existing *Continue elsewhere* modal;
   "continue here" imports a cloud transcript as a new local session via the
   backend's `/api/import`, mirroring the code-based handoff.
4. **Key sync** (E2E blob through the account).
5. **OAuth-MCP connectors**.

## References

- RFC 8252 (OAuth for Native Apps) · RFC 7636 (PKCE) · RFC 8628 (Device Grant)
- MCP Authorization spec (OAuth 2.1) for connector login.
