# Changelog

All notable changes to Cascade AI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-06-14

### Added
- **Live benchmark-aware Cascade Auto** — when a tier is set to Auto, each task is
  routed to the model that is the best *value* (quality × cost-efficiency) for its
  type, using **current** public data. Quality scores come from a hybrid source
  (live GitHub-raw snapshot → on-disk cache → bundled table); per-token prices come
  live from OpenRouter (free, no key). All fetching is background and time-boxed —
  fully offline-safe.
- **Live model discovery** — each configured provider's live model list is queried
  on startup so newly released models are usable and stale catalog ids are caught.
- **`autoBias` config** (`balanced` default · `quality` · `cost`) to tune the
  cost/quality trade-off, plus a `benchmarks` config block (live toggle, refresh
  interval, custom source URL, pricing toggle).
- **Routing transparency** — `cascade models` shows each tier's benchmark score and
  the data source (live/cached/bundled) + pricing origin; `/why` reports the score,
  price, and data source behind each Cascade Auto pick.
- **Scheduled benchmark refresh** — a weekly workflow regenerates the bundled
  snapshot and opens a data-only PR (no version bump, so it never triggers a release).

### Fixed
- **Gemini `404 … is not found` on Auto** — the catalog mapped `gemini-2.5-flash`/
  `gemini-2.5-pro` to retired `-preview-*` ids; updated to the GA ids. The router now
  also **self-heals**: a "model not found" error drops the dead model and fails over
  to the next candidate instead of surfacing the raw error.
- **Pasting an API key inserted it twice with `[200~` markers** — Ink 6's native
  bracketed-paste handling raced our raw-stdin handler. Paste is now owned by a single
  handler, and bare (ESC-less) `[200~`/`[201~` markers are stripped as a safety net.
- **Runs could freeze with no output** — a stalled cloud stream (TCP open, no terminal
  chunk) or an unanswered tool-approval prompt awaited forever. Cloud LLM calls are now
  time-boxed (`cloudInferenceTimeoutMs`, default 2 min) and approval waits deny on timeout
  (`approvalTimeoutMs`, default 10 min), so one stuck call can no longer hang the whole run.

## [0.5.7] - 2026-06-13

The first tagged release since v0.5.5 — it rolls up the v0.5.6/v0.5.7 work plus
two feature/fix tracks that landed on top of it.

### Added
- **Delegation savings counter** — live `saved $X (Y%) vs. all-T1` in the StatusBar
  and `/cost`, plus a per-run receipt.
- **Agent comms feed (`/comms`)** — live ticker of PeerBus traffic (peer messages,
  broadcasts, file locks, barrier syncs).
- **`/why`** — per-run decision trail: complexity verdict + reason, models per tier,
  provider failovers, and permission escalations.
- **Boardroom plan gate** (`planApproval: "always"`) — approve the org chart before
  any T2 spawns (opt-in; default unchanged).
- **`--alt-screen`** — opt-in vim-style alternate screen with in-app PgUp/PgDn history.
- **`/copy [n]`** — copy a response via native clipboard tools with an OSC 52 fallback.
- **`cascade link`** — reuse credentials from Claude Code / Codex / Gemini CLI /
  Copilot (API keys adopt directly; subscription OAuth tokens only with `--accept-risk`).
- **Benchmark-aware model routing** — selecting "Auto" now enables Cascade Auto and a
  curated public-benchmark table routes each subtask to the model strongest at its
  type (per-subtask, cross-provider; local-only tiers pick the best local model).
- **Per-task budget ceiling** (`budget.maxTokensPerRun`, default 200k) stops runaway
  spend with a graceful partial result.
- **Runtime tool persistence & sharing** — created tools are saved to
  `.cascade/dynamic-tools.json` (reloaded next run), deduped by capability, and
  broadcast over the peer bus.

### Changed
- **Ink 5 → 6.8, React 18 → 19** (both workspaces); Node engines floor raised to **20**.
- **Flicker-free rendering** — `computeLiveAreaBudget()` shrinks panels before Ink
  redraws the whole screen; height-capped panels; terminal resize handling.
- Installs are now deterministic — `package-lock.json` and `web/package-lock.json`
  are committed (fixes the `ERESOLVE` seen when upgrading an existing checkout).
- Read-only inquiries ("read/explain/analyze this file") classify as **Simple**
  (single agent) instead of fanning out into the full hierarchy; the classifier
  error-path defaults to Moderate, not Complex.
- The text-tool fallback for non-native models carries full schema (enums, required)
  and parses tool calls far more tolerantly; tool-call arguments are validated first.

### Fixed
- **Security hardening** — dashboard network exposure, `web_fetch` SSRF, approval
  gaps, and code-interpreter injection; plus 10 issues from the ORACLE audit.
- **Slash-command popup** no longer corrupts while scrolling (constant row count,
  full-width rows).
- A trivial "read the README" task could fan out and **hang ~5 min / burn 655K
  tokens** — fixed via the classification change, the per-task cap, and gating
  file-lock coordination to write tasks with a timeout.
- **Tool creation** surfaces failures instead of swallowing them and wraps generated
  schemas into valid JSON Schema so created tools work across providers.
- Startup now warns on a stale build (compiled bundle version ≠ source), and
  `bin/cascade.js` prints a friendly "run `npm install && npm run build`" on a
  missing `dist/`.

## [0.5.6] - 2026-05-24

### Changed
- TUI visual redesign.

### Fixed
- Azure setup-wizard flow.
- StatusBar background-strip rendering.

## [0.5.5] - 2026-05-23

### Fixed
- Init wizard tier-model picker scrolls (`limit={8}`) instead of overflowing.
- Chat scrolling restored — stopped enabling mouse-reporting on mount (a v0.5.4
  regression) so the terminal's native scrollback works again.
- Slash-command suggestion panel — `wrap="truncate"` on descriptions + one extra
  row of fixed height so long entries don't squish onto one line.

## [0.5.4] - 2026-05-23

### Added
- `--alt-screen` precursor work: `<Static>`-based conversation rendering so completed
  messages go to native scrollback and only the live area re-renders.
- Auto-clear of the agent tree 8 s after a task completes.

### Changed
- `tier:status` throttled to 100 ms; `React.memo` on `AgentTree` / `StatusBar` / `HintBar`.

### Fixed
- Maximized-terminal flicker on cmd / PowerShell.
- Orchestrator resilience: new `CriticalToolError` (stops the agent loop on
  rate-limit/auth errors instead of retrying 15×) and `WorkerStallError` (carries
  partial output); T1 now surfaces the real root cause when all sections fail.

## [0.5.3] - 2026-05-23

### Added
- Headless `cascade run` / `-p` — bypasses the Ink REPL in non-TTY contexts
  (CI, pipes, scripts); progress to stderr, answer to stdout.

### Fixed
- `cascade models` column layout; `/clear` also resets cost maps; richer `/config`
  output with an undefined-`dashboard` guard.

## [0.5.2] - 2026-05-22

### Added
- Redesigned first-run setup wizard (welcome header, phased step tabs, field boxes).
- New tools — `glob`, `grep`, `web-fetch` — plus a model-performance tracker.

### Fixed
- Removed an accidental `cascade-ai` self-dependency; corrected `/tree` and
  `/sessions` descriptions; fixed stale T2/T3 test mocks.

---

Older releases (v0.1.1 – v0.4.0): see the
[GitHub Releases](https://github.com/Varun-SV/Cascade-AI/releases) page.

[0.5.7]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.7
[0.5.6]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.6
[0.5.5]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.5
[0.5.4]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.4
[0.5.3]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.3
[0.5.2]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.2
