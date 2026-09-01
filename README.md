# ◈ Cascade AI

> **One prompt → an organization of AI agents that plan, delegate, and execute in parallel.**
> Auto-routed to the cheapest model that's best at each step. **Up to 90% cheaper** than running everything on one frontier model.

[![npm](https://img.shields.io/npm/v/cascade-ai?color=aaff00&label=npm)](https://www.npmjs.com/package/cascade-ai)
[![license](https://img.shields.io/badge/license-MIT-aaff00.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-5AB4E8.svg)](#installation)
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
- [Self-host](#self-host)
- [OpenAI-compatible API](#openai-compatible-api)
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

Cascade has shipped roughly 55 releases since v0.13.2 and is now at **v0.68.0**. Grouped by theme rather than listed one-by-one:

### v0.68 — a typed task graph, durable resume, and mechanical verification
- **One dependency scheduler for the whole hierarchy.** T1's section dispatch and T2's subtask execution now both compile onto the same typed task graph (`compileTaskGraph` + `DependencyScheduler`) instead of two separate hand-rolled implementations — pinned by a parity harness across 600 generated graphs so ordering didn't silently change.
- **Failure-aware dependency contracts.** A section that depends on one that failed is now skipped rather than run into the same wall — reported with the chain that blocked it, and costing no tokens, instead of starting anyway and billing for a run that was doomed before it began. A degraded (`PARTIAL`) result doesn't block; only a hard failure does.
- **Durable resume across crashes, cancellation, and budget caps.** Checkpoints are now written for every way a run can stop, not just the budget cap, so `/continue` picks a run back up after a crash or Ctrl-C — finished sections are restored as fact and only the remainder gets re-planned.
- **A deterministic rung on the verification ladder.** Acceptance criteria that can be checked mechanically ("file exists," "contains X") are now settled by looking, before a model is ever asked to grade them — cheaper, faster, and immune to a model believing its own claim that a file was written. Ambiguous criteria still fall through to the model.
- **The desktop app is now a real download from the site**, not a GitHub releases page listing twenty build artifacts — platform and architecture are detected, size and version are shown, and stable per-platform links (`/download/mac-arm64`, `/download/win-x64`) mean a shared link never goes stale.

### Cascade Cloud, native login, and one identity across CLI, desktop, and web (v0.20 – v0.45)
- **Cascade Cloud** launched as a hosted, bring-your-own-key chat surface (`app.cascadeai.in`) — multimodal input, persistent memory, and file generation that now produces real, editable Office documents and charts (`.docx`/`.pptx`/`.xlsx`), not markdown text saved under the wrong extension.
- **Native login**, rolled out server → CLI → desktop, so `cascade login`, the desktop app, and the web app all authenticate against one account with no OAuth secret shipped in a native client.
- **Key sync** — provider keys, MCP tokens, and preferences now sync end-to-end encrypted across web, desktop, and CLI; the server holds only ciphertext it cannot read.
- **MCP connectors gained OAuth** — connecting a server can run a real login-and-authorize flow instead of pasting a token, across cloud web, desktop, and CLI alike.
- **One visual identity** — a single azure → sky → teal system, matching T1 → T2 → T3, now runs through the CLI banner, the desktop theme, and the web app instead of three different palettes.

### Cost-aware Auto-routing keeps adding sources and nuance (v0.6 – v0.46)
- Model-value ranking moved from one hand-curated benchmark table to an aggregator over multiple public sources (Artificial Analysis, LMArena, public leaderboards), normalized onto a common scale and scored conservatively where sources disagree.
- Point releases now route as their own families (`gpt-5.5` vs. `gpt-5.4-mini`) instead of folding into one shared, less accurate score, and models a provider newly makes available compete in ranking instead of waiting on a hand-edited catalog.
- Azure deployments with opaque names now get an inferred capability score (size/cost keywords + version), so a multi-deployment setup auto-assigns the strongest model to T1 and the cheapest to T3 instead of handing every tier the same "first available" deployment.

<details><summary>Earlier — building the agent hierarchy and a flicker-free TUI (v0.5.2 – v0.13.2)</summary>

### v0.6 → v0.13.2 — the agentic releases
- Live benchmark Auto-routing (`Auto` picks the best-value model per task from live public benchmarks + live pricing), a boardroom plan-review gate (pause to approve or edit T1's plan before anything spawns), and autonomous `/auto` mode (safe tools run silently, dangerous ones still ask).
- `/continue` run resumability, and workers recruiting bounded sibling workers (`request_workers`) when a task fans out mid-run.
- The desktop Cockpit gained live streaming, a tool-approval modal, a manual tier override, and a click-to-inspect node detail panel.

### v0.5.x — the visible organization
- The delegation-savings counter (`saved $X vs. all-T1`), the `/comms` peer-traffic feed, `/why` run explanations, and the boardroom approval gate.
- A dedicated security hardening pass — loopback-only dashboard, SSRF-guarded fetch, sandboxed code execution — and the Ink 6 / React 19 rewrite that fixed the terminal flicker.

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
- **Browser** — Playwright automation; opt-in via `tools.browserEnabled`
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

> Requires **Node.js ≥ 22**.

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

## Self-host

Run the Cascade Cloud web app (chat UI + API + socket) yourself, on one port, with no cloud account:

```bash
cp .env.example .env
echo "SESSION_SECRET=$(openssl rand -base64 32)" >> .env
echo "CLOUD_DEV_BYPASS=1" >> .env    # local-only sign-in; see the warning below
docker compose up                    # → http://localhost:8787
```

`docker compose up` builds the image, serves the web UI straight from the server (no separate web container), and keeps the SQLite database + uploads in a named volume so a restart doesn't wipe them. `.env.example` documents every variable the server reads (from `cloud/server/src/env.ts`), grouped required-first, each with what it does and what breaks if it's unset.

> **`CLOUD_DEV_BYPASS` is an authentication bypass, not a convenience toggle.** It adds a sign-in button that accepts any name with no credential, so anyone who can reach the port can sign in as anyone. That is why it ships commented out, why the step above is explicit rather than the default, and why `docker-compose.yml` publishes to `127.0.0.1` only. Before putting this on a network anyone else can reach: set `GITHUB_CLIENT_ID`/`GOOGLE_CLIENT_ID` for real OAuth, remove `CLOUD_DEV_BYPASS`, and only then change the port binding.

See the [Dockerfile](Dockerfile) and [docker-compose.yml](docker-compose.yml) for the build/runtime details.

---

## OpenAI-compatible API

Anything that already talks to OpenAI can talk to Cascade. Point the client's `base_url` at your server's `/v1` and use a Cascade access token as the API key — `POST /v1/chat/completions` and `GET /v1/models` work with the official SDKs, streaming and not.

```python
from openai import OpenAI

client = OpenAI(api_key=CASCADE_ACCESS_TOKEN, base_url="http://localhost:8787/v1")

reply = client.chat.completions.create(
    model="cascade",                                    # a routing mode, not a model
    messages=[{"role": "user", "content": "Compare Postgres and SQLite for a CLI tool."}],
)
print(reply.choices[0].message.content)
print(reply.cascade)   # which tier + model actually served it, and what routing saved
```

`model` names a **routing mode**, because Cascade picks a model per subtask — that is the product:

| `model` | what runs |
| --- | --- |
| `cascade` | full orchestration, balanced quality against cost |
| `cascade-fast` | one mid-tier model, no orchestration |
| `cascade-quality` | full orchestration, biased to quality |

Anything else returns `404 model_not_found` rather than quietly running something you didn't ask for. Unsupported parameters (`n > 1`, `logprobs`, `tools`, `response_format`, …) are **rejected**, not ignored — a silently dropped parameter returns a response that looks successful and is wrong. `temperature` and `max_tokens` are honoured, applied across tiers.

**Provider keys.** On a **single-account** instance — a self-host, where the operator and the caller are the same person — the endpoint uses the provider keys in your `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …; the same names the CLI reads). The moment a second account exists this stops automatically, because the operator's key would otherwise pay for everyone else's runs. Any instance can also take keys per request via the SDK's `extra_body={"providers": [...]}`.

`/v1` is for server-side clients: `Authorization` is not allowed cross-origin, so a browser-side SDK is deliberately not served. Tools/function calling and image inputs are not in v1 — Cascade's tools run server-side, and attachments go through `POST /api/uploads`.

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
cascade link groq                 # adopt a compatible service, with its endpoint
```

`cascade doctor` also reports what's linkable. How each credential is treated:

| Source | Stored as | Reusable? |
|--------|-----------|-----------|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` env | API key | ✅ directly |
| `AZURE_OPENAI_KEY` env | API key | ⚠️ needs routing — `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT`, or deployments already configured |
| `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY` | API key | ✅ directly — adopted together with the service's endpoint |
| `ANTHROPIC_AUTH_TOKEN` env | bearer token | ⚠️ needs the gateway that issued it — `ANTHROPIC_BASE_URL`, or `baseUrl` already configured |
| Codex `~/.codex/auth.json` (API-key mode) | API key | ✅ directly |
| Claude Code `~/.claude/.credentials.json` | subscription OAuth | ❌ detected only — Anthropic prohibits third-party use |
| Codex ChatGPT login · Gemini CLI · Copilot CLI | vendor OAuth | ❌ detected only — locked to that vendor's backend |

> ⚠️ **Subscription tokens are not adoptable.** Anthropic [does not permit](https://code.claude.com/docs/en/legal-and-compliance) third-party developers to route requests through Claude Free, Pro or Max credentials, and refuses them server-side; the Codex, Gemini CLI and Copilot tokens each target their own vendor's backend rather than the public API. Cascade detects them so you know what is on the machine and why it cannot use them, and declines to configure a provider that would fail on its first call. It only ever reads **your own** local files, and never transmits a credential anywhere except to that credential's own provider.

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
    "apiVersion":     "2024-08-01-preview",
    "region":         "global"
  }]
}
```

`region` selects the right price sheet — Azure charges ~10% more for `us` and
`eu` deployments than for `global` ones. Defaults to the global rates.

### OpenAI-compatible endpoints (Groq, Together, etc.)

```jsonc
{
  "providers": [{
    "type":    "openai-compatible",
    "apiKey":  "...",
    "baseUrl": "https://api.groq.com/openai/v1",
    "model":   "llama-3.1-70b-versatile",
    "local":   false
  }]
}
```

### Is this endpoint free? (`local`)

An OpenAI-compatible endpoint is either your own hardware — llama.cpp, LM
Studio, vLLM — where inference genuinely costs nothing, or somebody's paid API.
The same is true of Ollama, which is usually local but can be pointed at a
rented box. `local` says which:

| `local`   | Meaning                                                            |
|-----------|--------------------------------------------------------------------|
| `true`    | Self-hosted. Calls cost **$0**, and Cascade reports $0.            |
| `false`   | Hosted. Cascade prices calls from its pricing dataset; a model it can't price reports **"cost not tracked"**, never $0.00. |
| *(unset)* | Inferred: Ollama is local; an OpenAI-compatible endpoint is local when `baseUrl` points at localhost or your LAN. |

Set it explicitly whenever the default guesses wrong — a hosted endpoint
mistaken for a local one is how real spend gets reported as free.

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
| `browser`     | Playwright automation (off unless `browserEnabled`) | ✓       |
| `image_analyze` | Describe an image file                         |           |
| `generate_document` | Render a REAL `.docx` / `.pptx` / `.xlsx` from Markdown or CSV | ✓ |

> `generate_document`, not `file_write`, is how a Word/PowerPoint/Excel file gets
> made: those formats are ZIP archives of OOXML, so text saved under the
> extension opens as a corrupted file. It embeds generated images
> (`![alt](path)` on its own line) and turns a fenced ` ```chart:bar ` block
> (body: CSV) into a real, editable PowerPoint chart — see
> [docs/file-generation.md](docs/file-generation.md).

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
| ✓ | Redaction layer — secrets/PII stripped from T3 output before it travels upstream |
| ✓ | Per-path privacy tiers (`privacy.paths` — force local models + withhold output for sensitive folders) |
| ✓ | Tamper-evident audit log (encrypted + hash-chained; `/audit`, `GET /api/audit/verify`) |
| ✓ | Independent T2-critic reflection loop (`reflection.enabled`) |
| ✓ | Live steering — `/steer` / desktop Steer bar injects corrections into running workers |
| ✓ | Session rollback button (desktop) + `/rollback` (CLI) |
| ✓ | Cost-per-feature attribution (`costByFeature` in results, CLI cost panel, desktop chat) |
| ✓ | Project world state (encrypted local log feeding T1 planning) |
| ✓ | Cascade Cloud (hosted chat — GitHub/Google login, bring-your-own-key, `cascadeai.in`) |
| 🔜 | VSCode extension (`cascade-vscode`) — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | JetBrains extension (`cascade-jetbrains`) — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | WASM/isolate sandboxing for tool execution — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | Project knowledge graph (world-state v2) — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | Multi-plan branching (T1 proposes N plans) — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | Cascade Cloud billing (Razorpay Subscriptions) |
| 🔜 | Plugin marketplace |
| 🔜 | Voice input (STT) |
| 🔜 | Multi-workspace support |

---

## Contributing

### Prerequisites

| Tool | Required Version |
|------|-----------------|
| Node.js | ≥ 22.x |
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
