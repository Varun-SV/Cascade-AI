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

**Still open — OS-level jail for real-process execution.** `shell`
(`child_process.exec`) and the `run_code` interpreter (real Python/Node) remain
approval-gated but unconfined at the OS level. A WASM/V8 isolate can't run those
(they need real runtimes); the follow-up is an optional container/`bwrap`/sandbox
jail for shell and the interpreter where available.

## Project knowledge graph (world-state v2) — ✅ shipped in v0.14.0

`WorldStateDB` now has a queryable `facts(entity, relation, value,
source_worker, timestamp)` store with upsert/supersede semantics, populated by a
best-effort extraction pass on each T3 completion; T1 folds relevant deduped
facts into planning instead of replaying the whole linear log
(`src/core/knowledge/world-state.ts`). Encryption/key handling carried over
unchanged.

**Adjacent idea — cross-session history research.** A read-only "history
researcher" subagent that, before an edit or review, briefs the planner on prior
decisions/intent around a module — potentially backed by an external session
index (e.g. `ctx`, https://github.com/ctxrs/ctx). Builds on the queryable
knowledge store above.

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
