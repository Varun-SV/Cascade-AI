# ◈ Cascade AI

> **One prompt → an organization of AI agents that plan, delegate, and execute in parallel.**
> Auto-routed to the cheapest model that's best at each step. **Up to 90% cheaper** than running everything on one frontier model.

[![npm](https://img.shields.io/npm/v/cascade-ai?color=aaff00&label=npm)](https://www.npmjs.com/package/cascade-ai)
[![license](https://img.shields.io/badge/license-MIT-aaff00.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-5AB4E8.svg)](#installation)
[![providers](https://img.shields.io/badge/providers-6-a78bff.svg)](#ai-providers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-f5a623.svg)](CONTRIBUTING.md)

Cascade runs your prompt through a hierarchical three-tier agent system — **T1 plans → T2 manages → T3 executes**, sized to the task — auto-routing each step to the best-value model, running tools, and compiling one coherent result. Think Claude Code / Gemini CLI / Copilot CLI, but built around **orchestration**.

```
cascade "Refactor the auth module to use JWT, add tests, and open a PR"
```

### Where you can use it

| Surface | What it is | Get it |
|---------|------------|--------|
| **CLI** | Interactive REPL and one-shot runs in your terminal | `npm install -g cascade-ai` — [Quick Start](#quick-start) |
| **Desktop app** | Chat, a live Cockpit of the agent tree, a code editor with a terminal, and a browser the agent can drive | [cascadeai.in/download](https://cascadeai.in/download) |
| **Cascade Cloud** | Hosted chat, bring your own keys — files, memory, generated documents, browser control | [cascadeai.in](https://cascadeai.in) |
| **Self-host** | The Cloud web app on your own machine | `docker compose up` — [Self-host](#self-host) |
| **OpenAI-compatible API** | `POST /v1/chat/completions` for any OpenAI SDK | [OpenAI-compatible API](#openai-compatible-api) |
| **SDK** | `runCascade()` / `createCascade()` from Node | [SDK](#sdk--programmatic-use) |

The CLI, desktop app and Cascade Cloud share one account and one set of end-to-end-encrypted settings.

## ✨ Highlights

- 🧠 **Live benchmark Auto-routing** — set a tier to `Auto` and Cascade fuses *live* public benchmark scores with *live* pricing to pick the best-**value** model for each task, then learns from how each model actually did.
- 🌐 **Browser control** — the agent drives a real browser (local Chrome over CDP, or a hosted Steel session), you watch it live, and you can take the wheel and hand it back.
- 🙋 **Asks instead of guessing** — when a request is genuinely ambiguous, Cascade asks one structured question rather than inventing an answer.
- 🤖 **Autonomous mode** (`/auto`) — hands-off runs: safe tools run silently, dangerous ones still ask, budget caps stay the hard stop.
- 📋 **Boardroom plan review** — pause to review, **edit**, or steer T1's plan (with an AI reviewer's critique) before any worker spawns.
- ⏯️ **Run resumability** (`/continue`) — hit the budget cap on a big task? Resume from the partial state instead of redoing it.
- 👥 **Workers recruit help** — a worker can ask its manager to spawn bounded sibling workers when the work fans out — dynamic parallelism, no rigid plan.
- 💸 **Delegation savings** — every run shows what the hierarchy saved you (`saved $5.63 — 90% vs. all-T1`); no flat-agent tool can show this number.
- 🛡️ **Safe by default** — permission escalation (T3→T2→T1→you), SSRF-guarded fetch, loopback-only dashboard, and a budget kill-switch.

## Why Cascade is one of a kind

Other AI CLIs run a single agent. Cascade runs a visible **organization** — and the terminal shows you the org at work:

- **Delegation savings** — the status bar and every run receipt show what the hierarchy saved you (`$0.031 · saved $0.094 — 75% vs. all-T1`), because cheap T3 workers (free, when they are local) do the heavy lifting while a premium T1 model only administrates. No flat-agent tool can show this number.
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

Cascade has shipped roughly 70 releases since v0.13.2 and is now at **v0.82.0**. Grouped by theme rather than listed one-by-one; [CHANGELOG.md](CHANGELOG.md) has every change.

### v0.69 – v0.82 — the agent gets a browser, and every surface gets an API
- **Browser control, on every surface.** The agent can drive a real browser — your own Chrome over CDP, or a hosted [Steel](https://steel.dev) session — act on the page you already have open, and show it to you live. You can take the browser off the agent, use it yourself, and hand it back (v0.78 – v0.81). A Browser chip beside Web in the composer turns it on per message.
- **Asks instead of guessing.** A run that needs a decision only you can make asks one structured question and waits, rather than guessing (v0.81). A run that *cannot* do something now says so instead of simulating the result (unreleased).
- **An OpenAI-compatible API** — `POST /v1/chat/completions` and `GET /v1/models`, so any OpenAI SDK can call Cascade (v0.70) — and **one-command self-hosting** with `docker compose up` (v0.69).
- **Routing that learns carefully.** Every model a tier used records the run's outcome, only models that actually ran are rated, one bad moment no longer writes a model off, and the router occasionally tries a plausible alternative so it can learn (v0.76). Benchmark data now covers every modality, not just text (v0.82).
- **Failover that tells failures apart.** An exhausted quota, a rate limit, a model your key cannot use and a dead account are each handled as what they are — one Azure deployment's failure no longer disables the others, and a failed-over answer is credited to the model that actually ran (v0.76).
- **Credentials handled as pairs.** A gateway bearer (`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`) and the endpoint that issued it are adopted, synced and sent together, never to another host; Claude subscription tokens are refused everywhere (v0.75).
- **Security hardening.** The SSRF guard re-checks the address at connect time and blocks IPv6 forms that carry an IPv4 address (v0.77); dependency advisories went from 33 to 25 (v0.82); secret redaction catches more (unreleased).
- **Chat polish.** Generated PowerPoint decks animate (v0.76). Unreleased: maths is typeset whichever way the model writes it (`\(…\)`, `\[…\]`, `$…$`, bare `\begin{align*}`) while prices stay prices, and long answers stream without slowing the chat.

### v0.68 — a typed task graph, durable resume, and mechanical verification
- **One dependency scheduler for the whole hierarchy.** T1's section dispatch and T2's subtask execution now both compile onto the same typed task graph (`compileTaskGraph` + `DependencyScheduler`) instead of two separate hand-rolled implementations — pinned by a parity harness across 600 generated graphs so ordering didn't silently change.
- **Failure-aware dependency contracts.** A section that depends on one that failed is now skipped rather than run into the same wall — reported with the chain that blocked it, and costing no tokens, instead of starting anyway and billing for a run that was doomed before it began. A degraded (`PARTIAL`) result doesn't block; only a hard failure does.
- **Durable resume across crashes, cancellation, and budget caps.** Checkpoints are now written for every way a run can stop, not just the budget cap, so `/continue` picks a run back up after a crash or Ctrl-C — finished sections are restored as fact and only the remainder gets re-planned.
- **A deterministic rung on the verification ladder.** Acceptance criteria that can be checked mechanically ("file exists," "contains X") are now settled by looking, before a model is ever asked to grade them — cheaper, faster, and immune to a model believing its own claim that a file was written. Ambiguous criteria still fall through to the model.
- **The desktop app is now a real download from the site**, not a GitHub releases page listing twenty build artifacts — platform and architecture are detected, size and version are shown, and stable per-platform links (`/download/mac-arm64`, `/download/win-x64`) mean a shared link never goes stale.

### Cascade Cloud, native login, and one identity across CLI, desktop, and web (v0.20 – v0.45)
- **Cascade Cloud** launched as a hosted, bring-your-own-key chat surface (now at [cascadeai.in](https://cascadeai.in)) — multimodal input, persistent memory, and file generation that now produces real, editable Office documents and charts (`.docx`/`.pptx`/`.xlsx`), not markdown text saved under the wrong extension.
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

A Complex task runs through all three agent tiers:

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

**Complexity decides how much of the organization a task gets.** A classifier (with cheap heuristics first) grades each prompt, and only the tiers the work needs are spun up:

| Complexity     | Tiers in play | Shape |
|----------------|---------------|-------|
| Simple         | T3            | One worker answers directly — small talk gets a direct answer with no worker at all |
| Moderate       | T2 → T3       | One manager and its workers, no planner |
| Complex        | T1 → T2 → T3  | T1 plans 3–5 sections, one T2 manager each |
| Highly Complex | T1 → T2 → T3  | 5+ sections |

`/why` shows the verdict and the reasoning for the last run.

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
- Anthropic (Claude), including gateways reached through `ANTHROPIC_BASE_URL`
- OpenAI (GPT)
- Google Gemini
- Azure OpenAI (any number of deployments, across resources)
- OpenAI-compatible endpoints (OpenRouter, Groq, DeepSeek, xAI, Mistral, Together, Fireworks, llama.cpp, vLLM, LM Studio…)
- Ollama — local models, used when they are what you have, when you pin them, or when a `privacy.paths` rule forces local-only

Models are discovered from each provider at startup, so new releases compete in routing without a Cascade update.

### Tools (T3 Workers)
- **Shell and code** — shell commands with allowlist/blocklist, and a `run_code` interpreter (Python/Node)
- **Files and search** — read, write, edit, delete, list, glob, grep, and `code_search` over a local code index (`cascade index`)
- **Git / GitHub / GitLab** — status, diff, commit, push; open PRs, list and comment on issues
- **Web** — `web_search` and SSRF-guarded `web_fetch`
- **Browser** — Playwright automation, plus `browser_control` of a real browser (CDP or Steel) and `read_current_page`
- **Media** — analyze images; generate images, speech and video; transcribe audio
- **Documents** — real `.docx` / `.pptx` / `.xlsx` and PDFs, with charts and embedded images
- **Collaboration** — `ask_user` for a structured question, `peer_message` between workers, `knowledge_graph_search` over project facts
- **Your own** — MCP servers' tools, plugins, and (opt-in) tools the agent writes for itself, sandboxed in a V8 isolate where the optional `isolated-vm` addon is installed, a worker otherwise

### Developer Experience
- **6 color themes** — midnight (default), aurora, daybreak, bloom, tide, ember
- **`CASCADE.md`** — project-level instructions for agents
- **`.cascadeignore`** — files agents cannot touch
- **MCP support** — connect any Model Context Protocol server
- **Hooks** — shell scripts on pre/post tool use *(configured, not yet run by the engine — see [Hooks](#hooks))*
- **Session history** — searchable, exportable (markdown / JSON)
- **Audit log** — every tool call, file change, and agent decision
- **Cost tracker** — real-time per-session token + USD cost
- **Scheduled tasks** — cron-based automated runs, run by the dashboard server

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
    "t3": "llama3.2:3b"          // pin a tier; leave it out to keep that tier on Auto
  },
  "autoBias": "balanced",        // Auto's trade-off: "balanced" | "quality" | "cost"
  "tools": {
    "shellAllowlist":     [],
    "shellBlocklist":     ["sudo rm", "rm -rf", "mkfs"],
    "requireApprovalFor": ["shell", "file_write", "file_delete"],
    "browserEnabled":     false,
    "mcpServers": [
      { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
    ]
  },
  "dashboard": {
    "host":     "127.0.0.1",
    "port":     4891,
    "auth":     true,
    "teamMode": "single"
  },
  "theme":  "midnight",
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
| Anthropic | `ANTHROPIC_API_KEY` — or a gateway's `ANTHROPIC_AUTH_TOKEN` with its `ANTHROPIC_BASE_URL` |
| OpenAI    | `OPENAI_API_KEY`     |
| Gemini    | `GOOGLE_API_KEY` (`GEMINI_API_KEY` via `cascade link`) |
| Azure     | `AZURE_OPENAI_API_KEY` or `AZURE_OPENAI_KEY`, with `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_DEPLOYMENT` |

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

### Model routing

Each tier draws from its own class of model: frontier models for T1's planning, mid-size models for T2's management, and small, fast models for T3's work. With **Auto** (the default), Cascade picks within that class per task, by public benchmark scores for the task type weighed against live pricing (`autoBias` sets the trade-off), and adjusts from how each model actually performed. `cascade stats` shows what it has learned, and `/rate good | bad` teaches it.

- **Pin a tier** with `"models"` in config, `/model` in the REPL, or `cascade models set t1 anthropic:<model>`.
- **Local models** are used when they are all you have, when you pin them, or when a `privacy.paths` rule keeps a folder local-only.
- **Failover** is per failure type: a rate limit backs off, an exhausted quota or a model your key cannot use is routed around, and a recovered provider is used again.

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

| Tool | Description | Dangerous |
|------|-------------|-----------|
| `shell` | Execute shell commands (allowlist / blocklist) | ✓ |
| `run_code` | Run Python or Node code | ✓ |
| `file_read` · `file_list` | Read a file (optional line range); list a directory | |
| `file_write` · `file_edit` · `file_delete` | Write, exact-string edit, delete | ✓ |
| `glob` · `grep` | Find files by pattern; search their contents | |
| `code_search` | Search the workspace code index built by `cascade index` | |
| `git` | status, diff, log, add, commit, push, pull, … | ✓ |
| `github` | Open PRs, list and comment on issues (GitHub / GitLab) | ✓ |
| `web_search` | Search the web (SearXNG, Brave or Tavily) | |
| `web_fetch` | Fetch a page, SSRF-guarded | |
| `browser` | Headless Playwright automation (off unless `tools.browserEnabled`) | ✓ |
| `browser_control` | Drive a real browser over CDP or a Steel session | ✓ |
| `read_current_page` | Read the page you have open in the browser | |
| `image_analyze` | Describe an image (vision-capable models) | |
| `generate_image` · `generate_speech` · `generate_video` | Generate media | |
| `transcribe_audio` | Speech-to-text for an audio file | |
| `generate_document` | Render a REAL `.docx` / `.pptx` / `.xlsx` from Markdown or CSV | ✓ |
| `pdf_create` | Render a PDF | ✓ |
| `knowledge_graph_search` | Query the project's knowledge graph of facts | |
| `peer_message` | Message a sibling worker | |
| `ask_user` | Ask you one structured question instead of guessing | |

MCP servers' tools, plugins and dynamic tools join this list at runtime.

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
cascade [options]                    Start the interactive REPL
cascade run <prompt>                 Run a single prompt and exit
cascade init [path]                  Initialize Cascade in a directory
cascade doctor                       Diagnose API keys, Ollama, config
cascade link [provider]              Reuse credentials from Claude Code / Codex / Gemini / Copilot
cascade models [action] [tier] [v]   List models per tier, or set/unset a tier's model
cascade stats                        Auto-routing history: which models work best per task type
cascade index [path]                 Build or refresh the code index (powers code_search)
cascade export                       Export a session to Markdown or JSON
cascade identity list|create|set-default   Manage identities
cascade mcp connect <url>|list|remove      Connect remote MCP servers over OAuth
cascade dashboard                    Launch the local web dashboard
cascade telemetry [on|off|status]    Anonymous usage telemetry (off by default)
cascade update                       Update to the latest version
```

**Cascade Cloud account** — the same account the desktop and web apps use:

```
cascade login | logout | whoami      Sign in to Cascade Cloud on this machine
cascade sync push | pull             Encrypt and upload / download your settings (keys, prefs)
cascade sessions                     List your cloud chats
cascade show <id>                    Print a chat transcript with branch markers
cascade branch <chat> <message>      Switch a chat to another branch
cascade rename <chat> <title>        Rename a chat
cascade rm <chat> <message>          Delete a message and its subtree
cascade delete <chat>                Delete a chat
```

**Options:**

```
-p, --prompt <text>    Single prompt (non-interactive mode)
-t, --theme  <name>    Color theme (see Themes)
-w, --workspace <path> Workspace path (default: cwd)
-i, --identity <name>  Identity to run as
-v, --version          Show version
    --alt-screen       Vim-style alternate screen (flicker-proof; PgUp/PgDn history)
    --no-color         Disable colors
```

---

## Slash Commands

Type any of these inside the REPL:

| Command | Description |
|---------|-------------|
| **Session** | |
| `/help` · `/exit` · `/clear` | Commands, exit, clear the conversation |
| `/sessions` · `/resume <id>` · `/search` | List, resume and search past sessions |
| `/branch` | Fork the session into parallel branches |
| `/compact` | Summarize and compress context now |
| `/export [markdown\|json]` · `/copy [n]` | Export the session; copy the last (or nth-last) response |
| `/retry` | Retry the last prompt |
| `/rollback` | Undo all file changes made in this session |
| **Running work** | |
| `/plan <prompt>` | Preview the plan without running it |
| `/replan [guidance]` | One corrective re-plan pass on the last task |
| `/steer <correction>` | Steer the workers of a running task |
| `/auto [on\|off\|status]` | Autonomous mode: safe tools run silently, dangerous ones still ask |
| `/continue [tokens]` | Resume the last task that hit the budget cap, with a raised budget |
| `/budget [set <$> \| clear]` | Session budget cap |
| **Seeing inside** | |
| `/status` · `/tree` | Live agent tree; execution timeline panel |
| `/comms` | Live agent-to-agent comms feed |
| `/why` | How the last run was routed: complexity, models, failovers |
| `/cost` | Session cost, tokens and delegation savings |
| `/logs` · `/diagnose` | Recent runtime logs; provider/model/config health checks |
| `/audit` | Verify the tamper-evident audit log |
| **Models and setup** | |
| `/model` | Pick a provider and model for a tier (or Auto) |
| `/model-info` · `/models` · `/providers` | Active models per tier; available models; configured providers |
| `/rate good\|bad` | Rate the last task, to improve Auto-routing |
| `/config` · `/mcp` · `/identity` · `/theme <name>` | Configuration summary, MCP servers, identity, theme |

> **Selection & copy:** mouse capture stays off, so native drag-select and right-click copy work in your terminal. When idle, the screen never repaints under you; `/copy` covers the one case selection can't — grabbing text while output is still streaming (with an OSC 52 fallback that works over SSH).

---

## Themes

Switch with `/theme <name>` in the REPL or set `"theme"` in config.

| Theme | Style | Former name |
|-------|-------|-------------|
| `midnight` | Default — azure → sky → teal, matching T1 → T2 → T3 | `cascade` |
| `aurora` | Dark | `dark` |
| `daybreak` | Light | `light` |
| `bloom` | Dracula-like | `dracula` |
| `tide` | Nord-like | `nord` |
| `ember` | Solarized-like | `solarized` |

The former names still work.

---

## Web Dashboard

```bash
cascade dashboard
# → http://localhost:4891
```

Set `CASCADE_DASHBOARD_PASSWORD` (or `CASCADE_DASHBOARD_PASSWORD_HASH`) first: there is no default password, and with auth on and none set, sign-in is refused. The dashboard binds to `127.0.0.1` unless you change `dashboard.host`.

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

```bash
cascade mcp connect https://mcp.example.com/sse   # remote server, OAuth login in your browser
cascade mcp list
cascade mcp remove <name>
```

Local (stdio) servers go in config, under `tools.mcpServers` — see [Configuration](#configuration). Or connect one programmatically:

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

> **Not active yet.** The `hooks` config below is validated, and the runner is exported from the SDK as `HooksRunner`, but runs do not call it yet — so these scripts do not fire today. Wiring it in is on the [Roadmap](#roadmap).

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

`preTask` runs before a task starts, like `postTask` after it. Environment variables injected: `CASCADE_TOOL`, `CASCADE_INPUT`, `CASCADE_OUTPUT`.

---

## Memory & Identity

Cascade stores session history, identities, and audit logs in `.cascade/memory.db` (SQLite).

### Identities

Create multiple named identities with different system prompts and default models:

```bash
cascade identity create reviewer -s "You are strict about best practices."
cascade identity list
cascade identity set-default reviewer
cascade -i reviewer            # run as one identity for this session
```

### Session export

```
/export markdown    → session-2026-04-02.md
/export json        → session-2026-04-02.json
```

---

## Security

### Keystore

API keys go to your OS keychain (macOS Keychain, Windows Credential Vault, libsecret) when one is available. Otherwise they are kept in `.cascade/keystore.enc`, encrypted with **AES-256-GCM** under a PBKDF2-derived key (100,000 iterations) — useless without your master password. Keys get there through `cascade link`, the `/model` picker, desktop Settings, or `cascade sync pull`; synced settings are end-to-end encrypted, so the server holds only ciphertext.

### What else keeps a run contained

- **Permission escalation** — a worker that needs more than it was given asks up the chain, T3 → T2 → T1 → you.
- **SSRF-guarded fetching** — `web_fetch`, dynamic tools and hosted search backends cannot reach private or link-local addresses, checked again at connect time.
- **Secret redaction** — secrets and PII are stripped from a worker's output before it travels up the hierarchy.
- **Privacy paths** — `privacy.paths` forces local models for sensitive folders and can withhold their content from upstream tiers.
- **Tamper-evident audit log** — encrypted and hash-chained; `/audit` verifies it.
- **Budget kill-switch** — a run stops at its budget cap (`/budget`), resumable with `/continue`.

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
src/                    The engine — published to npm as `cascade-ai`
├── core/
│   ├── tiers/          T1Administrator, T2Manager, T3Worker
│   ├── orchestration/  Typed task graph, dependency scheduler, durable resume
│   ├── router/         Auto-routing: benchmarks, pricing, learned outcomes, failover
│   ├── verification/   Acceptance checks — mechanical first, a model only when needed
│   ├── knowledge/      Project knowledge graph (world state) and session memory
│   ├── privacy/        Per-path privacy tiers
│   ├── audit/          Secret redaction and the tamper-evident audit log
│   ├── permissions/    Escalation T3 → T2 → T1 → you
│   ├── steering/ peer/ Live steering; worker-to-worker messages
│   ├── documents/      Shared Office/PDF renderers (also used by the web app)
│   ├── markdown/       Shared chat Markdown steps (maths, streaming pace)
│   └── cascade.ts      Main Cascade class (EventEmitter facade)
├── providers/          Anthropic, OpenAI, Gemini, Azure, Ollama, OpenAI-compatible
├── tools/              Shell, code, files, search, git, web, browser, media, documents
├── browser/            Browser leases and remote (CDP / Steel) sessions
├── retrieval/          Code index and retrieval behind code_search
├── cli/                Ink REPL, slash commands, themes, commands
├── cloud/              Cloud client and end-to-end-encrypted key sync
├── config/             Config schema, keystore, credential discovery and linking
├── memory/             SQLite store (sessions, identities, audit, scheduler)
├── dashboard/          Local dashboard server (Express, JWT, Socket.io)
├── audit/ hooks/ mcp/ scheduler/ notifications/ telemetry/
├── sdk/                runCascade(), createCascade(), streamCascade()
└── index.ts            Package exports

app/                    Desktop app (Electron + React): chat, Cockpit, code editor, browser
cloud/
├── server/             Cascade Cloud API, auth, billing, OpenAI-compatible /v1, docs
└── web/                Cascade Cloud chat UI (React + Vite)
web/                    Local dashboard SPA (ReactFlow agent graph)
```

---

## Roadmap

**Shipped**

| Status | Feature |
|--------|---------|
| ✓ | T1/T2/T3 hierarchical orchestration, sized to the task |
| ✓ | 6 AI providers + Ollama |
| ✓ | Provider failover with automatic recovery |
| ✓ | Streaming REPL (ink) |
| ✓ | Live agent tree visualization |
| ✓ | Encrypted keystore (OS keychain, AES-256-GCM fallback) |
| ✓ | Web dashboard + WebSocket |
| ✓ | MCP client, with OAuth for remote servers (`cascade mcp connect`) |
| ✓ | Scheduled tasks (run by the dashboard server) |
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
| ✓ | Project knowledge graph (world-state v2) — queryable facts T1 plans from; `knowledge_graph_search` (v0.14) |
| ✓ | Hard sandbox for agent-written tools — a V8 isolate via `isolated-vm`, worker fallback (v0.14) |
| ✓ | Cascade Cloud (hosted chat — GitHub/Google login, bring-your-own-key, [cascadeai.in](https://cascadeai.in)) |
| ✓ | Cascade Cloud billing — Razorpay subscriptions, Free and Pro plans |
| ✓ | Desktop app — chat, Cockpit, code editor + terminal, browser; downloads from the site |
| ✓ | End-to-end-encrypted settings sync across CLI, desktop and web |
| ✓ | Typed task graph with durable resume after a crash, cancel or budget cap (v0.68) |
| ✓ | Self-host with `docker compose up` (v0.69) |
| ✓ | OpenAI-compatible API — `/v1/chat/completions`, `/v1/models` (v0.70) |
| ✓ | Browser control — CDP or Steel, live view, take over and hand back (v0.78 – v0.81) |
| ✓ | Ask-before-guessing — one structured question instead of an invented answer (v0.81) |
| ✓ | Code index and `code_search` (`cascade index`) |
| ✓ | Media generation (image, speech, video) and audio transcription |

**Next**

| Status | Feature |
|--------|---------|
| 🔜 | Hooks — the config and `HooksRunner` exist; runs do not call them yet |
| 🔜 | Task-completion notifications and webhooks (Slack / Discord / custom URL) — a `NotificationManager` exists but nothing sends through it |
| 🔜 | OS-level jail for `shell` and `run_code` — bubblewrap / sandbox-exec / Docker, on top of approvals — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | Cross-session history research — a prior-work brief before T1 plans — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | VSCode extension (`cascade-vscode`) — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | JetBrains extension (`cascade-jetbrains`) — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | Multi-plan branching (T1 proposes N plans) — see [docs/ROADMAP.md](docs/ROADMAP.md) |
| 🔜 | Plugin marketplace (plugins load from a config list today) |
| 🔜 | Voice input in chat (audio files can already be transcribed with `transcribe_audio`) |
| 🔜 | Multi-workspace support (the desktop switches its one workspace live today) |
| 🔜 | Smaller follow-ups: steering history in the transcript, custom redaction patterns, a per-run privacy report — see [docs/ROADMAP.md](docs/ROADMAP.md) |

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
npm run dev            # watch mode for the CLI
npm run build          # build CLI + web dashboard
npm run dev:web        # hot-reload dashboard at web/
npm run dev:app        # desktop app (Electron) in dev mode
npm run build:app      # build the desktop app
npm run dev:cloud      # Cascade Cloud server
npm run dev:cloud-web  # Cascade Cloud web UI
npm test               # vitest (engine, desktop logic)
npm test -w cascade-cloud-web   # Cloud web UI tests
npm run lint           # tsc --noEmit, including the desktop app
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

Cascade AI is released under the [MIT License](LICENSE). Copyright © 2026 Varun SV.
