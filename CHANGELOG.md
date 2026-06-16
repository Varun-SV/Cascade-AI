# Changelog

All notable changes to Cascade AI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.5] - 2026-06-16

Dependency-hardening pass (safe + tested bumps only) plus a tool-generation correctness fix
surfaced while auditing the tool system.

### Fixed
- **Runtime tool generation was broken for any tool that did I/O.** `ToolCreator` validates
  generated code with a syntax check before registering it, but compiled it as a *synchronous*
  function while the runtime executes it inside an `async` IIFE. Every generated tool that used
  `await callTool(...)` or `await fetch(...)` — i.e. essentially all useful tools, including the
  generator prompt's own `file_read` example — was rejected as "await is only valid in async
  functions" and silently discarded. The check now validates with `AsyncFunction` semantics.

### Security / Dependencies
- **Cleared the `ws` DoS advisory (GHSA-96hv-2xvq-fx4p) on the server side.** Added an
  `overrides` pin of `ws` to `^8.21.0` (patched), unifying the socket.io server chain on the
  fixed release. This removes the 3 high-severity server-side findings; the only residual `ws`
  node is the **browser** socket.io-client, where the Node `ws` library is never executed
  (browsers use the native `WebSocket`), so it is not exploitable in the shipped dashboard.
- **Removed the unused `uuid` dependency.** Cascade generates IDs with `node:crypto.randomUUID`
  and never imported the `uuid` package — it was a vestigial direct dependency.
- **Safe in-range refreshes** (semver-compatible, full suite + build verified): `better-sqlite3`
  → 12.11.1, `undici` → 6.27.0, `playwright` → 1.61.0, `@tanstack/react-virtual` → 3.14.3.
- **Deferred (intentionally not forced):** the remaining audit findings all require *breaking*
  major upgrades and are tracked for a dedicated pass — runtime: `@anthropic-ai/sdk`, `node-cron`,
  `node-notifier`, transitive `uuid` (via the two former); dev/build-only and never shipped to
  npm consumers: `vitest`/`vite`/`esbuild`/`tsup`/`vite-node`. Production-only `npm audit` is down
  to 8 (from a chain of ws-driven highs), and none of the residual highs are reachable at runtime.

### Tests
- Added `src/tools/tool-creator.test.ts` (8 cases) — the tool-generation capability previously had
  **no coverage**, which is how the async-syntax-check regression shipped. Covers schema
  normalization, pure-compute generation, `await callTool()` (regression guard), the SSRF guard on
  the sandboxed `fetch`, syntax-error rejection, capability dedup, and dangerous-tool escalation.

## [0.9.4] - 2026-06-16

### Fixed
- **Cancellation is now near-instant.** The run's abort signal is threaded into the provider
  calls themselves (anthropic / openai / azure / gemini / ollama), so Ctrl+C/ESC aborts the
  **in-flight** request instead of only stopping between LLM calls — a real run cancelled in
  **~31 ms** vs. ~38 s before. Provider `AbortError` is converted to a graceful cancel (partial
  output preserved, no error surfaced), and a rapid double-press can no longer be dropped (the
  cancel-armed flag is read from a ref, not stale React state). A `⊘ Cancelling…` indicator shows
  immediately.
- **Cascade Auto no longer overrides an explicitly-configured model.** Auto only routes tiers
  left on `auto`, and its per-task picks are restored after each run — so `/why`, the status bar,
  and the next run reflect your configured models (the missing `restoreTierModels`).
- **Slash commands show immediate feedback.** A command is echoed the moment you press Enter, and
  a `⠋ Running command…` indicator shows while async ones (e.g. `/plan`) work.
- **Slash commands are excluded from up-arrow history** — recalling prompts no longer gets stuck
  on the last `/command` or triggers scroll.

## [0.9.3] - 2026-06-16

### Security
- **Dropped axios entirely.** The pinned axios 1.13.6 carried ~24 HIGH advisories (SSRF,
  prototype-pollution credential theft, proxy-auth leakage). Rather than upgrade it (which
  conflicts with the project's long-standing axios pin), the **4 runtime call sites were
  migrated to native `fetch`** — the Ollama provider (streaming via the async-iterable
  response body), the GitHub/GitLab tool (status-aware error handling preserved), webhook
  notifications, and `cascade doctor` — and **`posthog-node` was bumped to v5**, which no
  longer depends on axios. `axios` is now absent from the dependency tree (`npm ls axios` is
  empty), and the shipped CLI is axios-free.

### Notes
- The remaining `npm audit` findings are pre-existing transitive / dev-only dependencies that
  each need a breaking major bump, so they're deferred (out of scope for the axios pass) to
  avoid a breaking-change cascade pre-1.0: **esbuild** (build/dev-server only — not shipped to
  CLI users), **ws** and **uuid** (transitive via socket.io / node-cron / @google/genai / ink),
  and **@anthropic-ai/sdk** / **diff**.

## [0.9.2] - 2026-06-16

### Added
- **Ctrl+C / ESC now cancel the running task** instead of only quitting. While a task is in
  progress: the first Ctrl+C warns ("press again to cancel the task"), the second **cancels the
  run** and keeps Cascade open; **ESC cancels outright**. When idle, Ctrl+C keeps its old
  double-press **quit** behavior. The run's partial output is preserved (a `⊘ Task cancelled`
  note is shown). Wires the REPL to the existing `AbortSignal` cancellation path
  (`cascade.run({ signal })` → `run:cancelled`).

## [0.9.1] - 2026-06-15

### Added
- **T3→T2 reinforcement request** (`reinforcements.enabled`, off by default) — a worker that
  discovers its subtask should fan out can call a new **`request_workers`** tool to have its
  **manager spawn bounded sibling workers** for the new pieces. No 4th tier: the new workers are
  ordinary siblings under the same T2 (so they honor `t3Execution`), bounded by
  `reinforcements.maxPerSection` (default 4) and **depth-1** (reinforcement workers can't request
  more). This is the lighter replacement for sub-agent spawning — the T1/T2/T3 tiers are already
  an agent hierarchy, so a recursive 4th tier was redundant and risked local-Ollama contention.

### Docs
- Refreshed the landing page (`index.html`) and `README.md`.

## [0.9.0] - 2026-06-15

Resumability, reflection, and smarter local execution.

### Added
- **Run resumability** + **`/continue [tokens]`** — when a task stops at the budget cap, resume
  it with a raised budget instead of redoing it. Files already created persist on disk (via
  snapshots), so only the remaining work runs. `Cascade.resumeRun()` for SDK use.
- **Reflection / self-critique** (`reflection.enabled`, off by default) — after a worker's
  pass/fail self-test, an optional **goal-alignment** critique revises the output once if it
  falls short of the intent (distinct from, and on top of, the self-test).
- **`t3Execution`** (`'auto'` default · `'parallel'` · `'sequential'`) — T3 waves now run
  **sequentially for a local (Ollama) tier** (a single GPU serializes anyway, so parallel just
  thrashed the queue and risked slot-wait timeouts) and **parallel for cloud**. Force either if
  you prefer.

### Notes
- New config: `reflection`, `t3Execution`. Sub-agent spawning was re-scoped to a lighter
  "T3→T2 reinforcement request" for a later release (the T1/T2/T3 tiers are already an agent
  hierarchy, so a 4th tier was redundant and brought local-deadlock risk).

## [0.8.0] - 2026-06-14

Agentic controls — autonomy, smarter re-planning, and new slash commands (sub-agent
spawning follows in v0.9.0).

### Added
- **Autonomous mode** + **`/auto [on|off|status]`** — hands-off runs: the plan gate
  auto-approves and **non-dangerous** tools run without prompts, while **dangerous** tools
  still escalate and budget caps remain the hard stop. Config: `autonomy: 'manual' | 'auto'`.
- **Dynamic re-planning with early-stop** — T1's reviewer loop now **stops early when a
  corrective pass makes no net progress**, returning the best partial result instead of
  burning passes (and tokens) toward the budget cap. Config: `maxReplanPasses` (default 2).
- **`/plan <prompt>`** — preview T1's decomposition **without executing it** (the command
  deferred from v0.7.0).
- **`/replan [guidance]`** — re-run the last task with a corrective/steering framing.

### Notes
- New config: `autonomy`, `maxReplanPasses`. All slash commands registered in `/help`.
- Motivated by a real run that burned ~115 min before the budget cap stopped it; early-stop
  cuts that short when work isn't converging.

## [0.7.0] - 2026-06-14

Plan-review upgrade — the boardroom gate becomes a real review loop (the agentic
features — dynamic re-planning, autonomous mode, sub-agent spawning — follow in v0.8.0).

### Added
- **Iterative plan revision** — a steering note now re-plans **and re-asks**, so the
  board can refine T1's plan across multiple rounds (capped by `planReview.maxRevisionRounds`,
  default 5) instead of a single take-it-or-leave-it pass.
- **Automated plan reviewer** — with `planReview.autoReviewer`, a reviewer model critiques
  the plan (risks, gaps, over-/under-decomposition) and the critique is shown in the approval
  dialog before you decide.
- **Editable plan** — drop sections inline in the approval dialog (↑/↓ to move, `x` to drop,
  `m` to add a steering note); the edited plan runs directly without a re-decompose.
- **Wider gate** — `planApproval` gains `'complex'` and `'all'` (`'always'` kept as an alias);
  `'all'` also gates **Moderate** runs, pausing to review the worker decomposition before any
  worker spawns. (`planReview.editable` toggles inline editing.)

### Notes
- `planApproval` accepts `'never' | 'complex' | 'all' | 'always'`; new `planReview` config block.
- An on-demand `/plan` preview command is planned for a follow-up.

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
