# ◈ Cascade AI

> Multi-tier AI orchestration CLI — built for developers who think in systems.

Cascade is an open-source CLI tool that runs your prompts through a hierarchical three-tier agent system (T1 → T2 → T3), automatically routing work across the best available models, executing tools, and compiling a single coherent result. Inspired by Claude Code, Gemini CLI, and GitHub Copilot CLI — but uniquely structured around orchestration.

```
cascade "Refactor the auth module to use JWT, add tests, and open a PR"
```

---

## Table of Contents

- [What's New in v0.5.5](#whats-new-in-v055)
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

## What's New in v0.5.5

### v0.5.5 — Wizard scrollable model list + chat scrollback + slash panel fix
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

> Requires **Node.js ≥ 18**.

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
    "port":     4891,
    "auth":     true,
    "teamMode": "single"
  },
  "theme":  "cascade",
  "telemetry": { "enabled": false },
  "plugins": ["./plugins/my-tool.js"]
}
```

API keys are also read from environment variables:

| Provider | Environment Variable  |
|----------|-----------------------|
| Anthropic | `ANTHROPIC_API_KEY`  |
| OpenAI    | `OPENAI_API_KEY`     |
| Gemini    | `GOOGLE_API_KEY`     |
| Azure     | `AZURE_OPENAI_KEY`   |

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
cascade update                  Update to the latest version
cascade dashboard               Launch the web dashboard
```

**Options:**

```
-p, --prompt <text>    Single prompt (non-interactive mode)
-t, --theme  <name>    Color theme (cascade|dark|light|dracula|nord|solarized)
-w, --workspace <path> Workspace path (default: cwd)
-v, --version          Show version
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
| `/cost`      | Toggle session cost / token usage panel       |
| `/export [markdown\|json]` | Export session to file             |
| `/rollback`  | Undo all file changes made in this session    |
| `/branch`    | Fork the session into parallel branches       |
| `/compact`   | Summarize and compress context now            |
| `/identity`  | Switch active identity                        |
| `/sessions`  | List and resume past sessions                 |
| `/status`    | Show live agent tree status                   |

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
npm install   # installs root + web via npm workspaces
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
