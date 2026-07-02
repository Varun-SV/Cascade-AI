# Cascade AI — Roadmap

Deferred designs from the v0.13 feature round. Each item below has a sketched
approach grounded in the current codebase, so any of them can be picked up
without re-discovery.

## WASM / isolate sandboxing for tool execution

**Today:** `shell` runs via `child_process.exec` guarded by an allowlist,
blocklist, dangerous-pattern regexes, a timeout, and the approval gate
(`src/tools/shell.ts`) — but with no process/filesystem/network isolation.
LLM-authored dynamic tools run in a `node:worker_threads` Worker with resource
limits and a message-bridge for privileged calls (`src/tools/tool-creator.ts`),
which is a robustness boundary, not a security boundary.

**Plan:** introduce an opt-in isolate for untrusted execution — either
`isolated-vm` (hard V8 isolate) or a WASI runtime for running generated code
and test suites. Shell stays approval-gated but gains an optional jail
(container/`bwrap` where available). The Worker bridge in `tool-creator.ts` is
the natural seam: swap the executor behind the same `callTool`/`fetch`
messaging without changing tool authorship.

## Project knowledge graph (world-state v2)

**Today:** `WorldStateDB` (`src/core/knowledge/world-state.ts`) is an
encrypted, append-only *linear log* of worker completions; T1 reads the
formatted log during decomposition.

**Plan:** upgrade to queryable facts — a `facts(entity, relation, value,
source_worker, timestamp)` table with upsert semantics ("Function X handles
JWT", "Service Y depends on Z"), populated by a cheap extraction pass on each
T3 completion. T1/T2 query relevant facts by entity instead of replaying the
whole log; stale facts get superseded rather than appended. The existing
encryption/key handling carries over unchanged.

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
