# Cascade AI — Code Review & Security Audit

_Full deep-dive review of the v0.5.6 codebase covering security vulnerabilities,
correctness bugs, missing areas, and product differentiation. Findings marked
**[fixed]** were addressed in this branch; the rest are recommendations._

---

## 1. Security findings

### 1.1 Dashboard bound to all network interfaces — **[fixed]** · High
`DashboardServer.start()` called `httpServer.listen(this.port)` with no host,
so the server bound to `0.0.0.0` (every interface). The dashboard exposes
`POST /api/run` (runs an arbitrary prompt through the full tier system — i.e.
shell, file, and code-interpreter tools), plus config-mutation and
session-deletion endpoints. Anyone on the same network/LAN could reach it; if an
operator ever set `dashboard.auth: false`, that becomes **unauthenticated remote
code execution**.

**Fix:** added a `dashboard.host` config option defaulting to `127.0.0.1`
(loopback). The server now binds to it, and logs a loud warning when bound to a
non-loopback interface — louder still if auth is disabled at the same time.
Operators who want team access must opt in explicitly (`"host": "0.0.0.0"`).

### 1.2 SSRF in `web_fetch` (and runtime-generated tools) — **[fixed]** · High
`WebFetchTool` fetched any agent-supplied URL with `redirect: 'follow'` and no
host validation. A prompt-injected web page could instruct the agent to fetch
`http://169.254.169.254/latest/meta-data/` (cloud credential theft) or pivot to
internal services. The same ungated `globalThis.fetch` was exposed inside the
`ToolCreator` sandbox.

**Fix:** added `src/tools/utils/safe-fetch.ts` — validates the scheme
(http/https only), resolves the hostname and rejects loopback / link-local
(metadata) / RFC-1918 / CGNAT / IPv4-mapped-IPv6 ranges, and follows redirects
**manually**, re-validating every hop. `web_fetch` and the generated-tool
sandbox now route through it. Local fetches can be re-enabled with
`CASCADE_ALLOW_LOCAL_FETCH=1`. Covered by `safe-fetch.test.ts`.
Note: `web_search` was deliberately left alone — its SearXNG backend is meant to
point at a self-hosted localhost instance.

### 1.3 `file_edit` and `git` ran with no approval prompt — **[fixed]** · High
Approval is gated **solely** by `DEFAULT_APPROVAL_REQUIRED` (+ user config), not
by `isDangerous()`. `file_write` and `file_delete` were on the list but
`file_edit` was not — so the agent could rewrite any in-workspace file silently.
`git` (which can `commit`, `checkout`, `push`) was also absent.

**Fix:** added `file_edit` and `git` to `DEFAULT_APPROVAL_REQUIRED`.

### 1.4 Code-interpreter argument injection — **[fixed]** · Medium
`run_code` built a shell command string and interpolated `args` with naive
double-quoting (`"${a}"`), so an argument containing `"`, `` ` ``, `$( )`, or
`;` broke out into a second shell command. It also wrote temp scripts to
`process.cwd()` instead of the workspace root.

**Fix:** switched from `exec(string)` to `execFile(interpreter, [file, ...args])`
— arguments are passed as an argv array directly to the OS, never through a
shell — and writes temp scripts under `workspaceRoot`.

### 1.5 JWT algorithm not pinned — **[fixed]** · Medium
`jwt.sign`/`jwt.verify` did not specify an algorithm. jsonwebtoken@9 mitigates
the classic `alg:none` downgrade, but pinning is defense-in-depth and prevents
key-confusion if the secret handling ever changes.

**Fix:** pinned `HS256` on both sign and verify.

### 1.6 Shell built-in blocklist trivially bypassable — **[partially fixed]** · Low
The catastrophic-command regexes only matched exact forms (`rm -rf /` but not
`rm -fr /` or `rm  -rf  /`), and the shell-metacharacter block only applies when
an allowlist is configured.

**Fix:** broadened the patterns to tolerate flag reordering / whitespace and
added a fork-bomb pattern. This remains **defense-in-depth only** — a blocklist
can never be exhaustive; the approval prompt is the real gate. A future
hardening would be to run shell commands through an explicit `["/bin/sh","-c"]`
argv (already the case) inside an OS sandbox / container.

### 1.7 `node:vm` is not a security boundary — **[documented]** · Medium (residual)
`ToolCreator` runs LLM-generated code in `node:vm` with `Object`, `Array`,
`Function`-reachable globals. `node:vm` does **not** contain deliberately hostile
code (`({}).constructor.constructor('return process')()` escapes it). The
generated code is produced by a model that may ingest prompt-injected content,
so this is a real residual risk. The SSRF fix (1.2) removes the network-exfil
path; the remaining control is that dangerous *registered* tools still require
escalation. **Recommendation:** for untrusted environments, run generated tools
in a real isolate (separate process with `--disallow-code-generation-from-strings`,
`isolated-vm`, or a WASM/container sandbox), or disable `enableToolCreation`.

### 1.8 Other observations (not changed)
- **CORS `*` when auth disabled** (`server.ts`) — acceptable now that the server
  defaults to loopback, but worth tightening if team mode is used.
- **Keystore PBKDF2 = 100k/SHA-256** — fine but below current OWASP guidance
  (600k for PBKDF2-SHA256). Consider bumping, or moving to scrypt/argon2.
- **`git`/`shell` `cwd` parameter is unrestricted** — both accept an arbitrary
  working directory outside the workspace. They already require approval; a
  stricter build could constrain `cwd` to the workspace.
- **GitHub tool accepts a `token` in tool input** — fine, but tokens passed this
  way may be echoed into model context/logs; prefer the env-var path.

---

## 2. Correctness / code-quality findings

- **`DashboardServer` opens a fresh `MemoryStore` (better-sqlite3) per request**
  in `DELETE /api/sessions/:id`, `DELETE /api/sessions`, `DELETE /api/runtime`,
  and `GET /api/runtime?scope=global`, despite a cached `getGlobalStore()`
  existing. Under load this churns DB handles. Recommend reusing the cached
  handle.
- **`PermissionEscalator.resolveUserDecision`** has a dead `if (always) { … }`
  block (lines 135–139) that only contains comments — the caching it describes
  happens in `waitForUserDecision`'s wrapped resolver. Remove the dead block.
- **`CascadeIgnore.getPatterns()`** reaches into the `ignore` library's private
  `_rules` field, which is brittle across library versions.
- **`web_fetch` / `web_search` are not marked `isDangerous()`** and are not in
  the approval list. Reasonable for read tools, but note they can still be used
  for data exfiltration via crafted URLs (now SSRF-limited).

---

## 3. Missing areas / gaps

- **Keystore has no CLI.** The README shows `cascade keys set …` as "Coming",
  and `unlock()` is never wired to an interactive password prompt in the CLI
  commands — so the encrypted-file backend is effectively unreachable for most
  users, who fall back to plaintext keys in `config.json` or env vars. This is
  the single biggest gap between the documented security story and reality.
- **No automated security tests for the dashboard** (auth bypass, rate-limit,
  CORS). Only unit-level coverage exists.
- **No SAST / `npm audit` gate in CI.** `npm install` currently reports 11
  advisories (1 critical). A `.github/workflows` audit step would catch these.
- **`.cascadeignore` enforcement is path-only.** It's enforced in
  `ToolRegistry.execute` for the four file tools by `input.path`, but `shell`,
  `run_code`, and `git` can read protected files (e.g. `cat .env`) with no
  ignore check. Worth documenting that the ignore list protects *file tools*,
  not arbitrary shell.
- **No content-length cap before reading `web_fetch` bodies** — `resp.text()`
  buffers the whole response before the 50k truncation; a huge response can spike
  memory. Stream-and-cap would be safer.
- **Tests don't cover headless auto-approval**, which silently grants every
  dangerous tool — a behavior worth a guard rail (e.g. still honor the
  blocklist) and an explicit test.

---

## 4. Differentiation — what could make Cascade "one of its kind"

The T1→T2→T3 orchestration is the genuinely novel core. To lean into it rather
than competing feature-for-feature with single-agent CLIs:

1. **Make the hierarchy observable and replayable.** The dashboard already
   streams tier status — turn that into a first-class *execution graph* with
   per-node cost, tokens, tool calls, and a "replay this run" button. No other
   coding CLI shows a live multi-agent DAG. This is the marquee differentiator.
2. **Cost-aware model routing as a headline feature.** `model-performance-tracker`
   + `cascadeAuto` already pick models per tier. Surface a "this run cost $0.03;
   the all-Opus equivalent would have cost $0.71" comparison. Budget-bounded
   autonomy ("finish under $0.50") is a strong, unique selling point.
3. **Local-first privacy tier.** T3 workers can run on Ollama. A "no data leaves
   this machine" mode (all tiers local) is differentiating for regulated/
   enterprise users — pair it with the keystore story once the CLI exists.
4. **Deterministic, auditable agent runs.** The audit log + permission escalator
   are a foundation for a compliance story ("every file change and tool call,
   who approved it, what it cost"). Export runs as signed PDFs (pdfkit is already
   a dep). Few agent tools offer an audit trail.
5. **Peer communication between workers** (`core/peer/bus.ts`) is unusual —
   workers sharing partial results mid-task. Lean into "agents that collaborate,
   not just fan out" with visible cross-talk in the graph.

The fastest path to "one of a kind": ship the **live multi-agent execution graph
+ real-time cost ledger** in the dashboard, and finish the **keystore CLI** so
the security posture matches the marketing.

---

## Files changed in this branch
- `src/tools/utils/safe-fetch.ts` (new) — SSRF-safe fetch helper + tests
- `src/tools/web-fetch.ts` — route through `safeFetch`
- `src/tools/tool-creator.ts` — sandbox `fetch` → `safeFetch`
- `src/tools/interpreter.ts` — `execFile` argv (no shell injection), workspace temp dir
- `src/tools/shell.ts` — broadened dangerous-pattern matching
- `src/dashboard/auth.ts` — pin JWT to HS256
- `src/dashboard/server.ts` — bind to `dashboard.host` (loopback default) + warnings
- `src/config/schema.ts`, `src/types.ts` — add `dashboard.host`
- `src/constants.ts` — add `file_edit` and `git` to default approvals
- Tests: `safe-fetch.test.ts` (new), `shell.test.ts` (added cases)
