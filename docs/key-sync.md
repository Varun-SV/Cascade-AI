# Key sync — settings that follow your account

Once signed in (see [`native-auth.md`](native-auth.md)), a user's settings can
follow them across **web · desktop · CLI** — encrypted end-to-end, with the
server acting only as a **ciphertext relay it cannot read**. This replaces the
previous Google Drive appData sync with an account-based one.

> Design + security only. No secrets, keys, or attacker-useful values live here.

## The one rule: the server never sees plaintext

- The bundle is encrypted **on the device** with a **passphrase only the user
  knows**, using AES-256-GCM with a PBKDF2-SHA256 (210k iters) derived key —
  the exact parameters the web KeyVault already uses (`cloud/web/src/keys/crypto.ts`),
  so a blob written by one client decrypts on any other.
- The server stores **one opaque encrypted envelope per user** and hands it back
  verbatim. It has no passphrase and cannot decrypt it. Compromising the server
  yields ciphertext only.
- The passphrase **never leaves the device**. It is transient on the web
  (re-entered per session), and may be cached in the OS keychain on desktop
  (Electron `safeStorage`) / `~/.cascade-ai` (`0600`) on the CLI if the user
  opts in.

## Why replace Google Drive?

Drive sync required a second Google authorization (`drive.appdata`) and a Google
account specifically. Routing the same ciphertext through the Cascade account
the user already signed into removes that extra grant, works for GitHub sign-ins
too, and reaches the desktop + CLI (which never had Drive sync). **No data is at
risk in the switch**: keys live locally on the device that configured them; the
account only becomes the new transfer channel. The Drive code path is removed.

## The synced bundle

A single versioned object, encrypted as one blob:

| Field | What | Secret? |
| --- | --- | --- |
| `providers` | LLM provider keys (per-provider API keys / endpoints) | yes |
| `webSearch` | Web-search backend keys (Brave / Tavily) + SearXNG URL | yes |
| `mcp` | MCP server / connector tokens | yes |
| `prefs` | Non-secret preferences (per-tier params, max-tokens, routing bias, …) | no |

`prefs` is bundled for convenience but carries nothing sensitive; the secret
fields are why the whole blob is E2E-encrypted.

## Flows

Sync is **manual and explicit** (Push / Pull), never a silent background
overwrite — the same shape as the Drive panel today.

- **Push**: gather this device's settings → `encryptJSON(bundle, passphrase)` →
  `PUT /api/keysync` (the ciphertext envelope + a monotonically increasing
  `version`).
- **Pull**: `GET /api/keysync` → `decryptJSON(blob, passphrase)` → apply to this
  device's local settings. A wrong passphrase fails the AES-GCM auth-tag check
  and is reported as "check your passphrase", never a crash.
- **Forget**: `DELETE /api/keysync` removes the stored envelope.

Conflict handling is last-write-wins with the stored `version`/`updated_at`
surfaced to the user ("synced 3m ago"), so a Pull-before-Push habit avoids
clobbering a newer device.

## Endpoints (server = ciphertext relay)

| Method · Path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/keysync` | session (cookie or Bearer) | Return the stored envelope + `version`/`updatedAt`, or empty |
| `PUT /api/keysync` | session | Store/replace the envelope (opaque ciphertext) |
| `DELETE /api/keysync` | session | Forget the stored envelope |

The envelope is stored in a `user_secrets` row (`user_id` PK, `blob`, `version`,
`updated_at`). `blob` is the `{ ciphertext, salt, iv }` triple, all base64 — the
server treats it as an opaque string and enforces a size cap.

## Security

- **E2E**: server + transport see ciphertext only; the key is passphrase-derived
  on-device and never transmitted.
- **Crypto**: AES-256-GCM (authenticated), PBKDF2-SHA256 210k, random 16-byte
  salt + 12-byte IV per push. Byte-compatible across WebCrypto and Node so the
  same blob round-trips between clients.
- **Auth**: every route requires the signed-in session; a user can only read or
  write their own envelope.
- **Caps**: the stored envelope is size-limited; the passphrase is never logged.
- **No secret in transit or at rest** on our side is ever readable.

## Clients

- **Web** — `AccountSyncPanel` (Push / Pull, replaces `DriveSyncPanel`) in the
  KeyVault. Passphrase transient per session.
- **CLI** — `cascade sync push` / `cascade sync pull` (prompts for the
  passphrase; optional local cache under `~/.cascade-ai`, `0600`).
- **Desktop** — Push / Pull from the account surface; passphrase optionally
  cached in `safeStorage`.

## References

- `cloud/web/src/keys/crypto.ts` — the shared crypto parameters (ported to Node,
  byte-for-byte, in the SDK for the CLI/desktop).
- [`native-auth.md`](native-auth.md) — the sign-in this builds on.
