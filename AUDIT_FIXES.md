# Codebase Audit & Bug Fixes — `fix/cli-input-and-audit`

A full-pass audit of the Cascade-AI codebase, fixing the reported CLI issues plus
several production-risk bugs discovered along the way.

## Reported issues (fixed)

### 1. Delete key moved cursor back but deleted nothing (chat area)
- **Root cause:** Ink surfaces both `\x7F` (backspace) and `\x1b[3~` (forward-delete)
  as `key.delete = true`, and the parent REPL's raw-stdin listener also ran
  `prev.slice(0, -1)` — producing a double-action: Ink moved the cursor left,
  the REPL trimmed the tail, but no forward-delete occurred.
- **Fix:** `src/cli/components/SafeTextInput.tsx` now intercepts `\x1b[3~` in its
  raw-stdin listener, performs a true forward-delete at the cursor position,
  and sets a 50 ms timestamp guard that short-circuits Ink's redundant backspace
  handler. Obsolete forward-delete handling removed from `src/cli/repl/index.tsx`.

### 2. CLI paste and mouse-escape noise during `cascade init`
- **Fix (earlier pass):** Bracketed-paste markers and SGR/X10 mouse reports are
  now consumed and dropped by the setup flow's raw-stdin listener instead of
  being typed into inputs.

## Additional bugs found during audit

### 3. `Cascade.init()` race condition
- **File:** `src/core/cascade.ts`
- Concurrent `init()` calls could double-register budget listeners and
  double-connect MCP servers. Memoised with a single `initPromise`, cleared on
  error so retries still work.

### 4. `Cascade.run()` leaked work on error paths
- `escalator.cancelAllPending()` and telemetry capture were skipped whenever the
  run threw. Wrapped in `try/finally` so pending permission requests are always
  rejected and telemetry always fires (with `errored: true` + error message).

### 5. MCP child processes leaked on REPL exit / one-shot SDK run
- Added `Cascade.close()` which disconnects all MCP servers and flushes
  telemetry. Wired into the REPL cleanup path and into a `try/finally` around
  `runCascade()` in `src/sdk/index.ts`.

### 6. REPL UI hung when `cascade` was null
- `src/cli/repl/index.tsx`: when init failed, a user message silently returned
  with `isExecuting: true`, freezing the UI. Now dispatches reset + an error
  message.

### 7. OpenAI provider crashed on truncated tool-call JSON
- `src/providers/openai.ts`: streaming truncation could yield malformed JSON in
  `tool_calls.function.arguments`. Replaced the bare `JSON.parse` with a
  try/catch that degrades to `{ __rawArguments, __parseError: true }`.

### 8. Anthropic/Gemini `listModels()` crashed on HTTP errors
- `src/providers/anthropic.ts`, `src/providers/gemini.ts`: a non-200 response or
  unexpected shape blew up with a shape-mismatch error. Now both check
  `resp.ok` + `Array.isArray(data.data)` and fall back to the hard-coded
  `MODELS` list.

### 9. Ollama provider dropped the last streamed chunk
- `src/providers/ollama.ts`: NDJSON lines are newline-terminated — but on
  disconnect the final `{"done": true, ...}` line sometimes arrives without a
  trailing newline. Added a tail-flush on `end` so the final content and usage
  tokens are not lost.

### 10. Scheduler raised UnhandledPromiseRejection on task failure
- `src/scheduler/index.ts`: runner errors bubbled out of `node-cron`'s async
  wrapper into Node's `unhandledRejection`, which would crash any long-running
  daemon. Wrapped the runner in `try/catch` with structured `console.error`.

### 11. Scheduler leaked cron jobs on reschedule
- Same file: rescheduling a task with the same `id` overwrote the map entry
  without calling `.stop()` on the previous cron job, leaving a live timer.
  Now explicitly stops the existing job before replacing.

### 12. Dashboard `stop()` leaked broadcast timer + global store
- `src/dashboard/server.ts`: `broadcastTimer` was never cleared and
  `globalStore` (a SQLite handle) was never closed on shutdown. Both now
  released in `stop()`.

### 13. MCP tools never registered — off-by-one in destructuring
- `src/tools/registry.ts`: `def.name` is `mcp::<server>::<tool>` (3 parts
  after split on `::`), but the code did
  `const [,, serverName, toolName] = def.name.split('::')` which skipped two
  segments and assigned `serverName=<tool>`, `toolName=undefined`. The next
  line's guard `if (!toolName) continue` then filtered every MCP tool out
  silently. Corrected to `[, serverName, toolName]`.

### 14. Keystore corrupted itself on first unlock
- `src/config/keystore.ts`: initial unlock derived `masterKey` from one random
  salt, then `save()` generated a **second** random salt and wrote it to disk.
  On the next session, unlock would derive a different key from the on-disk
  salt and fail to decrypt. Fixed by deriving once with a known salt and
  persisting that same salt via a new `writeWithSalt()` helper; the now-unused
  overloaded `save()` was removed.

### 15. `getLatestFileSnapshots` relied on undefined SQLite behaviour
- `src/memory/store.ts`: `GROUP BY file_path HAVING timestamp = MIN(timestamp)`
  with a bare `content` column is only safe when `MIN()` is in SELECT
  (bare-columns rule). Rewrote as a correlated subquery so the `content`
  returned is guaranteed to come from the earliest row per file.

## Verification

- `npx tsc --noEmit` — clean
- `npx vitest run` — 77 passed, 2 skipped (no regressions)

## Suggested commit / PR commands (run locally)

```bash
cd "F:\Softwares\Github Softwares\Cascade-AI"
git checkout -b fix/cli-input-and-audit

# Stage the fixed files explicitly (avoid catching anything unintended)
git add \
  src/cli/components/SafeTextInput.tsx \
  src/cli/repl/index.tsx \
  src/core/cascade.ts \
  src/providers/openai.ts \
  src/providers/anthropic.ts \
  src/providers/gemini.ts \
  src/providers/ollama.ts \
  src/scheduler/index.ts \
  src/dashboard/server.ts \
  src/sdk/index.ts \
  src/tools/registry.ts \
  src/config/keystore.ts \
  src/memory/store.ts \
  AUDIT_FIXES.md

git commit -m "fix: CLI input issues + audit-driven production bug fixes"

git push -u origin fix/cli-input-and-audit

gh pr create --title "fix: CLI input issues + audit-driven production bug fixes" \
  --body-file AUDIT_FIXES.md
```
