# Contributing to Cascade

Thanks for being here. Bug reports, docs fixes and features are all welcome.

## Before you start

- **Node.js ≥ 22** (matches `engines` in `package.json`).
- Found a **security** issue? Don't open a public issue — see [SECURITY.md](SECURITY.md).
- Planning something big? Open an issue first so we can agree on the shape
  before you spend real time on it.

## Getting set up

```bash
git clone https://github.com/Varun-SV/Cascade-AI.git
cd Cascade-AI
npm install          # installs the workspaces too (app, cloud/server, cloud/web)
npm run build        # build the SDK/CLI
npm test             # run the test suite
```

Run the CLI from your checkout:

```bash
node dist/cli.js "your prompt"
```

The repo is a small monorepo:

| Path | What it is |
| --- | --- |
| `src/` | the core SDK + CLI (the published `cascade-ai` package) |
| `app/` | the Electron desktop app |
| `cloud/server` | the hosted API (Express + SQLite) |
| `cloud/web` | the hosted web app (React + Vite) |
| `docs/` | internal design specs |

Each workspace has its own `npm test` / `npx tsc --noEmit`.

## Making a change

1. **Branch** off `main`.
2. **Write the change and a test.** Every bug fix should come with a test that
   fails before it and passes after.
3. **Match the surrounding code.** Same naming, same comment density, same
   idioms as the file you're editing — no sweeping reformatting in a fix PR.
4. **Verify before you push:**
   ```bash
   npm test && npm run lint && npm run build
   ```
   Touching a workspace? Run its checks too (e.g. `cd cloud/server && npx vitest run && npx tsc --noEmit`).
5. **Update `CHANGELOG.md`** under a new version heading, written for users —
   what changed and why it matters, not the diff.

### Version bumps

Bump `version` in **both** the root `package.json` **and** `app/package.json`
when your change touches the **SDK, CLI, or desktop app** — merging that to
`main` triggers the release workflow, which publishes to npm and builds the
desktop installers. **Cloud-only changes** (`cloud/**`) don't need a bump.

## Pull requests

- One logical change per PR; keep the diff reviewable.
- Explain **why**, not just what. Note anything you deliberately left out.
- Say how you verified it (tests, builds, manual run).
- CI must be green.

## Reporting bugs

Use the issue templates. The details that actually speed up a fix: your Cascade
version, OS, which surface (CLI / desktop / web), the provider and tier setup,
and the exact steps. **Redact your API keys** from any logs you paste.

## Code of conduct

Be decent to each other. Assume good faith, keep criticism about the code, and
remember that the person on the other end is doing this in their spare time.
