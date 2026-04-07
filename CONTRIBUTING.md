# Contributing to Cascade AI

Thank you for your interest in contributing! This guide covers the development workflow, architecture conventions, and quality expectations.

---

## Prerequisites

| Tool | Required Version |
|------|-----------------|
| Node.js | ≥ 20.x |
| npm | ≥ 10.x |

---

## Setup

```bash
git clone https://github.com/Varun-SV/Cascade-AI.git
cd Cascade-AI
npm install          # Install root (CLI) dependencies
cd web && npm install # Install dashboard dependencies
cd ..
```

---

## Project Structure

```
cascade-ai/
├── src/
│   ├── core/
│   │   ├── tiers/           # T1 Administrator, T2 Manager, T3 Worker
│   │   ├── permissions/     # Hierarchical permission escalator
│   │   ├── router/          # Multi-provider LLM router
│   │   └── cascade.ts       # Main orchestrator entry point
│   ├── tools/               # Tool implementations + registry
│   ├── memory/              # SQLite memory store (sessions, audit, nodes)
│   ├── audit/               # Structured audit logger
│   ├── config/              # Zod schema + validator
│   ├── utils/               # retry.ts and other shared utilities
│   └── types.ts             # All shared TypeScript types
│
├── web/                     # Vite + React dashboard
│   └── src/
│       ├── components/
│       │   ├── auth/        # LoginView
│       │   ├── layout/      # NavRail, TopBar
│       │   └── dashboard/   # AgentGraph, InspectorPanel, EscalationCard, LogViewer, SessionList
│       ├── store/           # Redux Toolkit slices
│       └── hooks/           # useWebSocket, etc.
│
├── vitest.config.ts         # Test config (80% coverage thresholds)
└── package.json
```

---

## Development Commands

```bash
# Run the CLI in development mode
npm run dev

# Build the CLI
npm run build

# Run all unit tests
npm test

# Run tests with coverage report
npm run test:coverage

# Build the web dashboard
cd web && npm run build

# Start the dashboard in dev mode (hot reload)
cd web && npm run dev
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CASCADE_CONFIG` | Path to config.yaml (default: `~/.cascade/config.yaml`) |
| `CASCADE_DB` | Path to SQLite database file |
| `CASCADE_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` (default: `info`) |
| `CASCADE_WORKSPACE` | Override workspace root path |

To use a provider, configure it in `~/.cascade/config.yaml`:
```yaml
providers:
  - type: anthropic
    apiKey: sk-ant-...
    model: claude-sonnet-4-5
```

---

## Architecture Notes

### Permission Escalation (Item 8)
When a T3 Worker needs to execute a tool requiring approval, the request travels:
```
T3 → PermissionEscalator → T2 (LLM eval) → T1 (LLM eval) → User (EscalationCard)
```
- Safe/read-only tools (file_read, git_status, etc.) are auto-approved by rules — no LLM call.
- Dangerous tools use a max-10-token LLM inference at each tier.
- Session-wide approval caching: keyed by `${t2Id}:${toolName}`.

### Adding a New Tool
1. Create `src/tools/my-tool.ts` extending `BaseTool`.
2. Implement `getDefinition()`, `execute()`, and optionally `isDangerous()`.
3. Register in `src/tools/registry.ts` → `registerDefaults()`.
4. Add tool name to `DEFAULT_APPROVAL_REQUIRED` in `src/constants.ts` if approval is needed.

### Adding a Plugin
Use the `ToolPlugin` interface to bundle multiple tools:
```typescript
import type { ToolPlugin } from '../src/tools/registry.js';

const plugin: ToolPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  tools: [new MyTool()],
};
registry.registerPlugin(plugin);
```

---

## Testing Guidelines

- **Coverage target**: 80% lines, 75% functions, 70% branches.
- **Test files**: `*.test.ts` co-located with the source file they test.
- **Mocking**: Use `vi.mock()` for external I/O (fs, network). Don't mock internal logic.
- **Integration tests**: Place in `src/__tests__/` with descriptive names.

```bash
# Run a specific test file
npx vitest run src/core/permissions/escalator.test.ts

# Watch mode
npx vitest src/core/permissions/
```

---

## Code Style

- **TypeScript strict mode** is enforced.
- Use `async/await`, not `.then()` chains.
- Prefer explicit return types on public methods.
- Use `CascadeToolError` (from `src/utils/retry.ts`) for tool failures — it carries a `.userMessage`.
- Wrap external calls (shell, git, GitHub API) with `withRetry()`.
- Audit significant events with `this.audit?.info(tierId, action, details)`.

---

## Pull Request Checklist

- [ ] Tests added / updated for changed code
- [ ] `npm test` passes with no failures
- [ ] `cd web && npm run build` succeeds
- [ ] New public APIs have JSDoc comments
- [ ] No hardcoded API keys or secrets
- [ ] `.cascadeignore` patterns respected for file tools
