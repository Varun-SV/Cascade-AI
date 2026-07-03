# Cascade AI — Roadmap

Deferred designs from the v0.13 feature round. Each item below has a sketched
approach grounded in the current codebase, so any of them can be picked up
without re-discovery.

## Hard sandbox for LLM-authored dynamic tools — ✅ shipped in v0.14.0

Dynamic tools now run in an `isolated-vm` hard V8 isolate (no Node globals),
reaching the host only through the escalator-gated `callTool` / SSRF-guarded
`fetch` bridges, with a graceful fall back to the worker sandbox when the
optional native addon is unavailable (`tools.dynamicToolSandbox`,
`src/tools/tool-creator.ts`).

**Still open — OS-level jail for real-process execution (own PR).** `shell`
(`child_process.exec`, `src/tools/shell.ts`) and the `run_code` interpreter
(real Python/Node, `src/tools/interpreter.ts`) remain approval-gated but
unconfined at the OS level. A WASM/V8 isolate can't run those — they need real
runtimes — so the jail is per-platform process confinement:

- **Linux — bubblewrap (`bwrap`)**, first target. Unprivileged user-namespace
  jail, no daemon, no setuid: bind the workspace read-write, `/` read-only,
  tmpfs `/tmp`, no network by default (opt-in per approval). The command line
  wraps the existing spawn, so the approval gate and allow/blocklists are
  unchanged.
- **macOS — `sandbox-exec`** Seatbelt profiles (deprecated-but-working; what
  Bazel/Chromium use): a generated profile allowing workspace writes + read-only
  system paths, network denied by default.
- **Anywhere — Docker/Podman fallback** when a daemon is available: a slim
  python+node image, workspace bind-mount, `--network=none` by default.
  Heaviest but fully cross-platform.
- **Windows — off-with-warning** initially (Job Objects/AppContainer are
  hard mode; WSL2 + bwrap is the pragmatic route for developers who want it).

Config sketch: `tools.processJail: 'auto' | 'bwrap' | 'sandbox-exec' |
'docker' | 'off'` — `auto` probes for an available jailer at startup and logs
which one is active; `off` keeps today's behavior. The jail is confinement ON
TOP of approvals, never a replacement for them.

## Project knowledge graph (world-state v2) — ✅ shipped in v0.14.0

`WorldStateDB` now has a queryable `facts(entity, relation, value,
source_worker, timestamp)` store with upsert/supersede semantics, populated by a
best-effort extraction pass on each T3 completion; T1 folds relevant deduped
facts into planning instead of replaying the whole linear log
(`src/core/knowledge/world-state.ts`). Encryption/key handling carried over
unchanged.

**Still open — cross-session history-research subagent (own PR).** A read-only
"history researcher" pass that, before planning an edit or review, briefs T1 on
prior related work so earlier intent isn't lost between sessions. Design:

- **Sources we already have:** the session store's full transcripts
  (`MemoryStore.searchMessages`, `src/memory/store.ts`) and the queryable facts
  DB (`WorldStateDB.getFormattedKnowledge`) — no new storage needed.
- **Shape:** a bounded, read-only research step inside `decomposeTask`
  (`t1-administrator.ts`): derive entities from the prompt, pull matching prior
  messages + facts, and distill a short "prior work brief" (one cheap T3-tier
  call) that is prepended to the decomposition prompt alongside PROJECT
  KNOWLEDGE. Config-gated (`knowledge.historyResearch`), off for Simple runs.
- **External index (optional, later):** an adapter tool that shells out to
  `ctx` (https://github.com/ctxrs/ctx) when installed, for cross-repo /
  cross-agent session search beyond our own store. Soft dependency, feature
  detection, never required.

## VSCode / JetBrains extensions

**Today:** no extension code exists, but everything an IDE side-panel needs is
already served: the `web/` dashboard SPA (ReactFlow agent graph, session list,
log viewer) and the dashboard server's REST + socket surface (`/api/runtime`,
`runtime:update`, `tier:status`, JWT auth).

**Plan:** a thin `cascade-vscode` extension hosting the existing web dashboard
in a WebviewPanel, pointed at the local dashboard port with the stored token —
the Live Agent Tree in the editor without duplicating any UI. JetBrains follows
with the same embedded-web approach (JCEF).

## Multi-plan branching

**Today:** T1 produces exactly one `TaskPlan`; the boardroom gate
(`t1-administrator.ts`) supports approve / edit / steer-and-replan rounds on
that single plan.

**Plan:** have `decomposeTask` generate N candidate plans (temperature-varied
or explicitly diversified), extend `PlanApprovalDecision` with a
`chosenIndex`, and render candidates side-by-side in the CLI plan-approval UI
and the desktop. "Fork the session and explore two approaches in parallel"
builds on `store.branchSession` once plan selection exists.

## Smaller follow-ups

- **Session-persistent steering history** — surface past `/steer`
  interventions in the session transcript (they're already in the audit log).
- **Redaction customization** — user-defined redaction patterns in config,
  extending `RedactionLayer.RULES`.
- **Privacy-tier telemetry** — a per-run report of which subtasks ran
  local-only and what was withheld.
