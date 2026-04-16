# ─────────────────────────────────────────────
#  Cascade AI — Release Helper (Windows PowerShell)
#  Run from the project root:  .\scripts\publish-release.ps1
#
#  Steps:
#  1. Push the feature branch to GitHub
#  2. Create a Pull Request (requires GitHub CLI — https://cli.github.com)
#  3. After the PR is merged: tag v0.1.1 and publish to npm
# ─────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$BRANCH  = "feature/resilience-and-dx-improvements"
$VERSION = "0.1.1"

Write-Host ""
Write-Host "=== Step 1: Push feature branch to GitHub ===" -ForegroundColor Cyan
git push origin $BRANCH
Write-Host "Branch pushed." -ForegroundColor Green

Write-Host ""
Write-Host "=== Step 2: Create Pull Request (requires gh CLI) ===" -ForegroundColor Cyan

$prBody = @"
## Summary

- **fix(failover):** Backoff now properly escalates 30s -> 60s -> 120s -> 300s across consecutive failures. Previously ``recordFailure`` capped the step at 1 regardless of how many times a provider had failed.
- **feat(retry):** Added +-25% jitter, ``maxDelayMs`` cap, and optional ``onRetry`` callback to ``withRetry``. Fixed ``withTimeout`` to always clear its timer.
- **feat(context):** Improved token estimation in ``ContextManager`` — handles image blocks, ``tool_result`` blocks, and per-message overhead. Added ``getContextSummary()`` for status-bar / debug use.
- **chore:** Added ``.gitattributes`` enforcing LF line endings to eliminate false diffs on Windows.
- **test:** Added 27 new tests across ``retry.test.ts``, ``failover.test.ts``, and ``manager.test.ts`` (all passing).

## Test plan

- [x] ``vitest run src/utils/retry.test.ts`` — 12 tests pass
- [x] ``vitest run src/core/router/failover.test.ts`` — 9 tests pass
- [x] ``vitest run src/core/context/manager.test.ts`` — 6 tests pass

Generated with Claude Code
"@

gh pr create `
  --title "feat: improve resilience, DX, and test coverage (v$VERSION)" `
  --body $prBody `
  --base main `
  --head $BRANCH

Write-Host "Pull Request created." -ForegroundColor Green

Write-Host ""
Write-Host "=== After the PR is merged, run the block below to tag and publish ===" -ForegroundColor Yellow
Write-Host @"

  # Switch to main and pull latest
  git checkout main
  git pull origin main

  # Create and push the release tag
  git tag -a "v$VERSION" -m "Release v$VERSION — resilience, DX, and test coverage improvements"
  git push origin "v$VERSION"

  # Build and publish to npm
  npm run build
  npm publish --access public

"@
