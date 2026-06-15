# ◈ Cascade AI

> **One prompt → an organization of AI agents that plan, delegate, and execute in parallel.**
> Auto-routed to the cheapest model that's best at each step. **Up to 90% cheaper** than running everything on one frontier model.

[![npm](https://img.shields.io/npm/v/cascade-ai?color=aaff00&label=npm)](https://www.npmjs.com/package/cascade-ai)
[![license](https://img.shields.io/badge/license-MIT-aaff00.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-5AB4E8.svg)](#installation)
[![providers](https://img.shields.io/badge/providers-6-a78bff.svg)](#ai-providers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-f5a623.svg)](CONTRIBUTING.md)

Cascade is an open-source CLI that runs your prompt through a hierarchical three-tier agent system — **T1 plans → T2 manages → T3 executes** — auto-routing each step to the best-value model, running tools, and compiling one coherent result. Think Claude Code / Gemini CLI / Copilot CLI, but uniquely built around **orchestration**.

```
cascade "Refactor the auth module to use JWT, add tests, and open a PR"
```

## ✨ Highlights

- 🧠 **Live benchmark Auto-routing** — set a tier to `Auto` and Cascade fuses *live* public benchmark scores with *live* pricing to pick the best-**value** model for each task.
- 🤖 **Autonomous mode** (`/auto`) — hands-off runs: safe tools run silently, dangerous ones still ask, budget caps stay the hard stop.
- 📋 **Boardroom plan review** — pause to review, **edit**, or steer T1's plan (with an AI reviewer's critique) before any worker spawns.
- ⏯️ **Run resumability** (`/continue`) — hit the budget cap on a big task? Resume from the partial state instead of redoing it.
- 👥 **Workers recruit help** — a worker can ask its manager to spawn bounded sibling workers when the work fans out — dynamic parallelism, no rigid plan.
- 💸 **Delegation savings** — every run shows what the hierarchy saved you (`saved $5.63 — 90% vs. all-T1`); no flat-agent tool can show this number.
- 🛡️ **Safe by default** — permission escalation (T3→T2→T1→you), SSRF-guarded fetch, loopback-only dashboard, and a budget kill-switch.

## Why Cascade is one of a kind

Other AI CLIs run a single agent. Cascade runs a visible **organization** — and the terminal shows you the org at work:

- **Delegation savings** — the status bar and every run receipt show what the hierarchy saved you (`$0.031 · saved $0.094 — 75% vs. all-T1`), because cheap local T3 workers do the heavy lifting while a premium T1 model only administrates. No flat-agent tool can show this number.
- **Agent comms feed** (`/comms`) — live radio chatter between workers: peer messages, broadcasts, file locks, barrier syncs. No other CLI has agent-to-agent communication at all, let alone on screen.
- **`/why`** — every run can explain itself: the complexity verdict and the classifier's reasoning, which model served each tier, failovers, and escalations.
- **The boardroom** (`planApproval: "always"`) — Complex runs pause so you can approve T1's proposed org chart and budget ("3 managers · 7 workers · est. $0.40") before anything spawns. You sit above T1.

---

## Table of Contents

- [What's New](#whats-new)
- [How It Works](#how-it-works)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [AI Providers](#ai-providers)
- [Tools](#tools)
- [CLI Reference](#cli-reference)
- [Slash Commands](#slash-commands)
- [Themes](#themes)
- [Web Dashboard](#web-dashboard)
- [SDK / Programmatic Use](#sdk--programmatic-use)
- [MCP Support](#mcp-support)
- [Hooks](#hooks)
- [Memory & Identity](#memory--identity)
- [Security](#security)
- [Shell Completions](#shell-completions)
- [Architecture](#architecture)
- [Roadmap](#roadmap)

---

## What's New

### v0.6 → v0.9.1 — the agentic releases
- **v0.9.1 — Workers recruit help.** A T3 worker that discovers its task should fan out can call `request_workers` to have its T2 spawn bounded sibling workers (no recursive 4th tier; depth-capped + budget-bounded).
- **v0.9.0 — Resumability, reflection, smarter local exec.** `/continue` resumes a budget-capped task from its partial state; opt-in **reflection** revises a worker's output against the goal; `t3Execution: auto` runs T3 waves sequentially on local/Ollama tiers and parallel on cloud.
- **v0.8.0 — Autonomous mode + smarter re-planning.** `/auto` for hands-off runs (safe tools auto-approve, dangerous still gated); T1's reviewer **stops early** when a corrective pass isn't converging; new `/plan` (preview a decomposition) and `/replan`.
- **v0.7.0 — Boardroom plan review.** Iterative revision (steer → re-plan → re-ask), an AI **plan reviewer**, inline **editable** plans, and a wider gate that can pause Moderate runs too.
- **v0.6.0 — Live benchmark Auto-routing + fixes.** `Auto` picks the best-value model per task from live public benchmarks + live OpenRouter pricing, with live provider model discovery. Plus the Gemini stale-id 404 self-heal, the Ink-6 paste fix, and run-hang timeouts.

<details><summary>Earlier — the visible organization + a flicker-free TUI (v0.5.x)</summary>

### The visible organization + a flicker-free TUI
- **Delegation savings counter** — live `saved $X (Y%) vs. all-T1` in the StatusBar and `/cost`, plus a one-line receipt after every run (duration · managers · workers · cost · savings).
- **Agent comms feed** — `/comms` toggles a live ticker of PeerBus traffic (peer messages, broadcasts, file locks, barriers). The events always existed for the web dashboard; the terminal now shows them too.
- **`/why`** — prints the decision trail for the last run: complexity verdict with the classifier's reason (or which heuristic short-circuited), models per tier, Cascade Auto picks, provider failovers, and escalations.
- **Boardroom plan approval** — with `planApproval: "always"`, Complex runs pause after T1 plans so you can approve the org chart + estimated cost before any T2 spawns. SDK/headless auto-approve, so default behavior is unchanged.
- **Flicker fix** — the live area now always fits the viewport (per-panel row budgets, terminal-resize handling, capped panels), which stops Ink's full-screen redraw fallback — the root cause of flicker in long sessions on small/maximized terminals.
- **Native mouse selection works** — idle repaints no longer wipe an in-progress drag-select; the completed agent tree collapses on your next keystroke instead of an 8s timer. `/copy [n]` copies a response via native clipboard tools with an OSC 52 escape fallback (works over SSH).
- **`--alt-screen`** — opt-in vim-style alternate-screen mode: flicker-proof by construction, shell restored on exit (even on crashes); history scrolls in-app with PgUp/PgDn.
- **Ink 6.8 + React 19** — renderer upgrade; Node.js floor rises to **20** (18 is EOL).

### v0.5.7 — Security hardening pass
A focused security review of the tool and dashboard surface. All changes are covered by tests (`tsc --noEmit` clean, full suite green).
- **Dashboard binds to loopback by default** — the server previously listened on all interfaces (`0.0.0.0`), exposing `POST /api/run` (which executes a prompt through the full shell/file/code-interpreter tool set) to the local network. It now binds to `127.0.0.1` via the new `dashboard.host` config field; binding to a public interface requires opting in and prints a warning (louder still if `dashboard.auth` is off).
- **SSRF protection for `web_fetch`** — agent-supplied URLs are validated against a new SSRF-safe fetch helper: http/https only, hostnames resolved and rejected if they map to loopback / link-local (cloud metadata `169.254.169.254`) / private / CGNAT ranges, and every redirect hop re-validated. Set `CASCADE_ALLOW_LOCAL_FETCH=1` to fetch local URLs. The runtime tool-creator sandbox's `fetch` uses the same guard.
- **`file_edit` and `git` now require approval** — approval is gated by an allowlist that previously omitted both, so in-place file edits and `git commit`/`checkout`/`push` ran with no prompt while `file_write`/`file_delete` were gated. Both are now in the default approval set.
- **Code interpreter argument injection fixed** — `run_code` now executes via `execFile` with an argv array instead of interpolating arguments into a shell string, so a crafted `args` value can no longer break out into a second command. Temp scripts are written under the workspace root.
- **Dashboard JWT pinned to HS256** on both sign and verify (defense-in-depth against algorithm-confusion).
- **Broadened shell dangerous-command patterns** — the built-in blocklist now tolerates flag reordering / extra whitespace (`rm -fr /`, `rm  -rf  /`) and catches a fork-bomb form. This is defense-in-depth; the approval prompt remains the real gate.

### v0.5.6 — Wizard scrollable model list + chat scrollback + slash panel fix
- **Init wizard tier-model picker** — added `limit={8}` to the `SelectInput` so long model lists scroll with ↑/↓ indicators instead of overflowing off-screen.
- **Chat scrolling restored** — the REPL was still enabling mouse-reporting on mount, which captured wheel events and broke the terminal's native scrollback (where Ink `<Static>` messages live since v0.5.4). Flipped the on-mount sequence to actively disable. Mouse-wheel-up now scrolls the terminal scrollback as expected.
- **Slash-command suggestion panel** — long descriptions were wrapping to a second line and squishing two entries onto one row. Added `wrap="truncate"` on the description text and bumped the fixed panel height by one row to fit the worst-case content (header + 8 entries + both ↑/↓ indicators).

### v0.5.4 — Maximized-terminal flicker fix + orchestrator resilience
- **Static-based conversation rendering** — completed messages now go to the terminal's native scrollback via Ink `<Static>`; only the live area (status bar, streaming tail, agent tree, input) re-renders per batch. Effectively eliminates the maximized-window flicker on cmd / PowerShell.
- **`tier:status` throttle** (100 ms) + `React.memo` on AgentTree / StatusBar / HintBar to cut per-event re-render churn.
- **Auto-clear agent tree** — the tree auto-hides 8 s after a task completes (preserves conversation and cost data); cancelled if a new task starts.
- **T3 critical-error detection** — rate-limit / auth / forbidden errors now short-circuit the agent loop via a typed `CriticalToolError`; the worker no longer loops 15× on a 429.
- **T3 stall preserves partial output** via a typed `WorkerStallError` instead of throwing a bare `Error`.
- **T1 failure summary** — when all sections fail, the user sees the actual root cause (e.g. `[CRITICAL_TOOL_ERROR] grep: 429 Rate limit reached for gpt-5.4-mini`) instead of a generic "all sections encountered errors".

### v0.5.3 — Headless mode and audit fixes
- **Headless `cascade run` / `-p`** — works in non-TTY contexts (CI, pipes, scripts). Progress → stderr, final answer → stdout. Tool approvals are auto-granted in headless mode.
- **`cascade models` columns** — long model IDs no longer collide with the provider column.
- **`/clear` resets cost breakdowns** — per-provider / per-tier maps are reset, not just the totals.
- **`/config`** — richer output (theme, providers, per-tier models, dashboard port, cascade-auto), guarded against an undefined `config.dashboard`.
- **Type cleanup** — removed vestigial `ReplMessage` / `ToolCallBlock` interfaces.

### v0.5.2 — Setup wizard redesign + new tools
- **First-run setup wizard redesigned** to match the Cascade-AI TUI design — themed welcome header, phased step tabs (API Keys → Models → Complete), field boxes, tier cards, and a proper completion screen. All provider/model functionality preserved.
- **New tools** — `glob`, `grep`, and `web-fetch` available to T3 workers.
- **Model-performance tracker** — records per-model success/cost stats for scored selection when `cascadeAuto: true`.
- **Fixes** — removed an accidental `cascade-ai` self-dependency in `package.json`; corrected misleading `/tree` and `/sessions` slash-command descriptions; fixed stale T2/T3 test mocks.

</details>

---

## How It Works

Every task runs through three agent tiers:

```
User prompt
    │
    ▼
┌─────────────────────────────────────────────┐
│  T1  Administrator                          │
│  • Analyzes complexity                      │
│  • Selects models for all tiers             │
│  • Decomposes task into n sections          │
│  • Compiles final output                    │
└──────────────┬──────────────────────────────┘
               │  dispatches in parallel
    ┌──────────┼──────────┐
    ▼          ▼          ▼
┌───────┐  ┌───────┐  ┌───────┐
│  T2   │  │  T2   │  │  T2   │   Managers
│ Sec.1 │  │ Sec.2 │  │ Sec.3 │   • Own one section
└───┬───┘  └───┬───┘  └───┬───┘   • Spawn T3 workers
    │          │          │        • Aggregate results
  T3s        T3s        T3s        Workers
  execute    execute    execute    • Run tools
  subtasks   subtasks   subtasks   • Self-test output
                                   • Escalate if needed
```

**Complexity → tier count:**

| Complexity     | T2 Managers |
|----------------|-------------|
| Simple         | 1           |
| Moderate       | 2–3         |
| Complex        | 3–5         |
| Highly Complex | 5+          |

---

## Features

### Core
- **Hierarchical orchestration** — T1/T2/T3 agents with structured escalation
- **Token-by-token streaming** — live output as agents work
- **Live agent tree** — real-time T1→T2→T3 execution graph in the terminal
- **Approval prompts** — explicit y/n for destructive tool operations
- **Provider failover** — auto-switches provider on rate limits (exponential backoff); automatically re-enables recovered providers on success
- **Context auto-summarization** — compresses history when the context window fills
- **Conversation branching** — fork a session to try parallel approaches
- **Task cancellation** — pass an `AbortSignal` to stop any run mid-flight; all tiers halt at the next safe checkpoint and emit `run:cancelled` with partial output

### AI Providers
- Anthropic (Claude Opus 4, Sonnet 4, Haiku 3.5)
- OpenAI (GPT-4o, GPT-4o Mini)
- Google Gemini (1.5 Pro, 2.0 Flash)
- Azure OpenAI (any deployment)
- OpenAI-compatible endpoints (Groq, Together, custom)
- Ollama — local models, **T3 workers prefer local for cost savings**

### Tools (T3 Workers)
- **Shell** — execute commands with allowlist/blocklist
- **File** — read, write, edit (exact string replace), delete
- **Diff** — inline side-by-side diffs before applying edits
- **Git** — status, diff, log, add, commit, branch, push, pull
- **GitHub / GitLab** — create PRs, list/comment on issues
- **Browser** — Playwright automation (multimodal models only)
- **Image** — analyze images (vision-capable models only)

### Developer Experience
- **6 color themes** — cascade, dark, light, dracula, nord, solarized
- **`CASCADE.md`** — project-level instructions for agents
- **`.cascadeignore`** — files agents cannot touch
- **MCP support** — connect any Model Context Protocol server
- **Hooks** — shell scripts on pre/post tool use
- **Session history** — searchable, exportable (markdown / JSON)
- **Audit log** — every tool call, file change, and agent decision
- **Cost tracker** — real-time per-session token + USD cost
- **Scheduled tasks** — cron-based automated runs
- **Desktop notifications** — alert when background tasks finish
- **Webhooks** — POST to Slack / Discord / custom URL on completion

### Web Dashboard
- Real-time agent execution graph (ReactFlow)
- **Peer communication edges** — animated dashed lines between agents as they exchange messages
- **Agent Inspector** — click any node to see live output stream and peer communications
- Session browser with cost/token stats
- Config viewer
- JWT auth (password-protected)
- URL hash routing (`#topology`, `#sessions`, `#logs`, `#settings`)
- WebSocket live updates

---

## Installation

```bash
npm install -g cascade-ai
```

> Requires **Node.js ≥ 20**.

---

## Quick Start

```bash
# 1. Initialize a project
cd my-project
cascade init

# 2. Set API keys (or add to .env)
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_API_KEY=AIza...

# 3. Check everything is working
cascade doctor

# 4. Start the interactive REPL
cascade

# 5. Or run a one-shot prompt
cascade run "explain the auth module in this repo"
```

---

## Configuration

Cascade loads config from `.cascade/config.json` in your project directory.

> **Prefer the picker over hand-editing config.** Inside the REPL, run `/model`
> to walk through a three-step interactive picker (provider → tier → model,
> with an Auto option at every step). The picker writes `.cascade/config.json`
> for you and hot-swaps the running router — no restart needed.

```jsonc
// .cascade/config.json
{
  "version": "1.0",
  "providers": [
    { "type": "anthropic", "apiKey": "sk-ant-..." },
    { "type": "openai",    "apiKey": "sk-..." },
    { "type": "gemini",    "apiKey": "AIza..." },
    { "type": "ollama"                          }
  ],
  "models": {
    "t1": "claude-opus-4",
    "t2": "claude-sonnet-4",
    "t3": "llama3.2:3b"
  },
  "tools": {
    "shellAllowlist":     [],
    "shellBlocklist":     ["sudo rm", "rm -rf", "mkfs"],
    "requireApprovalFor": ["shell", "file_write", "file_delete"],
    "browserEnabled":     false
  },
  "dashboard": {
    "host":     "127.0.0.1",
    "port":     4891,
    "auth":     true,
    "teamMode": "single"
  },
  "theme":  "cascade",
  "telemetry": { "enabled": false },
  "plugins": ["./plugins/my-tool.js"],
  "planApproval": "never",
  "altScreen": false
}
```

- `planApproval: "always"` pauses Complex runs in the **boardroom**: approve T1's proposed sections, worker counts, and estimated cost before any T2 manager spawns. Headless/SDK runs auto-approve.
- `altScreen: true` (or the `--alt-screen` flag) renders the TUI in the terminal's alternate screen buffer — vim-style, flicker-proof, shell restored on exit. History scrolls in-app with PgUp/PgDn since the alt screen has no native scrollback.

API keys are also read from environment variables:

| Provider | Environment Variable  |
|----------|-----------------------|
| Anthropic | `ANTHROPIC_API_KEY`  |
| OpenAI    | `OPENAI_API_KEY`     |
| Gemini    | `GOOGLE_API_KEY`     |
| Azure     | `AZURE_OPENAI_KEY`   |

### Linking credentials from other AI CLIs

If you already use **Claude Code**, **OpenAI Codex**, **Gemini CLI**, or **GitHub Copilot CLI**, Cascade can reuse the credentials they store on your machine instead of asking you to paste keys again:

```bash
cascade link                      # list detected credentials
cascade link anthropic            # adopt an API key for a provider
cascade link anthropic --accept-risk   # adopt a Claude Code subscription token
```

`cascade doctor` also reports what's linkable. How each credential is treated:

| Source | Stored as | Reusable? |
|--------|-----------|-----------|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` env | API key | ✅ directly |
| Codex `~/.codex/auth.json` (API-key mode) | API key | ✅ directly |
| Claude Code `~/.claude/.credentials.json` | OAuth token | ⚠️ as an Anthropic bearer token (needs `--accept-risk`) |
| Codex ChatGPT login · Gemini CLI · Copilot CLI | vendor OAuth | ❌ detected only — locked to that vendor's backend |

> ⚠️ **Terms of service:** reusing a *subscription* OAuth token (Claude Code, ChatGPT, Copilot) outside its own CLI may violate the vendor's terms and can get your account flagged. Cascade only ever reads **your own** local files, never adopts an OAuth token without `--accept-risk`, and never transmits a credential anywhere except to that credential's own provider. Use API keys where you can.

### CASCADE.md

Create a `CASCADE.md` in your project root to give agents project-specific instructions — just like `CLAUDE.md`. Run `cascade init` to generate a template.

### .cascadeignore

List files and directories agents cannot read or modify. Syntax is identical to `.gitignore`. Secrets (`.env`, `*.pem`, `*.key`) and Cascade internals (`.cascade/keystore.enc`) are protected by default.

---

## AI Providers

### Model routing (auto-selected at startup)

| Tier | Priority order |
|------|---------------|
| T1   | Anthropic → OpenAI → Google *(no local)* |
| T2   | Anthropic → OpenAI → Google → Local (≥70B) |
| T3   | **Local first** → Anthropic → OpenAI → Google |

T3 workers prefer local Ollama models for cost savings. Override with `"models"` in your config.

### Multimodal / Vision

Images are only processed by vision-capable models. When you attach an image:
- **T1** analyzes it as part of understanding your top-level request
- **T3** analyzes it when image processing is the actual subtask

### Ollama (local models)

```bash
# Install Ollama then pull a model
ollama pull llama3.2:3b    # T3 workers
ollama pull llava           # T3 vision tasks
ollama pull llama3:70b      # T2 managers

# Cascade auto-detects Ollama at localhost:11434
cascade doctor              # confirms detection
```

### Azure OpenAI

```jsonc
{
  "providers": [{
    "type":           "azure",
    "apiKey":         "...",
    "baseUrl":        "https://YOUR_RESOURCE.openai.azure.com",
    "deploymentName": "gpt-4o",
    "apiVersion":     "2024-08-01-preview"
  }]
}
```

### OpenAI-compatible endpoints (Groq, Together, etc.)

```jsonc
{
  "providers": [{
    "type":    "openai-compatible",
    "apiKey":  "...",
    "baseUrl": "https://api.groq.com/openai/v1",
    "model":   "llama-3.1-70b-versatile"
  }]
}
```

---

## Tools

T3 workers have access to the following tools. All destructive operations require explicit approval unless disabled in config.

| Tool          | Description                                      | Dangerous |
|---------------|--------------------------------------------------|-----------|
| `shell`       | Execute shell commands                           | ✓         |
| `file_read`   | Read file contents with optional line range      |           |
| `file_write`  | Write / overwrite a file                         | ✓         |
| `file_edit`   | Exact-string in-place edit                       | ✓         |
| `file_delete` | Delete a file                                    | ✓         |
| `git`         | status, diff, log, add, commit, push, pull, etc. | ✓         |
| `github`      | Create PRs, list/comment issues (GitHub/GitLab)  | ✓         |
| `browser`     | Playwright automation (vision models only)       | ✓         |
| `image_analyze` | Describe an image file                         |           |

### Shell allowlist / blocklist

```jsonc
"tools": {
  "shellAllowlist": ["npm", "git", "python"],   // only these prefixes allowed
  "shellBlocklist": ["sudo", "curl http://"]     // always blocked
}
```

---

## CLI Reference

```
cascade [options]               Start interactive REPL
cascade run <prompt>            Run a single prompt and exit
cascade init [path]             Initialize Cascade in a directory
cascade doctor                  Diagnose API keys, Ollama, config
cascade link [provider]         Reuse credentials from Claude Code / Codex / Gemini / Copilot
cascade update                  Update to the latest version
cascade dashboard               Launch the web dashboard
```

**Options:**

```
-p, --prompt <text>    Single prompt (non-interactive mode)
-t, --theme  <name>    Color theme (cascade|dark|light|dracula|nord|solarized)
-w, --workspace <path> Workspace path (default: cwd)
-v, --version          Show version
    --alt-screen       Vim-style alternate screen (flicker-proof; PgUp/PgDn history)
    --no-color         Disable colors
```

---

## Slash Commands

Type any of these inside the REPL:

| Command      | Description                                   |
|--------------|-----------------------------------------------|
| `/help`      | List all slash commands                       |
| `/clear`     | Clear conversation history                    |
| `/exit`      | Exit Cascade                                  |
| `/theme <name>` | Switch color theme                         |
| `/model`     | Interactive picker — choose provider → tier → model (or Auto) |
| `/model-info`| Show active models per tier                   |
| `/models`    | Browse available models grouped by provider   |
| `/cost`      | Show session cost, token usage, and delegation savings |
| `/why`       | Explain how the last run was routed (complexity, models, failovers) |
| `/comms`     | Toggle the live agent-to-agent comms feed     |
| `/copy [n]`  | Copy the last (or nth-last) response to the clipboard |
| `/export [markdown\|json]` | Export session to file             |
| `/rollback`  | Undo all file changes made in this session    |
| `/branch`    | Fork the session into parallel branches       |
| `/compact`   | Summarize and compress context now            |
| `/identity`  | Switch active identity                        |
| `/sessions`  | List and resume past sessions                 |
| `/status`    | Show live agent tree status                   |

> **Selection & copy:** mouse capture stays off, so native drag-select and right-click copy work in your terminal. When idle, the screen never repaints under you; `/copy` covers the one case selection can't — grabbing text while output is still streaming (with an OSC 52 fallback that works over SSH).

---

## Themes

Switch with `/theme <name>` in the REPL or set `"theme"` in config.

| Theme       | Style                        |
|-------------|------------------------------|
| `cascade`   | Cascade violet — default     |
| `dark`      | Blue-accented dark           |
| `light`     | Clean light mode             |
| `dracula`   | Dracula palette              |
| `nord`      | Arctic Nord palette          |
| `solarized` | Solarized dark               |

---

## Web Dashboard

```bash
cascade dashboard
# → http://localhost:4891
```

Default password: set `CASCADE_DASHBOARD_PASSWORD` env var (default: `cascade`).

**Features:**
- Live agent execution graph powered by ReactFlow
- Session browser (view, delete, inspect cost/tokens)
- Real-time streaming log
- Config inspector
- JWT authentication
- Team mode: `"single"` (shared workspace) or `"multi"` (per-user isolation)

**Custom port:**
```bash
cascade dashboard --port 8080
```

---

## SDK / Programmatic Use

```typescript
import { runCascade, createCascade, streamCascade } from 'cascade-ai';

// Simple run
const result = await runCascade('Write a Fibonacci function in TypeScript');
console.log(result.output);

// Streaming
await streamCascade('Explain this codebase', (token) => process.stdout.write(token));

// Full control
const cascade = createCascade({
  providers: [{ type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }],
  theme: 'dark',
});

await cascade.init();

const result = await cascade.run({
  prompt: 'Refactor the auth module',
  workspacePath: '/my/project',
  approvalCallback: async (req) => {
    console.log(`Allow ${req.toolName}?`);
    return true;
  },
  streamCallback: (chunk) => process.stdout.write(chunk.text),
});
```

### Cancellation

Pass an `AbortSignal` to stop a run mid-execution. All active tiers (T1 → T2 → T3) halt at the next safe checkpoint, preventing further token spend. The `run()` call resolves with whatever partial output has been produced so far.

```typescript
import { createCascade, CascadeCancelledError } from 'cascade-ai';

const cascade = createCascade({ /* config */ });
await cascade.init();

const controller = new AbortController();

// Listen for the cancellation event
cascade.on('run:cancelled', ({ taskId, reason, partialOutput }) => {
  console.log(`Task ${taskId} cancelled: ${reason}`);
  console.log('Partial output so far:', partialOutput);
});

// Start the run (non-blocking)
const runPromise = cascade.run({
  prompt: 'Perform a deep codebase audit',
  signal: controller.signal,
});

// Cancel after 10 seconds (e.g. user pressed Ctrl-C)
setTimeout(() => controller.abort('User requested stop'), 10_000);

const result = await runPromise; // resolves gracefully, not rejected
```

**How it propagates:** The signal is threaded through `T1Administrator → T2Manager → T3Worker`. Each tier checks for cancellation before every LLM call so the run stops as soon as the current in-flight request completes — no mid-stream interruptions.

---

## MCP Support

Cascade supports the [Model Context Protocol](https://modelcontextprotocol.io). Connect any MCP server and its tools become available to T3 workers automatically.

```jsonc
// .cascade/config.json — MCP servers (coming in a future config key)
// Currently connected programmatically:
```

```typescript
import { McpClient } from 'cascade-ai';

const mcp = new McpClient();
await mcp.connect({
  name:    'filesystem',
  command: 'npx',
  args:    ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
});
```

---

## Hooks

Run shell scripts before or after tool use. Defined in `.cascade/config.json`:

```jsonc
"hooks": {
  "preToolUse": [
    {
      "command": "echo 'Tool: $CASCADE_TOOL' >> .cascade/audit.log",
      "tools":   ["shell", "file_write"]
    }
  ],
  "postToolUse": [
    {
      "command": "npm run lint --silent || true",
      "tools":   ["file_write", "file_edit"],
      "timeout": 15000
    }
  ],
  "postTask": [
    { "command": "git add -A && git status" }
  ]
}
```

Environment variables injected: `CASCADE_TOOL`, `CASCADE_INPUT`, `CASCADE_OUTPUT`.

---

## Memory & Identity

Cascade stores session history, identities, and audit logs in `.cascade/memory.db` (SQLite).

### Identities

Create multiple named identities with different system prompts and default models:

```bash
# Coming: cascade identity create --name "Code Reviewer" --prompt "You are strict about best practices..."
```

### Session export

```
/export markdown    → session-2026-04-02.md
/export json        → session-2026-04-02.json
```

---

## Security

### Encrypted keystore

API keys stored in `.cascade/keystore.enc` are encrypted with **AES-256-GCM** using PBKDF2 key derivation (100,000 iterations). The file is useless without your master password.

```bash
# Coming: cascade keys set anthropic sk-ant-...
```

### .cascadeignore

Always-protected by default (cannot be overridden):
- `.env`, `.env.*`
- `*.pem`, `*.key`, `id_rsa`, `id_ed25519`
- `.cascade/keystore.enc`
- `.cascade/memory.db`

### Approval prompts

Any tool marked as dangerous requires explicit `y` / `n` before execution. Configure which tools require approval in `.cascade/config.json → tools.requireApprovalFor`.

### Command allowlist/blocklist

```jsonc
"tools": {
  "shellAllowlist": ["npm", "git", "python3"],
  "shellBlocklist": ["sudo", "curl", "wget", "nc"]
}
```

---

## Shell Completions

**Bash** — add to `~/.bashrc`:
```bash
source /usr/local/lib/node_modules/cascade-ai/completions/cascade.bash
```

**Zsh** — add to `~/.zshrc`:
```zsh
fpath=(/usr/local/lib/node_modules/cascade-ai/completions $fpath)
autoload -Uz compinit && compinit
```

**Fish**:
```fish
cp /usr/local/lib/node_modules/cascade-ai/completions/cascade.fish \
   ~/.config/fish/completions/
```

---

## Architecture

```
src/
├── core/
│   ├── tiers/          T1Administrator, T2Manager, T3Worker
│   ├── router/         CascadeRouter, ModelSelector, FailoverManager
│   ├── context/        ContextManager (auto-summarization)
│   ├── messages/       Inter-tier JSON schema (Zod)
│   └── cascade.ts      Main Cascade class (EventEmitter facade)
├── providers/          Anthropic, OpenAI, Gemini, Azure, Ollama, OpenAI-compat
├── tools/              Shell, File (CRUD), Diff, Git, GitHub, Browser, Image
├── cli/
│   ├── repl/           ink REPL + AgentTree, ChatMessage, StatusBar, Approval
│   ├── slash/          Slash command registry
│   ├── themes/         6 color themes
│   └── commands/       init, doctor, update, dashboard
├── config/             ConfigManager, Keystore (AES-256), CASCADE.md, .cascadeignore
├── memory/             SQLite store (sessions, identities, audit, scheduler)
├── dashboard/          Express server, JWT auth, Socket.io
├── hooks/              Pre/post tool hook runner
├── mcp/                MCP client
├── scheduler/          node-cron task scheduler
├── notifications/      Desktop notifications + webhooks
├── telemetry/          Opt-in PostHog
├── sdk/                runCascade(), createCascade(), streamCascade()
└── index.ts            Full package exports

web/
├── src/
│   ├── App.tsx         Dashboard SPA (login, dashboard, sessions, settings)
│   ├── components/     AgentGraph (ReactFlow)
│   └── hooks/          useWebSocket (Socket.io)
└── vite.config.ts      Vite + Tailwind build
```

---

## Roadmap

| Status | Feature |
|--------|---------|
| ✓ | T1/T2/T3 hierarchical orchestration |
| ✓ | 6 AI providers + Ollama |
| ✓ | Provider failover with automatic recovery |
| ✓ | Streaming REPL (ink) |
| ✓ | Live agent tree visualization |
| ✓ | AES-256 encrypted keystore |
| ✓ | Web dashboard + WebSocket |
| ✓ | MCP client |
| ✓ | Hooks system |
| ✓ | Scheduler + notifications |
| ✓ | SDK |
| ✓ | Plugin loading from config |
| ✓ | Auto model specialization discovery |
| ✓ | T3 text-tool fallback (Ollama support) |
| ✓ | Peer communication visualization in dashboard |
| ✓ | Conversational fast-path (bypass T1 for simple prompts) |
| 🔜 | VSCode extension (`cascade-vscode`) |
| 🔜 | JetBrains extension (`cascade-jetbrains`) |
| 🔜 | Cascade Cloud (hosted dashboard) |
| 🔜 | Plugin marketplace |
| 🔜 | Voice input (STT) |
| 🔜 | Multi-workspace support |

---

## Contributing

### Prerequisites

| Tool | Required Version |
|------|-----------------|
| Node.js | ≥ 20.x |
| npm | ≥ 10.x |

### Setup

```bash
git clone https://github.com/Varun-SV/Cascade-AI.git
cd Cascade-AI
npm install               # CLI dependencies (uses the committed package-lock.json)
npm --prefix web install  # web dashboard dependencies (needed by `npm run build`)
npm run build
```

### Upgrading an existing checkout (v0.5.7+: Ink 6 / React 19)

v0.5.7 moved from Ink 5 / React 18 to **Ink 6.8 / React 19** and raised the
Node.js floor to **20**. The repo now commits `package-lock.json`, so after a
pull a plain `npm install` upgrades even a stale `node_modules` in place —
then rebuild with `npm run build` so `dist/` matches the source (the CLI warns
on startup when it detects a stale build).

If `git pull` refuses because your old untracked `package-lock.json` would be
overwritten, or `npm install` still reports `ERESOLVE` (this happens on
checkouts that predate the committed lockfile — npm keeps the installed
`react@18` in place while `ink@6` needs `react>=19`), do a clean install:

```bash
rm -rf node_modules web/node_modules package-lock.json web/package-lock.json
git pull
npm install
npm --prefix web install
npm run build
```

### Development commands

```bash
npm run dev          # watch mode for the CLI
npm run build        # build CLI + web dashboard
npm run dev:web      # hot-reload dashboard at web/
npm test             # vitest
npm run lint         # tsc --noEmit
```

### Architecture notes

**Permission escalation.** When a T3 Worker needs to execute a dangerous tool the
request travels `T3 → PermissionEscalator → T2 → T1 → User`. Read-only tools are
auto-approved by rule; dangerous ones use a max-10-token LLM inference at each
tier. Session-wide approvals are cached by `${t2Id}:${toolName}`.

**Adding a tool.** Create `src/tools/my-tool.ts` extending `BaseTool`; implement
`getDefinition()`, `execute()`, and optionally `isDangerous()`; register in
`src/tools/registry.ts` → `registerDefaults()`; if approval is required, add the
tool name to `DEFAULT_APPROVAL_REQUIRED` in `src/constants.ts`.

**Adding a plugin.** Use the `ToolPlugin` interface from
`src/tools/registry.ts` to bundle one or more tools.

### Testing

- Coverage target: 80% lines, 75% functions, 70% branches.
- Co-locate `*.test.ts` alongside the source file they test.
- Mock external I/O (`fs`, network) with `vi.mock()`; don't mock internal logic.

### Code style

- TypeScript strict mode is enforced.
- Use `async/await`, not `.then()` chains.
- Wrap external calls (shell, git, GitHub API) with `withRetry()` from
  `src/utils/retry.ts`.
- Raise tool failures as `CascadeToolError` so they carry a `.userMessage`.

### Pull request checklist

- [ ] Tests added / updated for changed code
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] New public APIs have JSDoc
- [ ] No hardcoded API keys or secrets
- [ ] `.cascadeignore` patterns respected for file tools

---

## License

MIT © Cascade AI Contributors
