# Cascade AI — Roadmap

Deferred designs from the v0.13 feature round. Each item below has a sketched
approach grounded in the current codebase, so any of them can be picked up
without re-discovery.

## Hard sandbox for LLM-authored dynamic tools — ✅ shipped in v0.14.0

Dynamic tools now run in an `isolated-vm` hard V8 isolate (no Node globals),
reaching the host only through the escalator-gated `callTool` / SSRF-guarded
`fetch` bridges (`tools.dynamicToolSandbox`, `src/tools/tool-creator.ts`).
Where the optional native addon is unavailable — the desktop app never ships
it — they run in a WebAssembly sandbox instead: QuickJS on a worker thread of
its own, with the same two bridges, a memory cap and a hard kill at the
deadline (`src/tools/sandbox/`). The bare
worker fallback, which confined nothing, is gone; a config naming it gets the
WebAssembly sandbox.

**OS-level jail for real-process execution — ✅ shipped for Linux and macOS.**
`shell`, `run_code` and `git` launch through `ProcessJail`
(`src/tools/jail/process-jail.ts`, `tools.processJail: 'auto' | 'bwrap' |
'sandbox-exec' | 'off'`), on top of approvals:

- **Linux — bubblewrap.** The host filesystem as it is, with Cascade's own
  folder (bar its scratch), the built-in secrets, `~/.cascade-ai` and — for a
  caller that is not local-only — local-only paths mounted over, directories
  whole where a pattern covers them, so files created mid-command are hidden
  too; the git store as well while its history holds any of them; its own
  PID namespace, so no other process's `/proc/<pid>/environ` is readable; no
  capabilities; and for a local-only caller `--unshare-net` plus a seccomp
  filter refusing `socket(AF_UNIX)` and io_uring, so host daemons behind
  socket files are out of reach. Hard links to hidden files are found by
  inode and mounted over too. A cloud caller's root stays writable: builds
  and package managers write outside the workspace, and the aim there is
  keeping secrets and private files out of reach, not freezing the machine.
  A local-only caller's is read-only — the workspace writable, `/tmp` and
  `~/.cache` private tmpfs, the git store read-only — because whatever it
  writes may carry what it read: its changes in the workspace are found by
  stamping files before and after, and marked local-only
  (`.cascade/privacy-derived.json`) — a directory it made whole — with
  other tool calls held until it ends (`src/tools/workspace-gate.ts`), in
  every run in the workspace: one gate per workspace in a process, and
  marker files in `.cascade/gate/` between processes.
  `.cascadeignore` is mounted over itself read-only for every caller.
- **macOS — sandbox-exec**, a generated profile denying the same paths.
  A local-only caller runs no commands there: with no mount boundary a
  command could hard-link a file from outside the workspace in and write
  through it, and with no process namespace a child it left running could
  write after it ended — either way where Cascade cannot mark it. Checked at
  startup with a profile of the same shape; not exercised in CI.
- **Everywhere** — provider keys are taken out of every command's
  environment, `git`'s on Windows included. With no jailer, `auto` runs
  commands that way and refuses them to a local-only caller. The `git` tool
  refuses a push that would send a commit holding a hidden path.

**Still open:** Windows (Job Objects/AppContainer, or WSL2 + bubblewrap), and
a Docker/Podman fallback where no jailer works — which would also give
macOS local-only commands. On macOS a command can still
read another same-user process's startup environment; Linux's PID namespace
closes that there. A mask hides what a path holds, not that it is there: a
cloud worker's command can list a local-only file's name, including one a
local-only worker chose (the file tools leave such names out). Hiding names
from commands would mean mounting over the parent directory, and losing the
command's own writes there.

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
