# Changelog

All notable changes to Cascade AI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.22] - 2026-07-01

### Fixed
- **Chat responses through a local (OpenAI-compatible) endpoint showed every word doubled.** `src/dashboard/server.ts` delivered `stream:token`/`tier:status` to the requesting client through two overlapping paths at once — `emitToSocket(socketId, ...)` *and* `broadcast(...)` (which is `io.emit(...)`, already reaching every connected socket including that one) in the chat-UI path, and `broadcast(...)` *and* `broadcastToRoom(...)` in the REST `/api/run` path. The single client-side listener appended both deliveries, so every streamed token — and therefore every word, and a model's `<think>` tags — appeared twice. Each event is now delivered exactly once, matching the sibling handlers (`session:complete`, `session:error`, `permission:user-required`) that were already correct.
- **Chat/Code responses were never rendered as markdown.** `ChatView`'s message bubble printed `message.content` as plain text; `react-markdown` and `react-syntax-highlighter` were already installed and used in the docs viewer but never wired into chat. Assistant messages now render through `ReactMarkdown` (bold, lists, tables, syntax-highlighted code fences).
- **A model's `<think>...</think>` reasoning was shown raw and inline with the answer.** Reasoning-tuned local models (and the synthetic `<think>` wrapping already used for Anthropic/OpenAI thinking deltas) had no frontend handling at all. It's now parsed out of the message and shown in a collapsed "Thinking" toggle, separate from the answer, with a live indicator while still streaming.

### Added
- **A chat panel in the Code view.** The Code tab had no way to chat at all. A resizable panel (drag its left edge) can now be toggled from the Code view's header, showing the same conversation/session as the Chat tab — reusing a new shared `ChatPanel` component instead of a second, divergent chat implementation.

## [0.12.21] - 2026-07-01

### Fixed
- **OpenAI-compatible endpoints with no API key configured were never discovered, no matter the base URL.** Local servers (llama.cpp / LM Studio / vLLM run without `--api-key`) need no key, so the OpenAI-Compatible provider's `apiKey` is legitimately left unset — but `OpenAICompatibleProvider`'s constructor called `super(config, model)` before applying its "not-required" fallback, and the underlying `openai` SDK throws in its own constructor whenever `apiKey` is undefined and `OPENAI_API_KEY` isn't set in the environment (which it never is on a desktop install). That exception was silently swallowed everywhere the provider gets constructed — the availability check and the real model discovery — so the Models tab showed the bare "endpoint unreachable?" placeholder with no further detail, even while a direct diagnostic probe (and `curl`/a browser) reached the very same endpoint successfully. This reproduced identically for `localhost`, a LAN IP, or a hostname, since the failure had nothing to do with the network target. The constructor now passes the same fallback key into `super()` so construction never throws. Model discovery for a configured OpenAI-compatible endpoint no longer depends on a separate, redundant reachability probe succeeding first, and the Models tab now surfaces a concrete reachable-but-not-yet-listed message instead of staying silent when a probe succeeds but no models were discovered.

## [0.12.19] - 2026-06-30

### Fixed
- **OpenAI-compatible endpoints no longer read as “unreachable” when they redirect or compress `/v1/models`.** Discovery reaches local endpoints through a Node `http`/`https` fetch shim that issued a single raw request — it did not follow redirects or decompress responses. So a healthy endpoint (e.g. `http://localhost:8900/v1`) whose `/v1/models` answered with a `307`/`308` redirect (trailing-slash canonicalisation, reverse proxy, http→https) made the availability check see a non-2xx status and skip discovery entirely, and a gzip/deflate/br response body made the JSON parse throw — either way the model dropdown stayed empty and showed “endpoint unreachable?”, even though a browser/curl reached the same URL fine. The fetch shim now follows redirects (IPv4-preferring, method/body preserved for 307/308) and transparently decompresses gzip/deflate/br (SSE chat completions still stream). The Settings → Models picker now surfaces the concrete probe reason (HTTP status / 0 models / error) instead of a generic “unreachable?” when discovery comes up empty.

## [0.12.18] - 2026-06-30

### Fixed
- **OpenAI-compatible endpoints now reached via Node'''s http stack.** Live debugging showed the endpoint returns 200 to the renderer and to a child Node process (no proxy set), yet the Electron main process could not discover it through global fetch (undici) or Chromium'''s net.fetch. The OpenAI-compatible provider now performs discovery and generation over Node'''s lower-level http/https modules (a streaming-capable fetch shim), which reaches loopback servers reliably from the main process. Reverted the earlier net.fetch routing. `listModels` also returns a direct endpoint probe (status + model count) so any remaining failure is concrete.

## [0.12.17] - 2026-06-30

### Fixed
- **Local model endpoints unreachable from the app despite working in a browser.** With a system proxy or VPN present, Chromium auto-bypasses `localhost`/`127.0.0.1` but the Electron backend'''s Node `fetch` does not — so llama.cpp / Ollama / vLLM / LM Studio endpoints read as “unreachable” (empty model dropdown) even though the same URL returns 200 in a browser. The backend now routes plain-HTTP (loopback / LAN) requests through Chromium'''s network stack (`net.fetch`) — the same path the renderer uses; HTTPS cloud APIs are unchanged. (Confirmed live: `listModels` returned cloud models but no OpenAI-compatible ones, while a renderer fetch to `/v1/models` returned 200.)

## [0.12.16] - 2026-06-30

### Fixed
- **OpenAI-Compatible endpoints a browser could reach but the app couldn'''t.** Discovery now probes `/v1/models` with a tolerant direct fetch instead of the OpenAI SDK'''s typed `models.list()`, which threw on non-standard local-server payloads (llama.cpp / LM Studio return an extra `models` array and filesystem-path model ids) and surfaced as a misleading “endpoint unreachable.” The model dropdown now populates from these servers.
- **Models dropdown could never fill when a tier was pinned to a not-yet-discovered model.** `listModels` no longer aborts when a pinned tier override can'''t resolve — it returns the discovered models anyway. The real discovery error is now logged instead of swallowed.

## [0.12.15] - 2026-06-27

### Fixed
- **Local endpoints over `localhost` no longer read as “unreachable.”** Node prefers IPv6 (`::1`) for `localhost`, but local model servers (llama.cpp / Ollama / vLLM / LM Studio) bind IPv4 (`127.0.0.1`) by default — so an endpoint your browser and curl reach appeared offline from the app (empty model dropdown, “endpoint unreachable”). Cascade now forces IPv4 resolution process-wide and rewrites a literal `localhost` host to `127.0.0.1` for the OpenAI-Compatible and Ollama providers.

### Changed
- **Richer Code empty state.** With no folder open, the Code tab shows an illustrated prompt with a prominent **Open Folder** button and a **Recent folders** list instead of a single line of text.

## [0.12.14] - 2026-06-27

### Fixed
- **OpenAI-Compatible / Ollama model picker now lists the endpoint’s real models.** In Settings → Models, choosing an OpenAI-Compatible (vLLM / llama.cpp / LM Studio) or Ollama tier auto-fetches the endpoint’s `/v1/models` and offers them as a dropdown instead of requiring a hand-typed id. Picking the exact id the server reports fixes the “could not connect” caused by a typed id (e.g. a `.gguf` filename) not matching what the endpoint serves. A refresh button re-discovers on demand, a “Custom…” option keeps manual entry, and the list refreshes after Save — no backend restart needed (discovery already runs per run).

## [0.12.13] - 2026-06-27

### Added
- **Usable code editor.** The Code tab is now a working editor: **Open Folder** (browse any folder, not only a Cascade run), **Save** with `Ctrl`/`Cmd`+`S` (writes to disk, with a dirty-dot indicator), **tabs** for multiple open files, a right-click **context menu** in the file tree (new file, new folder, rename, delete-to-trash), and **search across files** (a workspace-wide text search whose results jump to the matching line). Backed by an expanded file bridge (`writeFile`, `mkdir`, `createFile`, `rename`, `delete` via OS trash, `search`).

## [0.12.12] - 2026-06-27

### Added
- **Midnight theme.** A new selectable appearance preference (Settings → Appearance) applying the deep-navy + violet "Cascade design" palette. System / Light / Dark are unchanged; Midnight is a renderer-only palette (native window chrome follows Dark) and persists across launches like the other preferences.

## [0.12.11] - 2026-06-26

### Added
- **Providers settings tab with editable endpoints.** The Settings → Providers tab now exposes an **OpenAI-Compatible** entry (API key + **Base URL**, e.g. `http://localhost:8000/v1`) so you can point Cascade at vLLM / llama.cpp / LM Studio / any OpenAI-compatible server, and an editable **Ollama endpoint** (default `http://localhost:11434`). Endpoints persist to the provider config via the `getSettings`/`updateSettings` IPC and are picked up live by the backend.

## [0.12.10] - 2026-06-26

### Fixed
- **Terminal crashed the view with "process is not defined."** `TerminalPanel` called `process.cwd()` in the renderer, where `process` doesn't exist. It now passes a safe default cwd to the PTY.
- **Chat responses showed only the latest word.** Streamed tokens are deltas, but the store *replaced* the message on each token (and both App and Chat listened, which would double an append). The store now appends, and only the global handler streams — so replies accumulate correctly.

### Changed
- **Chat model is decoupled from the tiers.** The Chat model picker now uses its own selection (`activeModel.chat`) instead of overwriting the T1 tier, so picking a chat model no longer changes your T1/T2/T3 configuration or the status bar.
- **Cockpit prompts are no longer invisible.** Sending from the cockpit now records the prompt in the shared transcript — shown inline in the cockpit and mirrored into the Chat view (with the streamed reply) — instead of clearing with no trace.

## [0.12.9] - 2026-06-26

### Fixed
- **Cockpit/chat prompts vanished silently on failure.** A run that errored before any tier spawned disappeared with no feedback because the app handled `tier:status` but not `session:error`. The app now surfaces run failures in a dismissible banner (and clears it on success), so you see *why* a run failed instead of the prompt just clearing.
- **"Check for Updates" reported the updater as unavailable in the installed app.** `electron-builder` excluded all of `node_modules` except `node-pty`, so `electron-updater` was never packaged and `require('electron-updater')` threw. The packaging now includes every production dependency (excluding only the `cascade-ai` workspace package, shipped separately as `cascade-core`).
- **Ollama was absent from the model picker** when no local models were discovered. The picker now always offers Ollama quick-picks (plus the existing free-text model id / `.gguf` field), and still prefers the live-discovered list when Ollama is running.
- **CLI/desktop didn't show model "thinking".** The Anthropic provider rendered `<think>…</think>` from `thinking_delta` events but never requested extended thinking. It now enables extended thinking for the 4.x reasoning models (Opus 4 / Sonnet 4) with the required `temperature = 1` and a safe `budget_tokens`; other models are unchanged.

## [0.12.8] - 2026-06-23

### Fixed
- **Packaged desktop app was permanently "offline" (and Settings/save/model lists all failed).** The embedded backend kept every dependency external but only `better-sqlite3` was shipped, so it crashed at the first `require('glob')` during config load and never started. The desktop now embeds a self-contained `desktop-core` bundle (all JS deps inlined; only native/optional modules stay external), so the backend actually starts. The npm CLI build is unchanged.
- **OpenAI-compatible (llama.cpp / LM Studio / vLLM) endpoints were never usable.** They have no fixed model catalog, so the provider was never detected as "available", its models couldn't be selected, and a configured local model couldn't resolve to it. The router now synthesizes a seed so these endpoint-configured providers are detected and their models discovered.
- **Local `.gguf` model mislabeled as Ollama.** With both `ollama` and `openai-compatible` configured, a configured model id with no provider prefix (e.g. `gemma-4-12b-it-Q4_K_M.gguf`, including a full `C:\…\model.gguf` path) was attributed to Ollama. Now the OpenAI-compatible endpoint's models are discovered at init for exact-id resolution, and the heuristic recognizes a `.gguf` / filesystem-path id (POSIX or Windows) as OpenAI-compatible. Ollama `family:tag` ids still resolve to Ollama. Added regression tests.
- **Trivial prompts (e.g. "who are you") triggered the full multi-agent build.** Self-identity/capability questions weren't treated as conversational, and the complexity classifier parsed only the first token of the reply — so a chatty local model's preamble fell through to `Complex`. Now such prompts short-circuit to Simple, and an unparseable classifier reply defaults to the cheap route, never `Complex`.
- **OpenAI-compatible API key was labeled "required".** Local servers need no key; the CLI setup now marks it optional (empty was already accepted).
- **Download page linked the wrong Windows file.** It surfaced whichever `.exe` came first (the portable app); it now lists the installer (recommended) and the portable separately.
- **Linux `deb`/`rpm`/`pacman` packaging failed** with "Please specify project homepage". Added the `homepage` + `license` metadata fpm requires, so the release now builds all Linux installers (and Arch `pacman`) alongside the AppImage.

### Added
- **Desktop chat model picker shows your real models.** It now lists the actual discovered models (Ollama tags, OpenAI-compatible/llama.cpp models, cloud catalog) grouped by provider, with a free-text entry to type any model id or `.gguf` path — works even when the live backend is unavailable.

## [0.12.7] - 2026-06-23

### Fixed
- **Desktop app stuck "offline" / could not chat.** The desktop Socket.IO client used the default parser while the embedded dashboard server encodes packets with `socket.io-msgpack-parser`, so the handshake never completed. The client now uses the matching parser (as the web dashboard already did).
- **Desktop Settings "Save" did nothing when the backend failed to start.** The shared Cascade config now loads independently of (and before) the dashboard server, so API keys, per-tier models, and budget always persist — even when the socket backend is unavailable. The status bar shows a tri-state (connected / reconnecting / offline · retry) with one-click backend restart.
- **Help/tour panel could not be closed.** It was anchored to the viewport and overlapped the draggable title bar, which swallowed the close click. It is now anchored to the content area and also closes via Escape or click-outside.

### Added
- **System-aware light/dark theming (desktop).** A JetBrains Fleet / Xcode-inspired palette with `System` / `Light` / `Dark` preference (follows the OS by default), persisted and applied across the app, Monaco editor, and terminal. Choose it in Settings → Appearance.
- **In-app self-update (desktop).** Settings → Updates shows the current version, a Check for Updates button, live download progress, and Restart & Install. Background auto-update on launch is retained.

### Changed
- **Cross-platform desktop installers.** The release now builds macOS `dmg` + `zip` (x64/arm64), Windows `nsis` + `portable`, Linux `AppImage` + `deb` + `rpm`, and Arch Linux `pacman`, with auto-update manifests.

## [0.12.6] - 2026-06-21

### Fixed
- **Cost & savings always showed $0.00.** Configured per-tier model overrides (and any current model id missing from the bundled catalogue, e.g. `claude-sonnet-4-6` / `claude-opus-4-8`) resolved to zero pricing, so total cost and "saved vs all-T1" both read $0. The catalogue now includes the current Claude model ids, and cost calculation falls back to catalogue pricing by model id whenever a `ModelInfo` arrives without it. Local models stay $0 as intended.
- **Workers ran sequentially even when independent.** T1 flagged two sections as "overlapping" if they shared even one keyword and then chained *all* flagged sections into a single sequential line — collapsing parallelism for tasks where most sections mention common words ("code", "test"). Overlap now only injects a duplication warning for soft overlap; it serializes a *single pair* only on strong overlap (≥3 shared keywords and ≥60% of the smaller set).
- **Dependency deadlocks.** When a worker's dependency failed or timed out it returned ESCALATED without publishing a terminal status, so each dependent then waited out the full 120s peer timeout — stacking into an apparent deadlock. Workers now publish a terminal status on dependency-wait early returns (dependents unblock immediately), and the dependency wait is bounded to 60s.

### Changed
- Added regression tests for catalogue-pricing fallback and the section-overlap heuristic.

## [0.12.5] - 2026-06-21

### Fixed
- **Desktop: API keys could not be saved from Settings.** The Settings panel saved only over the Socket.IO backend and silently no-op'd whenever that backend was offline. Saving now goes through a backend-independent Electron IPC path (`cascade:updateSettings` / `cascade:getSettings`), surfaces errors instead of failing silently, and refreshes the per-provider "key set" indicators after saving.
- **Desktop: onboarding dropped the OpenAI-compatible / Azure Base URL.** It was collected during onboarding but never persisted; it is now threaded through `setConfig`.
- **CLI: wrong `--version` and a spurious "Stale build" warning on every run.** `CASCADE_VERSION` was a hardcoded literal that had drifted from `package.json`; it is now injected from `package.json` at build time, so the compiled bundle's version can no longer drift.

### Changed
- **Build: externalize optional native modules.** `tsup` now marks `keytar` and `node-notifier` as `external`, so the bundle (also shipped as the desktop `cascade-core`) builds even when those optional native binaries are absent.

## [0.12.4] - 2026-06-21

### Added
- **Per-tier provider + model selection (CLI & desktop).** Each tier (T1/T2/T3) can now bind to a specific provider *and* model, with `Auto` letting routing pick. The desktop Settings → Models tab gained a provider dropdown beside each tier's model picker, and the CLI gained `cascade models set <tier> <provider:model|auto>` / `cascade models unset <tier>`. Both write to the same workspace config, so the choices are shared. Routing already understood the `provider:model` override syntax; `auto` is now treated as "no override" everywhere.
- **In-app animated tour.** The Help panel's *Watch* tab no longer shows a "Tutorial video coming soon" placeholder — it plays a self-contained, auto-advancing animated walkthrough (`AnimatedTour`) driven by each context's existing tour steps, with play/pause, prev/next, restart, and a progress bar. A rendered HyperFrames video still takes precedence once a `VIDEO_ID` is populated.

### Fixed
- **Chat could not send in the packaged app.** The desktop `main.ts` constructed `DashboardServer` with the wrong arguments (`{ port, token }` instead of `(config, store, workspacePath)`), so the backend threw on startup, the Socket.IO connection was never established, and the send button stayed permanently disabled. The backend is now wired correctly through `ConfigManager`/`MemoryStore` on a private loopback port.
- **Packaged backend missing its database engine.** `better-sqlite3` (kept external by tsup, as native modules can't be bundled) was never shipped, so the backend crashed on launch. It's now copied into the core's resource `node_modules` (with `bindings`/`file-uri-to-path`) and rebuilt for the Electron ABI in CI.
- **Onboarding re-appeared on every launch.** `electron-store` was never installed/bundled, so `require('electron-store')` always threw and fell back to an in-memory map wiped on each launch — `onboarding_done` never persisted. Replaced it with a dependency-free JSON file in `userData`.
- **Settings → Save did nothing.** The backend mutated config only in memory and never wrote it back; the modal also never pre-loaded existing values. `config:update` now persists to the workspace config file, and the panel pre-fills current per-tier models, budget, and which providers already have a key (keys are never echoed back).
- **Provider keys never reached the backend.** Onboarding/Settings keys were written to the system keychain (also unbundled) while the backend read the Cascade config — a dead end. Keys now flow into the shared workspace config the backend actually uses, with `google → gemini` and `groq → openai-compatible` mapped correctly.

## [0.12.3] - 2026-06-21

### Fixed
- **Windows desktop build failure (VS 18 / 2026).** The `windows-latest` GitHub Actions runner now resolves to the `win25-vs2026` image which ships Visual Studio 18 (2026). Both `node-gyp` and `@electron/node-gyp` only recognise VS major versions 15–17 (2017–2022); VS 18 returns `versionYear: undefined` and the build aborts with "could not find VS 2017 or newer". Pinned the Windows matrix entry to `windows-2022` which ships VS 17 (2022) and is fully supported by all current node-gyp/node-pty toolchains.

## [0.12.2] - 2026-06-21

### Fixed
- **Windows desktop build failure.** The `node-pty` rebuild failed because `@electron/rebuild@3.6.x` (and electron-builder's bundled copy) depend on `node-gyp@9.4.1`, which can no longer detect Visual Studio 2022 on the CI runner ("Could not find any Visual Studio installation to use"). Upgraded `@electron/rebuild` to `^3.7.2`, which uses the Electron-maintained `@electron/node-gyp` fork with current VS 2022 detection, and set `npmRebuild: false` in `electron-builder.yml` so packaging reuses the binary from the explicit rebuild step instead of recompiling it with electron-builder's older bundled `node-gyp`.

## [0.12.1] - 2026-06-21

### Fixed
- **node-pty crash in packaged app.** Moved `node-pty` from `devDependencies` to `dependencies`, added `asarUnpack` for `**/*.node` and `node_modules/node-pty/**` in `electron-builder.yml`, and added an `@electron/rebuild` step in the `build-desktop` CI job so the native binary is compiled for the target Electron ABI before packaging.
- **Chat view gets no response.** The frontend emitted `cascade:run` over Socket.IO but the backend had no listener. Added `onCascadeRun` + `emitToSocket` to `DashboardSocket` and wired a full Cascade run in `DashboardServer` that streams tokens back to the originating socket and emits `session:complete`.
- **ModelPicker dropdown clips above the window.** Changed `bottom: '100%'` → `top: '100%'` so the list opens downward from the header. Added `maxHeight: 280` + `overflow-y: auto` so all models are reachable. Fixed `ChatView` which was passing `tier="t1"` (non-existent prop) instead of the correct `value` / `onChange` pair; added `setActiveModelT1` Redux action so model selection persists to the store.
- **Expanded provider + model lists.** Onboarding now shows 7 providers: Auto (Smart Routing), OpenAI, Anthropic, Google Gemini, Groq, OpenAI-Compatible (Azure / Mistral / LM Studio / Together…), and Ollama. Auto and Ollama skip the API key step; OpenAI-Compatible shows a Base URL field; the provider list is scrollable so the card never overflows. `ModelPicker` gained Auto, GPT o1/o3-mini, Llama 3.3 70B (Groq), and Mixtral 8×7B (Groq) entries.

## [0.12.0] - 2026-06-20

### Added
- **Session sidebar.** A 240px panel between the activity bar and main content shows the live session history pulled from the backend via the `runtime:update` Socket.IO event. Each row displays a status dot (green for ACTIVE), session title, latest prompt preview, and a relative timestamp. Clicking a row emits `leave:session` + `join:session` to switch context; hovering reveals a delete button that calls `DELETE /api/sessions/:id`.
- **Tab bar.** A 35px strip above the main content tracks open files (Code view) and active sessions as typed tabs. Tabs have type-specific icons (`FileCode` for files, `Cpu` for sessions), a dirty-state indicator (•), and a close button (×). Clicking switches the active tab; the view routes accordingly.
- **First-run onboarding.** When no provider API key is configured (`cascade:getConfig` returns `onboardingDone: false`), the app renders a full-screen onboarding flow: welcome / provider selection (OpenAI · Anthropic · Google · Groq · Ollama) / API key entry with visibility toggle / workspace directory picker / done animation. Keys are written to the system keychain via `keytar`; the workspace is persisted in `electron-store`. A new `cascade:setConfig` IPC handler + `selectDirectory` dialog are added to `main.ts` and `preload.ts`.
- **◈ logo mark.** The title bar brand mark changed from a solid "C" square to the ◈ (U+25C8) symbol, matching the Claude Design reference.

### Changed
- **Catppuccin Macchiato-inspired palette.** All design tokens shifted to a deeper, bluer palette: `--bg-base #06080f`, `--bg-surface #0f1117`, `--bg-raised #131520`, borders `#1a1d2e`, text `#cdd6f4` (lavender), accent violet `#7c6af7`, T2 lightened to `#b87fff`, T3 deepened to `#00d4e8`, success green `#22d47a`. All 31 components read `var(--…)`, so the palette propagates automatically.
- **Title bar** height 40px → 38px; background updated to `--bg-surface`; Windows titleBarOverlay updated to match.
- **Activity bar** width 52px → 48px; active indicator rail 3px → 2px; button chip 40×40px → 32×28px; inactive icon color dimmed to `--text-dim`.
- **Status bar** height 24px → 22px; background `#0b0d15`; connection dot uses new `--success` color.
- **Cockpit.** Agent graph background replaced with a CSS dot-grid (`radial-gradient` at 22px spacing); header shrunk to 35px; task input bar height set to 50px with `#0f1117` background.
- **Agent graph** tier colors updated: T2 `#b87fff`, T3 `#00d4e8`; node fill `#131520`; edge and progress bar colors updated accordingly.

## [0.11.1] - 2026-06-20

### Added
- **Branded app icon.** Replaced the placeholder with a 1024×1024 "cascade-C" monogram — five stacked bars cascading violet (`#8b7cf9`) → cyan (`#3ec9d6`) on a deep charcoal (`#0a0a0d`) background, matching the app's design tokens. The icon is generated deterministically by `app/build-icon.cjs` (pure Node, no deps) via `npm run gen:icon -w app`, and `electron-builder.yml` now sets explicit `mac.icon` / `win.icon` (alongside `linux.icon`) so every platform installer carries the mark.
- **Custom title bar.** The window is now frameless (`titleBarStyle: hidden` / `hiddenInset`) with a themed, draggable title strip drawn in the renderer (`TitleBar.tsx`) carrying the Cascade brand mark, name, and a live connection dot. Native window controls are themed to the dark palette via `titleBarOverlay` on Windows/Linux and inset traffic lights on macOS.

### Fixed
- **Removed the unstyled native menu bar.** The default OS `File / Edit / View / Window / Help` menu bar clashed with the dark UI. It's now hidden (`autoHideMenuBar`), with a role-based application menu kept only so standard keyboard shortcuts (copy/paste/undo, reload, devtools, zoom, quit) keep working.
- **No more endless "Reconnecting to Cascade backend…" banner.** When the embedded backend fails to start in a packaged build, `main.ts` left `backendPort` set, so the renderer retried a dead port forever. It now resets `backendPort`/`authToken` so the app shows a clean offline state. The `extraResources` filter also now includes `**/*.node`, so the bundled `keytar` native addon ships in the installer — a likely cause of the backend failing to load.

## [0.11.0] - 2026-06-20

### Changed
- **Desktop app deep redesign.** Reworked the Electron app's visual identity around an evolved, dark-mode-first design-token system in `app/index.html` — a cooler layered neutral ramp, a primary violet + secondary cyan accent, per-tier identity colors (T1 amber · T2 violet · T3 cyan), semantic success/warn/danger/info tokens, an elevation + radius scale, and refined focus, selection, and scrollbar styling. Every view reads these tokens, so the new palette propagates consistently across Cockpit, Chat, Code, Settings, and the help panel.
- **View-by-view polish.** Tier-colored agent graph nodes with live status dots and progress bars, a tier legend and richer empty states in the Cockpit, refined chat message bubbles with a streaming cursor, gradient send/save actions with hover affordances, an explorer header in the Code view, a blurred settings modal, and lucide-icon thumbs for session rating. No orchestration, socket, IPC, or routing logic changed — presentation only.

### Fixed
- **Landing page now scales on mobile.** The marketing `index.html` no longer overflows on phones: the 4-column complexity table scrolls horizontally inside a wrapper instead of crushing, a new sub-480px breakpoint stacks the hero/CTA/download buttons full-width, reduces hero padding and headline sizes, reflows the T3 worker grid to two columns, and tightens card and table padding. Hero eyebrow version string refreshed to the current release.

## [0.10.4] - 2026-06-20

### Fixed
- **Desktop installers now attach to the GitHub Release.** The `build-desktop` job built the DMG/EXE/AppImage correctly on every runner, but each upload was skipped with `existing type not compatible with publishing type (existingType=release publishingType=draft)`. The release job publishes a non-draft GitHub Release, while `electron-builder` defaults to `releaseType: draft` and refuses to publish into a mismatched existing release. Setting `releaseType: release` in `app/electron-builder.yml` makes the installers and `latest*.yml` auto-update metadata attach to the release as intended.

## [0.10.3] - 2026-06-20

### Fixed
- **Release pipeline lockfile.** `electron-updater` was added to `app/package.json` in v0.10.2 but `package-lock.json` was not regenerated, causing `npm ci` to fail in CI. Lockfile updated so `npm ci` resolves all transitive deps cleanly.

## [0.10.2] - 2026-06-20

### Added
- **Adaptive learned routing.** Cascade Auto now tracks which models perform best per task type in `~/.cascade/model-perf.json` — a file that survives updates and grows over time. Explicit user ratings via `/rate good|bad` CLI command (or thumbs-up/down in the desktop app) carry 3× weight vs. auto-detected outcomes, letting the routing graph learn fast from real feedback.
- **`cascade stats` command.** Prints a per-task-type model ranking table from accumulated routing history. Shows success rate, sample count, and average cost so you can see exactly what the router has learned.
- **Desktop auto-updater.** The Electron app now checks for new GitHub releases on startup via `electron-updater` and shows a system notification when an update is available or downloaded.
- **Settings panel.** Gear icon in the activity bar opens a modal with three tabs: API Keys (Anthropic / OpenAI / Google), Model Defaults (T1/T2/T3 per-tier dropdowns), and Budget & Bias (max cost per run, routing bias radio).
- **Reconnection status banner.** An amber strip appears at the top of the main area when the desktop app loses its backend connection, replacing silent failures with a clear visual cue.
- **React error boundary.** Uncaught render errors now show a recovery screen with the error message and a Reload button instead of a blank white page.

## [0.10.1] - 2026-06-20

### Fixed
- **Desktop-app release pipeline.** The 0.10.0 release workflow failed at `npm ci` because the
  new `app` workspace pulled in `react-joyride`, whose React 15–18 peer range conflicts with
  React 19. Replaced `react-joyride` with a built-in, dependency-free walkthrough overlay
  (removing the React 19 `findDOMNode` runtime risk at the same time), regenerated the lockfile
  to include the `app` workspace, and wired `electron-builder` into the `build-desktop` job with
  auto-generated app icons so the macOS/Windows/Linux installers (and auto-update metadata) attach
  to the GitHub Release correctly.

## [0.10.0] - 2026-06-20

### Added
- **Cascade AI Desktop App.** Purpose-built Electron application with three switchable
  view modes: Cockpit (live agent orchestration graph + task input), Chat (conversational
  multi-agent interface with streaming), and Code (file tree + Monaco editor + agent diffs).
  Includes a built-in terminal (xterm.js + node-pty), system tray, desktop notifications
  for escalations and completions, and auto-updater via GitHub Releases.
- **Contextual help system.** Every UI surface has a `?` button that opens a slide-in panel
  with three tabs: Watch (HyperFrames video tutorials), Tour (interactive walkthrough),
  and Docs (searchable markdown reference with syntax highlighting).
- **Desktop installer CI.** Release workflow now builds and attaches macOS (.dmg),
  Windows (.exe), and Linux (.AppImage) installers to every GitHub Release automatically.

## [0.9.7] - 2026-06-20

### Added
- **Cascade Auto per-T2-manager model routing.** When `cascadeAuto` is enabled, each T2 manager
  now independently selects the benchmark-best model for its section type (coding, writing,
  analysis, …) — matching the per-subtask routing T3 workers already had. Concurrent T2 managers
  handling different section types will automatically use different models.

## [0.9.6] - 2026-06-16

Tool-sandbox hardening for runtime tool generation. LLM-authored tool code is now treated as
untrusted end-to-end: isolated execution, mandatory approval, and re-validated persistence.

### Security
- **Generated tools now run in a worker thread, not `node:vm`.** `node:vm` was never a security
  boundary (its `timeout` can't stop async runaway, code shared the main heap, and a throw could take
  down the TUI). Execution moved to `node:worker_threads` (built-in — no native dependency), giving an
  **enforceable kill timeout** (`worker.terminate()`, verified terminating an infinite loop in ~600 ms),
  a memory cap (`resourceLimits`), and crash containment. Cascade's privileged objects (registry,
  router, the permission escalator) stay on the main thread; the worker reaches them only through a
  message bridge whose `callTool` path is escalator-gated and whose `fetch` path stays SSRF-guarded by
  `safeFetch`. Timeout is tunable via `CASCADE_DYNAMIC_TOOL_TIMEOUT_MS`.
- **Dangerous tool calls now default-deny.** A generated tool that calls a dangerous tool (`shell`,
  `file_write`, `file_delete`, …) when no approver is wired is now **denied** instead of executing
  unguarded. The escalator is resolved **lazily at call time**, so tools registered before the per-run
  escalator exists (persisted at init, received from a peer) are still gated.
- **Persisted/peer tools load as untrusted and re-validated.** `.cascade/dynamic-tools.json` entries
  (and peer-broadcast specs) are re-checked on load and marked **untrusted**, so any dangerous action
  always **re-escalates** to you (`forceReprompt` bypasses the session approval cache) — a tool authored
  in a prior, possibly prompt-injected, run can no longer silently re-arm. New `persistDynamicTools`
  config (default `true`) disables persistence entirely when set to `false`.

### Tests
- `src/tools/tool-creator.test.ts` grows to 16 cases — worker compute, infinite-loop kill, default-deny
  with the dangerous op confirmed not to run, lazy-escalator gating, trusted vs untrusted `forceReprompt`,
  persisted re-validation + untrusted marking, the disable flag, and the escalator cache-bypass. Suite
  236 → 244.

## [0.9.5] - 2026-06-16

Dependency-hardening pass (safe + tested bumps only) plus a tool-generation correctness fix
surfaced while auditing the tool system.

### Fixed
- **Runtime tool generation was broken for any tool that did I/O.** `ToolCreator` validates
  generated code with a syntax check before registering it, but compiled it as a *synchronous*
  function while the runtime executes it inside an `async` IIFE. Every generated tool that used
  `await callTool(...)` or `await fetch(...)` — i.e. essentially all useful tools, including the
  generator prompt's own `file_read` example — was rejected as "await is only valid in async
  functions" and silently discarded. The check now validates with `AsyncFunction` semantics.

### Security / Dependencies
- **Cleared the `ws` DoS advisory (GHSA-96hv-2xvq-fx4p) on the server side.** Added an
  `overrides` pin of `ws` to `^8.21.0` (patched), unifying the socket.io server chain on the
  fixed release. This removes the 3 high-severity server-side findings; the only residual `ws`
  node is the **browser** socket.io-client, where the Node `ws` library is never executed
  (browsers use the native `WebSocket`), so it is not exploitable in the shipped dashboard.
- **Removed the unused `uuid` dependency.** Cascade generates IDs with `node:crypto.randomUUID`
  and never imported the `uuid` package — it was a vestigial direct dependency.
- **Safe in-range refreshes** (semver-compatible, full suite + build verified): `better-sqlite3`
  → 12.11.1, `undici` → 6.27.0, `playwright` → 1.61.0, `@tanstack/react-virtual` → 3.14.3.
- **Deferred (intentionally not forced):** the remaining audit findings all require *breaking*
  major upgrades and are tracked for a dedicated pass — runtime: `@anthropic-ai/sdk`, `node-cron`,
  `node-notifier`, transitive `uuid` (via the two former); dev/build-only and never shipped to
  npm consumers: `vitest`/`vite`/`esbuild`/`tsup`/`vite-node`. Production-only `npm audit` is down
  to 8 (from a chain of ws-driven highs), and none of the residual highs are reachable at runtime.

### Tests
- Added `src/tools/tool-creator.test.ts` (8 cases) — the tool-generation capability previously had
  **no coverage**, which is how the async-syntax-check regression shipped. Covers schema
  normalization, pure-compute generation, `await callTool()` (regression guard), the SSRF guard on
  the sandboxed `fetch`, syntax-error rejection, capability dedup, and dangerous-tool escalation.

## [0.9.4] - 2026-06-16

### Fixed
- **Cancellation is now near-instant.** The run's abort signal is threaded into the provider
  calls themselves (anthropic / openai / azure / gemini / ollama), so Ctrl+C/ESC aborts the
  **in-flight** request instead of only stopping between LLM calls — a real run cancelled in
  **~31 ms** vs. ~38 s before. Provider `AbortError` is converted to a graceful cancel (partial
  output preserved, no error surfaced), and a rapid double-press can no longer be dropped (the
  cancel-armed flag is read from a ref, not stale React state). A `⊘ Cancelling…` indicator shows
  immediately.
- **Cascade Auto no longer overrides an explicitly-configured model.** Auto only routes tiers
  left on `auto`, and its per-task picks are restored after each run — so `/why`, the status bar,
  and the next run reflect your configured models (the missing `restoreTierModels`).
- **Slash commands show immediate feedback.** A command is echoed the moment you press Enter, and
  a `⠋ Running command…` indicator shows while async ones (e.g. `/plan`) work.
- **Slash commands are excluded from up-arrow history** — recalling prompts no longer gets stuck
  on the last `/command` or triggers scroll.

## [0.9.3] - 2026-06-16

### Security
- **Dropped axios entirely.** The pinned axios 1.13.6 carried ~24 HIGH advisories (SSRF,
  prototype-pollution credential theft, proxy-auth leakage). Rather than upgrade it (which
  conflicts with the project's long-standing axios pin), the **4 runtime call sites were
  migrated to native `fetch`** — the Ollama provider (streaming via the async-iterable
  response body), the GitHub/GitLab tool (status-aware error handling preserved), webhook
  notifications, and `cascade doctor` — and **`posthog-node` was bumped to v5**, which no
  longer depends on axios. `axios` is now absent from the dependency tree (`npm ls axios` is
  empty), and the shipped CLI is axios-free.

### Notes
- The remaining `npm audit` findings are pre-existing transitive / dev-only dependencies that
  each need a breaking major bump, so they're deferred (out of scope for the axios pass) to
  avoid a breaking-change cascade pre-1.0: **esbuild** (build/dev-server only — not shipped to
  CLI users), **ws** and **uuid** (transitive via socket.io / node-cron / @google/genai / ink),
  and **@anthropic-ai/sdk** / **diff**.

## [0.9.2] - 2026-06-16

### Added
- **Ctrl+C / ESC now cancel the running task** instead of only quitting. While a task is in
  progress: the first Ctrl+C warns ("press again to cancel the task"), the second **cancels the
  run** and keeps Cascade open; **ESC cancels outright**. When idle, Ctrl+C keeps its old
  double-press **quit** behavior. The run's partial output is preserved (a `⊘ Task cancelled`
  note is shown). Wires the REPL to the existing `AbortSignal` cancellation path
  (`cascade.run({ signal })` → `run:cancelled`).

## [0.9.1] - 2026-06-15

### Added
- **T3→T2 reinforcement request** (`reinforcements.enabled`, off by default) — a worker that
  discovers its subtask should fan out can call a new **`request_workers`** tool to have its
  **manager spawn bounded sibling workers** for the new pieces. No 4th tier: the new workers are
  ordinary siblings under the same T2 (so they honor `t3Execution`), bounded by
  `reinforcements.maxPerSection` (default 4) and **depth-1** (reinforcement workers can't request
  more). This is the lighter replacement for sub-agent spawning — the T1/T2/T3 tiers are already
  an agent hierarchy, so a recursive 4th tier was redundant and risked local-Ollama contention.

### Docs
- Refreshed the landing page (`index.html`) and `README.md`.

## [0.9.0] - 2026-06-15

Resumability, reflection, and smarter local execution.

### Added
- **Run resumability** + **`/continue [tokens]`** — when a task stops at the budget cap, resume
  it with a raised budget instead of redoing it. Files already created persist on disk (via
  snapshots), so only the remaining work runs. `Cascade.resumeRun()` for SDK use.
- **Reflection / self-critique** (`reflection.enabled`, off by default) — after a worker's
  pass/fail self-test, an optional **goal-alignment** critique revises the output once if it
  falls short of the intent (distinct from, and on top of, the self-test).
- **`t3Execution`** (`'auto'` default · `'parallel'` · `'sequential'`) — T3 waves now run
  **sequentially for a local (Ollama) tier** (a single GPU serializes anyway, so parallel just
  thrashed the queue and risked slot-wait timeouts) and **parallel for cloud**. Force either if
  you prefer.

### Notes
- New config: `reflection`, `t3Execution`. Sub-agent spawning was re-scoped to a lighter
  "T3→T2 reinforcement request" for a later release (the T1/T2/T3 tiers are already an agent
  hierarchy, so a 4th tier was redundant and brought local-deadlock risk).

## [0.8.0] - 2026-06-14

Agentic controls — autonomy, smarter re-planning, and new slash commands (sub-agent
spawning follows in v0.9.0).

### Added
- **Autonomous mode** + **`/auto [on|off|status]`** — hands-off runs: the plan gate
  auto-approves and **non-dangerous** tools run without prompts, while **dangerous** tools
  still escalate and budget caps remain the hard stop. Config: `autonomy: 'manual' | 'auto'`.
- **Dynamic re-planning with early-stop** — T1's reviewer loop now **stops early when a
  corrective pass makes no net progress**, returning the best partial result instead of
  burning passes (and tokens) toward the budget cap. Config: `maxReplanPasses` (default 2).
- **`/plan <prompt>`** — preview T1's decomposition **without executing it** (the command
  deferred from v0.7.0).
- **`/replan [guidance]`** — re-run the last task with a corrective/steering framing.

### Notes
- New config: `autonomy`, `maxReplanPasses`. All slash commands registered in `/help`.
- Motivated by a real run that burned ~115 min before the budget cap stopped it; early-stop
  cuts that short when work isn't converging.

## [0.7.0] - 2026-06-14

Plan-review upgrade — the boardroom gate becomes a real review loop (the agentic
features — dynamic re-planning, autonomous mode, sub-agent spawning — follow in v0.8.0).

### Added
- **Iterative plan revision** — a steering note now re-plans **and re-asks**, so the
  board can refine T1's plan across multiple rounds (capped by `planReview.maxRevisionRounds`,
  default 5) instead of a single take-it-or-leave-it pass.
- **Automated plan reviewer** — with `planReview.autoReviewer`, a reviewer model critiques
  the plan (risks, gaps, over-/under-decomposition) and the critique is shown in the approval
  dialog before you decide.
- **Editable plan** — drop sections inline in the approval dialog (↑/↓ to move, `x` to drop,
  `m` to add a steering note); the edited plan runs directly without a re-decompose.
- **Wider gate** — `planApproval` gains `'complex'` and `'all'` (`'always'` kept as an alias);
  `'all'` also gates **Moderate** runs, pausing to review the worker decomposition before any
  worker spawns. (`planReview.editable` toggles inline editing.)

### Notes
- `planApproval` accepts `'never' | 'complex' | 'all' | 'always'`; new `planReview` config block.
- An on-demand `/plan` preview command is planned for a follow-up.

## [0.6.0] - 2026-06-14

### Added
- **Live benchmark-aware Cascade Auto** — when a tier is set to Auto, each task is
  routed to the model that is the best *value* (quality × cost-efficiency) for its
  type, using **current** public data. Quality scores come from a hybrid source
  (live GitHub-raw snapshot → on-disk cache → bundled table); per-token prices come
  live from OpenRouter (free, no key). All fetching is background and time-boxed —
  fully offline-safe.
- **Live model discovery** — each configured provider's live model list is queried
  on startup so newly released models are usable and stale catalog ids are caught.
- **`autoBias` config** (`balanced` default · `quality` · `cost`) to tune the
  cost/quality trade-off, plus a `benchmarks` config block (live toggle, refresh
  interval, custom source URL, pricing toggle).
- **Routing transparency** — `cascade models` shows each tier's benchmark score and
  the data source (live/cached/bundled) + pricing origin; `/why` reports the score,
  price, and data source behind each Cascade Auto pick.
- **Scheduled benchmark refresh** — a weekly workflow regenerates the bundled
  snapshot and opens a data-only PR (no version bump, so it never triggers a release).

### Fixed
- **Gemini `404 … is not found` on Auto** — the catalog mapped `gemini-2.5-flash`/
  `gemini-2.5-pro` to retired `-preview-*` ids; updated to the GA ids. The router now
  also **self-heals**: a "model not found" error drops the dead model and fails over
  to the next candidate instead of surfacing the raw error.
- **Pasting an API key inserted it twice with `[200~` markers** — Ink 6's native
  bracketed-paste handling raced our raw-stdin handler. Paste is now owned by a single
  handler, and bare (ESC-less) `[200~`/`[201~` markers are stripped as a safety net.
- **Runs could freeze with no output** — a stalled cloud stream (TCP open, no terminal
  chunk) or an unanswered tool-approval prompt awaited forever. Cloud LLM calls are now
  time-boxed (`cloudInferenceTimeoutMs`, default 2 min) and approval waits deny on timeout
  (`approvalTimeoutMs`, default 10 min), so one stuck call can no longer hang the whole run.

## [0.5.7] - 2026-06-13

The first tagged release since v0.5.5 — it rolls up the v0.5.6/v0.5.7 work plus
two feature/fix tracks that landed on top of it.

### Added
- **Delegation savings counter** — live `saved $X (Y%) vs. all-T1` in the StatusBar
  and `/cost`, plus a per-run receipt.
- **Agent comms feed (`/comms`)** — live ticker of PeerBus traffic (peer messages,
  broadcasts, file locks, barrier syncs).
- **`/why`** — per-run decision trail: complexity verdict + reason, models per tier,
  provider failovers, and permission escalations.
- **Boardroom plan gate** (`planApproval: "always"`) — approve the org chart before
  any T2 spawns (opt-in; default unchanged).
- **`--alt-screen`** — opt-in vim-style alternate screen with in-app PgUp/PgDn history.
- **`/copy [n]`** — copy a response via native clipboard tools with an OSC 52 fallback.
- **`cascade link`** — reuse credentials from Claude Code / Codex / Gemini CLI /
  Copilot (API keys adopt directly; subscription OAuth tokens only with `--accept-risk`).
- **Benchmark-aware model routing** — selecting "Auto" now enables Cascade Auto and a
  curated public-benchmark table routes each subtask to the model strongest at its
  type (per-subtask, cross-provider; local-only tiers pick the best local model).
- **Per-task budget ceiling** (`budget.maxTokensPerRun`, default 200k) stops runaway
  spend with a graceful partial result.
- **Runtime tool persistence & sharing** — created tools are saved to
  `.cascade/dynamic-tools.json` (reloaded next run), deduped by capability, and
  broadcast over the peer bus.

### Changed
- **Ink 5 → 6.8, React 18 → 19** (both workspaces); Node engines floor raised to **20**.
- **Flicker-free rendering** — `computeLiveAreaBudget()` shrinks panels before Ink
  redraws the whole screen; height-capped panels; terminal resize handling.
- Installs are now deterministic — `package-lock.json` and `web/package-lock.json`
  are committed (fixes the `ERESOLVE` seen when upgrading an existing checkout).
- Read-only inquiries ("read/explain/analyze this file") classify as **Simple**
  (single agent) instead of fanning out into the full hierarchy; the classifier
  error-path defaults to Moderate, not Complex.
- The text-tool fallback for non-native models carries full schema (enums, required)
  and parses tool calls far more tolerantly; tool-call arguments are validated first.

### Fixed
- **Security hardening** — dashboard network exposure, `web_fetch` SSRF, approval
  gaps, and code-interpreter injection; plus 10 issues from the ORACLE audit.
- **Slash-command popup** no longer corrupts while scrolling (constant row count,
  full-width rows).
- A trivial "read the README" task could fan out and **hang ~5 min / burn 655K
  tokens** — fixed via the classification change, the per-task cap, and gating
  file-lock coordination to write tasks with a timeout.
- **Tool creation** surfaces failures instead of swallowing them and wraps generated
  schemas into valid JSON Schema so created tools work across providers.
- Startup now warns on a stale build (compiled bundle version ≠ source), and
  `bin/cascade.js` prints a friendly "run `npm install && npm run build`" on a
  missing `dist/`.

## [0.5.6] - 2026-05-24

### Changed
- TUI visual redesign.

### Fixed
- Azure setup-wizard flow.
- StatusBar background-strip rendering.

## [0.5.5] - 2026-05-23

### Fixed
- Init wizard tier-model picker scrolls (`limit={8}`) instead of overflowing.
- Chat scrolling restored — stopped enabling mouse-reporting on mount (a v0.5.4
  regression) so the terminal's native scrollback works again.
- Slash-command suggestion panel — `wrap="truncate"` on descriptions + one extra
  row of fixed height so long entries don't squish onto one line.

## [0.5.4] - 2026-05-23

### Added
- `--alt-screen` precursor work: `<Static>`-based conversation rendering so completed
  messages go to native scrollback and only the live area re-renders.
- Auto-clear of the agent tree 8 s after a task completes.

### Changed
- `tier:status` throttled to 100 ms; `React.memo` on `AgentTree` / `StatusBar` / `HintBar`.

### Fixed
- Maximized-terminal flicker on cmd / PowerShell.
- Orchestrator resilience: new `CriticalToolError` (stops the agent loop on
  rate-limit/auth errors instead of retrying 15×) and `WorkerStallError` (carries
  partial output); T1 now surfaces the real root cause when all sections fail.

## [0.5.3] - 2026-05-23

### Added
- Headless `cascade run` / `-p` — bypasses the Ink REPL in non-TTY contexts
  (CI, pipes, scripts); progress to stderr, answer to stdout.

### Fixed
- `cascade models` column layout; `/clear` also resets cost maps; richer `/config`
  output with an undefined-`dashboard` guard.

## [0.5.2] - 2026-05-22

### Added
- Redesigned first-run setup wizard (welcome header, phased step tabs, field boxes).
- New tools — `glob`, `grep`, `web-fetch` — plus a model-performance tracker.

### Fixed
- Removed an accidental `cascade-ai` self-dependency; corrected `/tree` and
  `/sessions` descriptions; fixed stale T2/T3 test mocks.

---

Older releases (v0.1.1 – v0.4.0): see the
[GitHub Releases](https://github.com/Varun-SV/Cascade-AI/releases) page.

[0.5.7]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.7
[0.5.6]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.6
[0.5.5]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.5
[0.5.4]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.4
[0.5.3]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.3
[0.5.2]: https://github.com/Varun-SV/Cascade-AI/releases/tag/v0.5.2
