# Cascade AI Wiki

**One prompt → a coordinated team of AI agents.**

Welcome to the documentation for [Cascade AI](https://github.com/Varun-SV/Cascade-AI), a TypeScript/Node.js multi-agent orchestration system. Cascade sizes the agent hierarchy to the task, routes work across configured models, and offers CLI, desktop, hosted web, self-hosted web, SDK, and OpenAI-compatible API interfaces.

**Start here:** [[Getting-Started]] · [[Architecture]] · [[CLI-Reference]] · [[Cloud-and-Self-Hosting]]

## Choose your path

| Goal | Guide |
| --- | --- |
| Install and run your first task | [[Getting-Started]] |
| Understand T1 → T2 → T3, planning, and resumability | [[Agent-Orchestration]] |
| Choose providers, Auto routing, and spending limits | [[Models-and-Budgets]] |
| Learn terminal commands and interactive REPL | [[CLI-Reference]] |
| Use the Electron app | [[Desktop-App]] |
| Deploy the web app and its API | [[Cloud-and-Self-Hosting]] |
| Integrate a client using the SDK or HTTP API | [[API-and-SDK]] |
| Use shell, files, MCP, browser, and media | [[Tools-and-MCP]] · [[Browser-Control]] · [[Files-and-Media]] |
| Understand credentials, permissions and trust boundaries | [[Security-and-Privacy]] |
| Run tests, contribute, or troubleshoot | [[Development]] · [[Troubleshooting]] |

## Runtime surfaces

| Surface | Primary purpose | Important boundaries |
| --- | --- | --- |
| CLI | Interactive Ink terminal UI and one-shot tasks | The live human-controlled browser tool is not a CLI feature |
| Desktop (Electron + React) | Chat, agent Cockpit, editor, terminal, integrated browser | Local desktop tools can act on the user's workspace subject to controls |
| Cloud web (React + Vite) | Hosted authenticated chat, memory, files, connectors | Hosted browser needs an operator-configured CDP or Steel backend |
| Self-hosted web | Own deployment of cloud/server + cloud/web | Requires safe authentication and persistent data storage |
| SDK | Run orchestration within Node programs | Host application supplies configuration, credentials and approval policy |
| OpenAI-compatible /v1 | Existing SDK/client integration | Cascade model identifiers represent routing modes; not complete OpenAI API parity |

## Documentation policy

This wiki tracks **merged `main` code**, not open PRs or speculative roadmap items. Source-linked guides explain differences between runtime surfaces. The authoritative implementation, install requirements and release details are in [the repository](https://github.com/Varun-SV/Cascade-AI), [README](https://github.com/Varun-SV/Cascade-AI/blob/main/README.md), and [CHANGELOG](https://github.com/Varun-SV/Cascade-AI/blob/main/CHANGELOG.md). A scheduled [[Weekly-Code-Changes]] page summarizes newly merged code; individual pages should be updated when behavior changes.

**Documentation baseline:** `main`, package version **0.82.0**, inspected October 14, 2026. Version is a snapshot, not a promise that the latest release remains at that version.
