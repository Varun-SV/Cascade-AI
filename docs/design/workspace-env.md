# Your own machine as a coding environment for cloud runs

Status: design for phase 1 (desktop host). Phase 3 (a cloud sandbox host) is
deliberately left open: see "Cloud environments" at the end.

## What it is

A run started in the hosted web app has no shell, no files and no git: the
server registers only web tools for it (`cloud/server/src/runs.ts`,
`enabledTools: ['web_search', 'web_fetch']`). This adds an **environment**: a
folder on a machine the user owns, served by the Cascade desktop app, in which a
cloud run's coding tools execute.

- The **agent loop stays on the server**. T1, T2 and T3 model calls, billing,
  spend limits, streaming to the web app and the run's transcript are what they
  are today.
- Only **tool calls** cross: `shell`, `file_read`, `file_write`, `file_edit`,
  `file_list`, `file_delete`, `glob`, `grep`, `git`, `run_code`. Each is sent to
  the desktop app, run there by Cascade's own tool registry in the chosen
  folder, and its result sent back.
- Nothing runs without a yes **on the machine**, never in the web app alone.

The same protocol is meant to be served later by a headless Cascade inside a
disposable cloud sandbox; the run side does not change.

## Reused from the browser relay

The browser relay (`src/browser/relay/`, `docs/browser-relay.md`) already solves
the hard parts: a device that dials out and listens on nothing, a key pair per
device with the private half in the OS keychain, a server key the device pins,
a signed **grant** (server → device: "this run, for this user, on this device")
and a signed **approval** (device → server: "the user agreed, to this scope"),
nonces against replay, one connection per capability, and routing by grant,
never by user alone.

The workspace relay reuses all of that. What differs:

| | Browser relay | Workspace relay |
|---|---|---|
| Signing domains | `cascade.relay.*.v1` | `cascade.workspace.*.v1`, so neither can be passed off as the other |
| Approval scope | a tab and a list of sites | the tools allowed, and whether writes are |
| Run channel carries | CDP | tool calls and results (below) |
| Control endpoint | `/api/browser-relay/control` | `/api/workspace-relay/control` |
| Device record | `relay_devices` | the same row: the desktop's registered key serves both |

A desktop with workspace serving off never opens the workspace control
connection, so a server can't even offer it a run.

## The run channel

Once claimed, the run socket carries JSON frames, version 1:

```
device → server  { t: 'ready', tools: ToolDefinition[], label: string }
server → device  { t: 'call', id, tool, input }
device → server  { t: 'status', id, waiting: 'approval' }      // shown in the web app
device → server  { t: 'result', id, ok: true, output } | { t: 'result', id, ok: false, error }
server → device  { t: 'cancel', id }
```

- `ready` lists the tools the user allowed, with the schemas the device's own
  registry gives them. The run registers exactly those, so the model is never
  shown a tool the machine won't run.
- `label` is what the web app shows for the environment: "Workspace on
  <device name>" unless the user chooses to show the folder's name. The
  folder's **path never leaves the machine**.
- One call at a time per worker, a few in flight per run at most, a timeout per
  call, and a size cap per result (the same caps a local run's tools have).

## On the machine

The desktop app runs each call through a `ToolRegistry` of its own, rooted at
the chosen folder, with everything a local run has:

- **The process jail** (`src/tools/jail/process-jail.ts`) for commands, and the
  workspace path sandbox for file tools.
- **Risk, per call** (`src/core/permissions/risk.ts`): a safe or recoverable
  call runs; a risky one (deletes, leaves the machine, rewrites git history,
  installs software, changes things outside the folder, …) is asked about in
  the desktop window, with the command shown. Unanswered within the call's time,
  it is refused. "Allow everything" is a choice the user makes on the machine.
- **A checkpoint before the run's first change** (`src/core/checkpoints.ts`),
  so everything the run did can be undone from the desktop app afterwards.
- **`privacy.paths`** from the folder's own Cascade config. The run's models are
  cloud models, so every result goes to an outside service: a `local-only` file
  is refused to it (the `'service'` read destination), whatever the server asks.
- **Stop** in the desktop window ends the run's access at once.

## On the server

- A second hub instance with the workspace capability, and its two endpoints.
- When a run is started with an environment, `runs.ts` requests it from the
  chosen device, waits for the claim and the `ready` frame, and registers one
  proxy tool per listed tool. A proxy's `execute` sends a `call` and resolves on
  its `result`; aborting the run cancels what is in flight and ends the lease.
- The run's shared board (`src/core/knowledge/run-memory.ts`) watches files on
  the machine it runs on. For a remote environment that is the server, so its
  file tracking and fact checks are **off** for such runs; reuse of read-only
  answers keeps its coarse rule.
- **Logging**: the server relays frames and keeps nothing of them beyond what
  the run's transcript already holds (the calls the model made and what they
  returned, as for any run). No file contents, paths or command output are
  written to server logs.

## Phases

1. **Core (this design):** the capability, the hub wiring, the device executor
   and the run's proxy tools, in the SDK, tested end to end in memory.
2. **Server and desktop:** the endpoints and the run option; in the desktop app,
   a Settings switch, folder choice, the consent window, per-call approval and
   Stop.
3. **Web app:** an environment picker beside the model picker, the run's changes
   as a file list and diffs, and approval prompts mirrored from the machine
   (answered on the machine).

## Cloud environments

Hosting sandboxes means holding users' code and secrets and paying for their
compute, with abuse (mining, scanning) to defend against. Before any of it is
built, a comparison of providers and of self-hosting, with isolation, cost,
data handling and fit, is to be written for a decision, which may well be not to
offer them. Nothing in phases 1 to 3 depends on that decision: a sandbox host
would be one more device speaking this protocol.
