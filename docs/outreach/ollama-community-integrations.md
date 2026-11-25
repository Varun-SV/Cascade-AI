# Ollama: Community Integrations listing

Status: **draft, not submitted.**

Target: https://github.com/ollama/ollama, file `README.md`, section `## Community Integrations` (which opens with "Want to add your project? Open a pull request.").

Format sources (read 2026-11-25):
- https://raw.githubusercontent.com/ollama/ollama/main/README.md
- https://raw.githubusercontent.com/ollama/ollama/main/CONTRIBUTING.md

## Format rules observed

- One bullet per project: `- [Name](link) - short description`. The separator is a spaced hyphen, not parentheses. Some entries add a trailing `([docs](...))`; that is optional.
- Descriptions are short, one clause, no trailing period.
- Entries are **not** alphabetical. Newer entries are appended at the end of their sub-section.
- Sub-sections under Community Integrations: Chat Interfaces (Web, Desktop, Mobile), Code Editors & Development, Libraries & SDKs, Frameworks & Agents, RAG & Knowledge Bases, Bots & Messaging, Terminal & CLI, Productivity & Apps, Observability & Monitoring, Database & Embeddings, Infrastructure & Deployment (Cloud, Package Managers).
- CONTRIBUTING.md has no README-listing rule. It says small documentation updates are welcome and large ones are harder to review. PR titles should be `<package>: <short description>`, where the package may be a single well-known root file's name, and the description starts lowercase and completes "This changes Ollama to...". There is no PR template in the repo.

## Where it goes

Sub-section `### Terminal & CLI`, as the last entry. Cascade is installed with npm and run from a terminal, so this fits better than `Frameworks & Agents`. The alternative is `### Productivity & Apps`, whose tail already holds coding agents such as VT Code and oxi.

Current end of `### Terminal & CLI` (insert after the `VT` line):

```markdown
- [ShellOracle](https://github.com/djcopley/ShellOracle) - Shell command suggestions
- [LLM-X](https://github.com/mrdjohnson/llm-x) - Progressive web app for LLMs
- [cmdh](https://github.com/pgibler/cmdh) - Natural language to shell commands
- [VT](https://github.com/vinhnx/vt.ai) - Minimal multimodal AI chat app
```

## The line to add

```markdown
- [Cascade AI](https://github.com/Varun-SV/Cascade-AI) - Terminal tool that splits one prompt across planner, manager and worker agents, with support for local Ollama models
```

Result:

```markdown
- [VT](https://github.com/vinhnx/vt.ai) - Minimal multimodal AI chat app
- [Cascade AI](https://github.com/Varun-SV/Cascade-AI) - Terminal tool that splits one prompt across planner, manager and worker agents, with support for local Ollama models
```

What the code supports (checked against the repo at the base commit): an `ollama` provider type that talks to Ollama's native `/api/chat`, `/api/show` and `/api/tags` endpoints (`src/providers/ollama.ts`), default URL `http://localhost:11434` (`src/constants.ts`), an Ollama step in `cascade setup`, and `cascade doctor` checking Ollama. The README's "Local models" section documents it.

## PR title

```
README: add Cascade AI to community integrations
```

## PR body

```markdown
Adds Cascade AI to Community Integrations, under Terminal & CLI.

Cascade AI is an open-source (MIT) command-line tool that splits one prompt across planner, manager and worker agents. It can use a local Ollama server through Ollama's native API: `cascade setup` offers an Ollama provider, and `cascade doctor` checks for it at `localhost:11434`.

It is in early access.

- Repo: https://github.com/Varun-SV/Cascade-AI
- Local models docs: https://github.com/Varun-SV/Cascade-AI#local-models-ollama-and-openai-compatible-endpoints

The entry is appended to the end of the section, matching how the list is currently ordered. README-only change; no code or dependencies touched.
```
