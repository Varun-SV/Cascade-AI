# CLI Reference

The published npm command is `cascade` (Node 22.22.2+). Run `cascade --help` for installed-version details.

## Top-level commands

| Command | Function |
| --- | --- |
| `cascade` | Open interactive Ink REPL |
| `cascade run "prompt"` | Execute one prompt |
| `cascade init [path]` | Initialize project configuration |
| `cascade doctor` | Check configuration, providers and Ollama |
| `cascade link [provider]` | Discover/link supported CLI credentials |
| `cascade models` | Browse and configure tier model assignments |
| `cascade stats` | View model routing performance |
| `cascade index [path]` | Build project code index |
| `cascade export` | Export session to Markdown/JSON |
| `cascade dashboard` | Start loopback-only dashboard (default port 4891) |
| `cascade login / logout / whoami` | Cloud account identity |
| `cascade sessions` | List, show, branch, rename and delete cloud chats |
| `cascade sync push / pull` | Opt-in encrypted settings transfer |
| `cascade mcp connect / list / remove` | Manage MCP servers |
| `cascade identity` | Manage identities |
| `cascade telemetry` | Enable, disable or inspect opt-in telemetry |
| `cascade update` | Check and install latest version |

CLI options include `--prompt`, `--workspace`, `--theme`, `--identity`, `--alt-screen`, and `--no-color`.

## REPL quick reference

| Group | Commands |
| --- | --- |
| Session | `/help`, `/exit`, `/sessions`, `/resume`, `/search`, `/branch`, `/retry`, `/rollback`, `/compact`, `/export`, `/copy` |
| Running tasks | `/plan`, `/replan`, `/steer`, `/auto`, `/continue`, `/budget` |
| Inspect | `/status`, `/tree`, `/comms`, `/why`, `/cost`, `/logs`, `/diagnose`, `/audit` |
| Models | `/model`, `/models`, `/providers`, `/rate good`, `/rate bad` |
| Configuration | `/config`, `/mcp`, `/identity`, `/theme` |

## Example workflow

```bash
cascade init
cascade doctor
cascade models
cascade run "Find the cause of the failing tests. Do not change files."
cascade export --format markdown
```

## Configuration and tooling

- Project config: `.cascade/config.json`; read its schema before hand-editing.
- Use `.cascadeignore` to limit indexed/readable workspace content.
- Enable and construct `code_search` with `codeIndex.enabled` and `cascade index`.
- `--alt-screen` enables alternate-screen rendering; session history scrolls inside the UI in this mode.
- Terminal automation may require approvals and user input. Browser control of the user's live desktop window belongs to the Electron app, not the terminal REPL.

Source: [Commander commands](https://github.com/Varun-SV/Cascade-AI/blob/main/src/cli/index.ts), [slash command registry](https://github.com/Varun-SV/Cascade-AI/blob/main/src/cli/slash/index.ts), [README CLI sections](https://github.com/Varun-SV/Cascade-AI/blob/main/README.md).
