#!/usr/bin/env bash
# ─────────────────────────────────────────────
#  Cascade AI — Release Helper
#  Run this from the project root on your local machine to:
#  1. Push the feature branch to GitHub
#  2. Create a Pull Request
#  3. (After merge) Tag v0.1.1 and publish to npm
# ─────────────────────────────────────────────

set -euo pipefail

BRANCH="feature/resilience-and-dx-improvements"
VERSION="0.1.1"

echo "=== Step 1: Push feature branch to GitHub ==="
git push origin "$BRANCH"
echo ""

echo "=== Step 2: Create Pull Request (requires gh CLI) ==="
gh pr create \
  --title "feat: improve resilience, DX, and test coverage (v${VERSION})" \
  --body "$(cat <<'PREOF'
## Summary

- **fix(failover):** Backoff now properly escalates 30s→60s→120s→300s across consecutive failures. Previously `recordFailure` capped the step at 1 regardless of how many times a provider had failed.
- **feat(retry):** Added ±25% jitter, `maxDelayMs` cap, and optional `onRetry` callback to `withRetry`. Fixed `withTimeout` to use typed `ReturnType<typeof setTimeout>` and always clear the timer.
- **feat(context):** Improved token estimation in `ContextManager` — handles image blocks (~85 token flat estimate), `tool_result` blocks, and per-message structural overhead. Added `getContextSummary()` for status-bar / debug use.
- **chore:** Added `.gitattributes` enforcing LF line endings for all text/source files to eliminate false diffs on Windows checkouts.
- **test:** Added 27 new tests across `retry.test.ts`, `failover.test.ts`, and `manager.test.ts` (all passing).

## Test plan

- [x] `vitest run src/utils/retry.test.ts` — 12 tests pass
- [x] `vitest run src/core/router/failover.test.ts` — 9 tests pass
- [x] `vitest run src/core/context/manager.test.ts` — 6 tests pass
- [x] Full test suite run (except `store.test.ts` which requires native `better-sqlite3` build)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PREOF
)" \
  --base main \
  --head "$BRANCH"
echo ""

echo "=== After the PR is merged, run the following to tag and publish ==="
cat <<'POSTMERGE'

  # Pull latest main
  git checkout main && git pull origin main

  # Tag the release
  git tag -a "v0.1.1" -m "Release v0.1.1 — resilience, DX, and test coverage improvements"
  git push origin "v0.1.1"

  # Build and publish to npm
  npm run build
  npm publish --access public

POSTMERGE
