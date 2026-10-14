# Development and Contributing

## Local checkout

```bash
git clone https://github.com/Varun-SV/Cascade-AI.git
cd Cascade-AI
npm install
npm run build
npm test
npm run lint
```

Required Node engine: `>=22.22.2`. Builds and tests use TypeScript, Vite, tsup and Vitest. Root npm workspaces include `web`, `app`, `cloud/server` and `cloud/web`.

## Useful commands

| Command | Scope |
| --- | --- |
| `npm run build` | Local dashboard web and core SDK/CLI |
| `npm run build:app` | Desktop renderer and Electron |
| `npm run dev:app` | Desktop development |
| `npm run dev:cloud` | Cloud server development |
| `npm run dev:cloud-web` | Cloud web frontend development |
| `npm test` | Root Vitest |
| `npm run lint` | TypeScript type checking |
| `npm run build -w cascade-cloud-server` | Cloud backend workspace build |

For cloud UI e2e tests, see `cloud/web/e2e/` and `cloud/web/playwright.config.ts`.

## Change discipline

1. Branch from `main` and keep changes scoped.
2. Add a regression test that fails before the bug fix and passes afterward.
3. Run relevant tests, lint and builds for affected packages.
4. Update `CHANGELOG.md` appropriately; when SDK/CLI/desktop behavior changes, coordinate version bumps in root and desktop packages.
5. Update wiki source pages in `docs/wiki/` alongside changed behavior. Merging documentation edits triggers the wiki publisher.
6. Do not present unfinished source stubs or planned roadmap work as shipped.

## Wiki publishing

The GitHub Wiki is a separate Git repository. The source-of-truth Markdown is in `docs/wiki/` on `main`. The [[Documentation-Maintenance]] page explains scheduled syncing and manual setup.

Sources: [CONTRIBUTING.md](https://github.com/Varun-SV/Cascade-AI/blob/main/CONTRIBUTING.md), [CI workflow](https://github.com/Varun-SV/Cascade-AI/blob/main/.github/workflows/ci.yml).
