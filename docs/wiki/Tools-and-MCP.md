# Tools and MCP Connectors

Most concrete work happens in T3 workers. Tools are configured by runtime and permissions—not every tool is available on every surface.

## Tool families

| Family | Examples | Notes |
| --- | --- | --- |
| Workspace | `file_read`, `file_write`, `file_edit`, `file_delete`, `file_list`, `glob`, `grep` | Respect workspace and ignore rules; writes are dangerous |
| Code | `run_code`, `code_search` | `code_search` needs index enabled/built |
| Terminal/Git | `shell`, `git`, `github` | Effects outside the model are subject to approval |
| Web | `web_search`, `web_fetch` | External fetch uses SSRF protection |
| Browser | `browser`, `browser_control`, `read_current_page` | Mode and runtime differ; see [[Browser-Control]] |
| Documents | `generate_document`, `pdf_create` | Office formats must be rendered as real binary formats |
| Media | `image_analyze`, `generate_image`, `generate_speech`, `generate_video`, `transcribe_audio` | Needs capable provider/model |
| Coordination | `peer_message`, `ask_user` | `ask_user` supported in cloud web/self-hosted web |

## Permission model

Avoid assuming prompt text grants tool authority. Shell/write/delete and browser actions can require user approval. Commands may be constrained with `tools.shellAllowlist` and `tools.shellBlocklist`. The configuration schema is authoritative for switch names and defaults.

## MCP: local or remote

MCP servers extend T3 tools. Local stdio server example in `.cascade/config.json`:

```json
{
  "tools": {
    "mcpServers": [
      {
        "name": "filesystem",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
      }
    ],
    "mcpTrusted": ["filesystem"]
  }
}
```

Remote MCP supports OAuth where the remote server offers it; CLI commands:

```bash
cascade mcp connect https://mcp.example.com/sse
cascade mcp list
cascade mcp remove example
```

Cloud web connectors can also use operator-registered OAuth brokers (e.g., GitHub) when the server lacks dynamic client registration. OAuth tokens have different at-rest handling in cloud, desktop and CLI.

## Scope cautions

- Untrusted remote MCP URLs are not automatically allowed to reach private/loopback hosts.
- Web hosted tool permissions and local machine permissions differ.
- The plugin registration interface is present, but some advanced plugin lifecycle functionality remains roadmap/stub work.
- Never paste secret tokens into issues or wiki examples.

Sources: [tool registry](https://github.com/Varun-SV/Cascade-AI/blob/main/src/tools/registry.ts), [MCP OAuth](https://github.com/Varun-SV/Cascade-AI/blob/main/docs/mcp-oauth.md), [connect broker](https://github.com/Varun-SV/Cascade-AI/blob/main/docs/connectors-broker.md), [config schema](https://github.com/Varun-SV/Cascade-AI/blob/main/src/config/schema.ts).
