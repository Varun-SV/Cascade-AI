# Getting Started

## Requirements

- **Node.js 22.22.2 or newer** (the version constraint in root `package.json`).
- At least one configured AI provider, or a reachable local Ollama instance.
- Git for repository-oriented tasks; Docker and Docker Compose for self-hosting.
- Your own API keys for third-party models; usage is billed by those providers.

## Install the CLI

```bash
npm install -g cascade-ai
mkdir my-project && cd my-project
cascade init
cascade doctor
cascade
```

Within the REPL, use `/model` to choose provider → tier → model, or leave the tiers in Auto. Try:

```text
Explain this project and propose three safe refactors.
```

For a non-interactive command:

```bash
cascade run "Explain the authentication design in this directory"
```

Use `cascade --help`, `/help` and [[CLI-Reference]] for exact commands. The project config is `.cascade/config.json`. Credentials may be set in environment variables or discovered by supported linking commands; do not commit secrets to the project.

## Provider examples

| Provider | Typical setup |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GOOGLE_API_KEY`; credential linking also understands Gemini-specific env names |
| Azure OpenAI | Endpoint, deployment, and Azure key in config / supported env vars |
| Ollama | A local Ollama server, normally `localhost:11434` |
| OpenAI-compatible | Configure `baseUrl` and model; explicitly mark `local` when appropriate |

Verify any connection with `cascade doctor` before spending time debugging a run. A provider with a key but no model access may still fail; model selection and failure recovery are discussed in [[Models-and-Budgets]].

## Other ways to use Cascade

- Desktop installers: [cascadeai.in/download](https://cascadeai.in/download).
- Hosted chat: [cascadeai.in](https://cascadeai.in).
- Self-hosted cloud UI: [[Cloud-and-Self-Hosting]].
- Programmatic Node/HTTP: [[API-and-SDK]].

## First-run precautions

1. Point Cascade at a workspace you control and use read-only exploration before changing files.
2. Review dangerous tool approvals. Do not start with autonomous mode for unfamiliar code.
3. Configure a spending cap where appropriate; follow model costs and run decisions with `/cost` and `/why`.
4. If using a locally deployed login bypass, keep the server bound to loopback. Never expose it to the LAN or public internet.

Sources: [README install/config/quick start](https://github.com/Varun-SV/Cascade-AI/blob/main/README.md), [root package requirements](https://github.com/Varun-SV/Cascade-AI/blob/main/package.json), [CLI implementation](https://github.com/Varun-SV/Cascade-AI/blob/main/src/cli/index.ts).
