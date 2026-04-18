# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-18

First release after the full codebase audit. Includes breaking-ish behaviour
changes for stricter sandboxing, so bumped as a minor release while pre-1.0.

### Security
- **Shell allowlist** now matches the first token exactly; prefix bypass
  (e.g. allowlist `["npm"]` accepting `npm-foo`) is closed.
- **Hooks runner** switched from `exec` to `execFile` with a sanitized env
  map; tool input can no longer inject shell commands through env vars.
- **`.cascadeignore`** now uses gitignore semantics via the `ignore` package;
  the old substring match (e.g. `node_modules` matching `mynodemodules.js`)
  is gone.
- **File tools** route every path through a new workspace sandbox helper
  that rejects traversal and out-of-workspace absolute paths.
- **Dashboard auth** uses bcrypt hashes plus `crypto.timingSafeEqual`, with
  `express-rate-limit` on `/api/auth/login` (5 / 15 min) and a persisted
  JWT secret at `.cascade/dashboard-secret` (0600).
- **MCP servers** now require an approval callback before `StdioClientTransport`
  spawns; trusted servers are persisted and bare-name collisions warn instead
  of silently overwriting.

### Added
- **OS keychain keystore** via `keytar` (optional native dep) with the
  existing AES-256-GCM file as fallback. Migration copies entries across
  on first unlock; file stays as a backup until the user opts to delete.
- **Per-provider token-bucket rate limiter** (`TpmLimiter`) for TPM control
  across Anthropic/OpenAI/Gemini/Ollama.
- **Hard budget kill switch** — `router.halt()` rejects pending generate
  calls and emits `budget:exceeded` once the cap is reached.
- **Slash commands**: `/rollback`, `/branch`, `/compact`, `/export` are
  fully implemented.
- **REPL approval dialog** wired to `PermissionEscalator` and MCP approvals.
- **Telemetry**: first-run banner and `cascade telemetry on|off|status`
  subcommand; telemetry remains off by default.
- **npm workspaces** adopted — `npm install` at the repo root now also
  installs `web/`.
- New tests covering shell, file, git, registry, workspace-path, hooks,
  anthropic/openai providers, router TPM, and JSON extractor (130 tests,
  all passing).

### Changed
- T1 Administrator replaces its greedy JSON regex with a brace-balanced
  extractor that respects string literals and escapes.
- T1 listener registration is now cleaned up explicitly, closing an
  EventEmitter leak in long-lived sessions.
- `getLatestFileSnapshots()` uses a `rowid` tiebreaker so two snapshots
  recorded in the same millisecond no longer both win.

### Removed
- `AUDIT_FIXES.md` (folded into this changelog).
- `CONTRIBUTING.md` (folded into `README.md`).
- Stray `tsup.config.bundled_*.mjs` / `vitest.config.ts.timestamp-*.mjs`
  build artifacts; `.gitignore` updated to prevent recurrence.

### Fixed
- `tsup` DTS build now succeeds on systems without the optional `keytar`
  native module via a local ambient declaration.

## [0.1.2] — prior release

Baseline before the audit. See git history for details.
