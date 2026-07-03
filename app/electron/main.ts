import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  nativeImage,
  nativeTheme,
  protocol,
  net as electronNet,
} from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

const isDev = process.env.ELECTRON_DEV === '1';

// ─── Port helper ─────────────────────────────────────────────────────────────
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ─── Globals ─────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendPort = 0;
let authToken = '';
// Human-readable reason the dashboard socket backend isn't reachable, surfaced to
// the renderer (status bar) so "offline" can explain itself and offer a retry.
// null = healthy/connected-capable; a string = the dashboard failed to start.
let backendError: string | null = null;

// Live references to the running Cascade backend so the config IPC handlers can
// mutate the SAME config object the DashboardServer holds (no restart needed):
// writing a provider key here makes the next chat run pick it up immediately.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let configManager: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cascadeConfig: any = null;

// Onboarding provider ids → Cascade core ProviderType (+ default base URL).
// 'auto' has no single provider; keys are configured per concrete provider.
function mapProvider(id: string): { type: string | null; baseUrl?: string } {
  switch (id) {
    case 'openai': return { type: 'openai' };
    case 'anthropic': return { type: 'anthropic' };
    case 'google': case 'gemini': return { type: 'gemini' };
    case 'groq': return { type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' };
    case 'openai-compatible': return { type: 'openai-compatible' };
    case 'ollama': return { type: 'ollama' };
    default: return { type: null };
  }
}

// ─── Backend ─────────────────────────────────────────────────────────────────
// Resolve the cascade-ai core package (built CommonJS output). In dev it lives at
// the repo's ../dist; in a packaged app it's bundled under resources/cascade-core.
function loadCore(): { DashboardServer: any; ConfigManager: any; CascadeRouter: any; nodeHttpFetch: (input: string | URL, init?: RequestInit) => Promise<Response> } {
  // Dev: the repo's external-deps build (node_modules resolves the requires).
  // Packaged: the self-contained `desktop-core.cjs` bundle (no node_modules to
  // resolve from — every JS dep is bundled in; only native modules like
  // better-sqlite3 are shipped alongside in cascade-core/node_modules).
  const corePath = isDev
    ? join(__dirname, '../../dist/index.cjs')
    : join(process.resourcesPath, 'cascade-core/desktop-core.cjs');
  return require(corePath);
}

async function startBackend(): Promise<void> {
  backendPort = await findFreePort();
  // Generate a random session token for auto-login
  authToken = require('node:crypto').randomBytes(24).toString('hex');
  backendError = null;

  const workspace = getWorkspacePath();

  // STEP 1 — Load the shared Cascade config FIRST, in its own guard. This is the
  // same .cascade/config.json the `cascade` CLI uses, so API keys, per-tier
  // models, and budget settings are unified across desktop + CLI. Keeping this
  // independent of the dashboard server means Settings can ALWAYS persist (the
  // `cascade:updateSettings` IPC only needs configManager/cascadeConfig), even
  // when the socket backend itself fails to come up.
  try {
    const { ConfigManager } = loadCore();
    configManager = new ConfigManager(workspace);
    await configManager.load();
    cascadeConfig = configManager.getConfig();
  } catch (err) {
    console.warn('[main] Config load failed:', err);
    configManager = null;
    cascadeConfig = null;
    backendError = `Could not load Cascade config: ${err instanceof Error ? err.message : String(err)}`;
    backendPort = 0;
    authToken = '';
    notifyBackendStatus();
    return; // nothing else can work without config
  }

  // STEP 2 — Start the embedded dashboard socket server on a private loopback
  // port with auth disabled (single-user local backend on 127.0.0.1, ephemeral
  // port; the renderer can't mint a JWT so the handshake is unnecessary). If this
  // fails, config still works — only live chat/connectivity is unavailable.
  try {
    const { DashboardServer } = loadCore();
    cascadeConfig.dashboard = {
      ...cascadeConfig.dashboard,
      port: backendPort,
      host: '127.0.0.1',
      auth: false,
    };
    const server = new DashboardServer(cascadeConfig, configManager.getStore(), workspace);
    await server.start();
    console.log(`[main] Cascade backend started on port ${backendPort} (workspace: ${workspace})`);
  } catch (err) {
    console.warn('[main] Dashboard server start failed:', err);
    // Reset the port so the renderer's `if (!backendPort) return` guard skips
    // Socket.IO instead of dialing a dead port and looping on "Reconnecting".
    backendPort = 0;
    authToken = '';
    backendError = `Cascade backend unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
  notifyBackendStatus();
}

// Push the current backend health to the renderer so the status bar can update
// live after an on-demand restart (the initial value is read via cascade:meta).
function notifyBackendStatus(): void {
  mainWindow?.webContents.send('cascade:backendStatus', {
    port: backendPort,
    token: authToken,
    error: backendError,
  });
}

// ─── Theme ───────────────────────────────────────────────────────────────────
// The user's appearance preference: 'system' follows the OS, 'light'/'dark'
// force a mode. Persisted in cascade-desktop.json so it survives launches and is
// applied to `nativeTheme.themeSource` (which also themes native chrome:
// menus, scrollbars, the title-bar overlay, and form controls via color-scheme).
type ThemePref = 'system' | 'light' | 'dark' | 'midnight';

function getThemePref(): ThemePref {
  const v = loadDesktopMeta().theme;
  return v === 'light' || v === 'dark' || v === 'midnight' ? v : 'system';
}

function applyThemePref(pref: ThemePref): void {
  // 'midnight' is a renderer-only palette; native chrome follows dark.
  nativeTheme.themeSource = pref === 'midnight' ? 'dark' : pref;
}

// ─── Auto-update ─────────────────────────────────────────────────────────────
// electron-updater pulls latest*.yml from the GitHub Release (see
// electron-builder.yml `publish`). We keep background download on so a freshly
// published version installs on next launch, AND expose IPC so the Settings →
// Updates panel can trigger a check, show progress, and install on demand.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let autoUpdater: any = null;

function sendUpdateStatus(status: string, data: Record<string, unknown> = {}): void {
  mainWindow?.webContents.send('update:status', { status, ...data });
}

/**
 * electron-updater throws noisy internal errors (missing latest.yml, 404, no
 * published release) when a check runs before a release's assets are live —
 * e.g. right after merging a PR while the build workflow is still running.
 * Turn those into a calm message instead of dumping the raw stack in the UI.
 */
function friendlyUpdateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/latest\.yml|404|no published|ENOENT|cannot find|Unable to find|not found|no release/i.test(raw)) {
    return "You're on the latest version, or a new release is still being published — check back shortly.";
  }
  return raw;
}

function setupAutoUpdate(): void {
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch {
    autoUpdater = null; // dev, or electron-updater unavailable
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (info: { version?: string }) => {
    sendUpdateStatus('available', { version: info?.version });
    new Notification({ title: 'Cascade AI — Update Available', body: `Version ${info?.version ?? ''} is downloading in the background.` }).show();
  });
  autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'));
  autoUpdater.on('download-progress', (p: { percent?: number }) => sendUpdateStatus('downloading', { percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (info: { version?: string }) => {
    sendUpdateStatus('downloaded', { version: info?.version });
    new Notification({ title: 'Cascade AI — Restart to Update', body: 'A new version is ready. Relaunch to install.' }).show();
  });
  autoUpdater.on('error', (err: unknown) => sendUpdateStatus('error', { message: friendlyUpdateError(err) }));

  // Silent check on launch; failures (e.g. dev without app-update.yml) are ignored.
  autoUpdater.checkForUpdatesAndNotify?.().catch(() => { /* offline or dev */ });
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
function registerIPC(): void {
  // Appearance: read/write the System/Light/Dark preference. The renderer's
  // useTheme hook resolves this into a concrete `data-theme` on <html>.
  ipcMain.handle('theme:get', () => ({
    preference: getThemePref(),
    shouldUseDark: nativeTheme.shouldUseDarkColors,
  }));
  ipcMain.handle('theme:set', (_e, preference: ThemePref) => {
    const pref: ThemePref = preference === 'light' || preference === 'dark' || preference === 'midnight' ? preference : 'system';
    saveDesktopMeta({ theme: pref });
    applyThemePref(pref);
    return { preference: pref, shouldUseDark: nativeTheme.shouldUseDarkColors };
  });

  // Updates: current version + manual check/install for the Settings panel.
  ipcMain.handle('update:getVersion', () => app.getVersion());
  ipcMain.handle('update:check', async () => {
    if (!autoUpdater) return { ok: false, error: 'updater-unavailable' };
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r?.updateInfo?.version, current: app.getVersion() };
    } catch (err) {
      return { ok: false, error: friendlyUpdateError(err) };
    }
  });
  ipcMain.handle('update:install', () => {
    // Restart and apply the downloaded update. No-op if nothing is downloaded.
    try { autoUpdater?.quitAndInstall(); } catch { /* nothing downloaded */ }
  });

  ipcMain.handle('cascade:meta', () => ({
    port: backendPort,
    token: authToken,
    platform: process.platform,
    version: app.getVersion(),
    error: backendError,
  }));

  // Retry the embedded backend on demand (the status bar exposes this when the
  // dashboard failed to start). Returns the fresh meta so the renderer can
  // reconnect Socket.IO with the new port/token without a full app restart.
  ipcMain.handle('cascade:restartBackend', async () => {
    await startBackend();
    return { port: backendPort, token: authToken, error: backendError };
  });

  // PTY (terminal) — node-pty runs in main process, data ferried via IPC
  let pty: import('node-pty').IPty | null = null;
  ipcMain.handle('pty:spawn', (_e, cwd: string) => {
    try {
      const nodePty = require('node-pty');
      const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL ?? '/bin/bash');
      const term: import('node-pty').IPty = nodePty.spawn(shell, [], { cwd, env: process.env, cols: 80, rows: 24 });
      pty = term;
      term.onData((data: string) => mainWindow?.webContents.send('pty:data', data));
      term.onExit(() => mainWindow?.webContents.send('pty:exit'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.on('pty:write', (_e, data: string) => pty?.write(data));
  ipcMain.on('pty:resize', (_e, cols: number, rows: number) => pty?.resize(cols, rows));
  ipcMain.on('pty:kill', () => { pty?.kill(); pty = null; });

  // File system
  ipcMain.handle('fs:readDir', async (_e, dirPath: string) => {
    const { readdir, stat } = require('node:fs/promises');
    const entries = await readdir(dirPath);
    return Promise.all(entries.map(async (name: string) => {
      const fullPath = join(dirPath, name);
      const s = await stat(fullPath);
      return { name, fullPath, isDirectory: s.isDirectory() };
    }));
  });
  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    const { readFile } = require('node:fs/promises');
    return readFile(filePath, 'utf8');
  });
  ipcMain.handle('fs:writeFile', async (_e, filePath: string, content: string) => {
    const { writeFile } = require('node:fs/promises');
    await writeFile(filePath, content, 'utf8');
    return { ok: true };
  });
  ipcMain.handle('fs:mkdir', async (_e, dirPath: string) => {
    const { mkdir } = require('node:fs/promises');
    await mkdir(dirPath, { recursive: true });
    return { ok: true };
  });
  ipcMain.handle('fs:createFile', async (_e, filePath: string) => {
    const { writeFile, access } = require('node:fs/promises');
    try { await access(filePath); } catch { await writeFile(filePath, '', 'utf8'); }
    return { ok: true };
  });
  ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string) => {
    const { rename } = require('node:fs/promises');
    await rename(oldPath, newPath);
    return { ok: true };
  });
  ipcMain.handle('fs:delete', async (_e, targetPath: string) => {
    const { shell } = require('electron');
    await shell.trashItem(targetPath); // OS trash (recoverable)
    return { ok: true };
  });
  // Bounded recursive text search across the workspace.
  ipcMain.handle('fs:search', async (_e, root: string, query: string) => {
    if (!query || !query.trim() || !root) return [];
    const { readdir, stat, readFile } = require('node:fs/promises');
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', '.next', 'out', 'coverage', '.cache']);
    const results: Array<{ file: string; line: number; text: string }> = [];
    const MAX = 500, MAX_BYTES = 512 * 1024;
    const q = query.toLowerCase();
    async function walk(dir: string): Promise<void> {
      if (results.length >= MAX) return;
      let names: string[];
      try { names = await readdir(dir); } catch { return; }
      for (const name of names) {
        if (results.length >= MAX) return;
        if (IGNORE.has(name)) continue;
        const full = join(dir, name);
        let s; try { s = await stat(full); } catch { continue; }
        if (s.isDirectory()) { await walk(full); }
        else if (s.size <= MAX_BYTES) {
          let text: string; try { text = await readFile(full, 'utf8'); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              results.push({ file: full, line: i + 1, text: lines[i].slice(0, 200).trim() });
              if (results.length >= MAX) break;
            }
          }
        }
      }
    }
    await walk(root);
    return results;
  });

  // Config — read/write provider API key + workspace for onboarding.
  // Desktop-only meta (provider, workspace, onboarding flag) lives in a JSON file
  // under userData; the actual API keys live in the shared Cascade workspace
  // config so the embedded backend (and the CLI) can use them.
  ipcMain.handle('cascade:getConfig', async () => {
    try {
      const meta = loadDesktopMeta();
      const provider = (meta.provider as string) ?? '';
      const workspace = (meta.workspace as string) ?? '';
      const onboardingDone = Boolean(meta.onboarding_done);
      let apiKey = '';
      const { type } = mapProvider(provider);
      if (type && cascadeConfig?.providers) {
        apiKey = cascadeConfig.providers.find((p: { type: string; apiKey?: string }) => p.type === type)?.apiKey ?? '';
      }
      return { provider, apiKey, workspace, onboardingDone };
    } catch {
      return { provider: '', apiKey: '', workspace: '', onboardingDone: false };
    }
  });

  ipcMain.handle('cascade:setConfig', async (_e, cfg: { provider: string; apiKey: string; workspace: string; baseUrl?: string }) => {
    try {
      saveDesktopMeta({ provider: cfg.provider, workspace: cfg.workspace, onboarding_done: true });
      // Write the key into the live Cascade config (same object the running
      // DashboardServer holds), then persist it — the next chat run picks it up
      // immediately with no backend restart.
      const mapped = mapProvider(cfg.provider);
      const type = mapped.type;
      // Prefer a user-supplied base URL (Azure / OpenAI-compatible endpoint) over
      // the provider's built-in default — onboarding used to drop it entirely.
      const baseUrl = cfg.baseUrl?.trim() || mapped.baseUrl;
      if (type && cfg.apiKey && cascadeConfig && configManager) {
        if (!Array.isArray(cascadeConfig.providers)) cascadeConfig.providers = [];
        const existing = cascadeConfig.providers.find((p: { type: string }) => p.type === type);
        if (existing) {
          existing.apiKey = cfg.apiKey;
          if (baseUrl) existing.baseUrl = baseUrl;
        } else {
          cascadeConfig.providers.push({ type, apiKey: cfg.apiKey, ...(baseUrl ? { baseUrl } : {}) });
        }
        await configManager.save();
      }
    } catch (err) {
      console.warn('[main] setConfig failed:', err);
    }
  });

  // Settings panel — a backend-independent path to read/write keys, per-tier
  // models, and budget. The renderer previously saved ONLY via the Socket.IO
  // backend; if that backend failed to start (e.g. a missing native binding or a
  // failed cascade-core build), the Save button silently no-op'd. Routing through
  // the same ConfigManager the backend uses guarantees Settings can always
  // persist, even when there is no socket.
  function settingsSnapshot(): {
    models: Record<string, string>;
    budget: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number };
    providersWithKey: string[];
    endpoints: Record<string, string>;
    advanced: Record<string, unknown>;
  } {
    const models = (cascadeConfig?.models ?? {}) as Record<string, string>;
    const budget = {
      maxCostPerRun: cascadeConfig?.budget?.maxCostPerRunUsd as number | undefined,
      autoBias: cascadeConfig?.autoBias as string | undefined,
      dailyBudgetUsd: cascadeConfig?.budget?.dailyBudgetUsd as number | undefined,
      sessionBudgetUsd: cascadeConfig?.budget?.sessionBudgetUsd as number | undefined,
      maxTokensPerRun: cascadeConfig?.budget?.maxTokensPerRun as number | undefined,
      warnAtPct: cascadeConfig?.budget?.warnAtPct as number | undefined,
    };
    const providers = (cascadeConfig?.providers ?? []) as Array<{ type: string; apiKey?: string; baseUrl?: string }>;
    const providersWithKey = providers
      .filter((p) => typeof p.apiKey === 'string' && p.apiKey.length > 0)
      .map((p) => p.type);
    const endpoints: Record<string, string> = {};
    for (const p of providers) { if (p?.type && p?.baseUrl) endpoints[p.type] = p.baseUrl; }
    // Advanced knobs surfaced in the Settings "Advanced" tab — read back from
    // the same config so the panel always reflects what's on disk.
    const advanced: Record<string, unknown> = {
      autonomy: cascadeConfig?.autonomy,
      planApproval: cascadeConfig?.planApproval,
      approvalTimeoutMs: cascadeConfig?.approvalTimeoutMs,
      t3Execution: cascadeConfig?.t3Execution,
      localConcurrency: cascadeConfig?.localConcurrency,
      localInferenceTimeoutMs: cascadeConfig?.localInferenceTimeoutMs,
      cloudInferenceTimeoutMs: cascadeConfig?.cloudInferenceTimeoutMs,
      reflectionEnabled: cascadeConfig?.reflection?.enabled,
      cascadeAuto: cascadeConfig?.cascadeAuto,
      forceTier: cascadeConfig?.routing?.forceTier,
      benchmarksLive: cascadeConfig?.benchmarks?.live,
      dynamicToolSandbox: cascadeConfig?.tools?.dynamicToolSandbox,
      factsExtraction: cascadeConfig?.knowledge?.factsExtraction,
      enableToolCreation: cascadeConfig?.enableToolCreation,
      persistDynamicTools: cascadeConfig?.persistDynamicTools,
      telemetryEnabled: cascadeConfig?.telemetry?.enabled,
    };
    return { models, budget, providersWithKey, endpoints, advanced };
  }

  ipcMain.handle('cascade:getSettings', async () => settingsSnapshot());

  // List the user's REAL available models (Ollama tags, OpenAI-compatible /
  // llama.cpp models, cloud catalog) so the desktop pickers aren't limited to a
  // hardcoded cloud list. Runs a fresh router init over the loaded config — this
  // works independently of the dashboard socket, so it's available even when the
  // live backend isn't. Defensive: any failure returns an empty list and the UI
  // falls back to its built-in options + free-text entry.
  ipcMain.handle('cascade:listModels', async () => {
    try {
      if (!cascadeConfig) return { ok: false, error: 'config-unavailable', models: [] };
      const { CascadeRouter } = loadCore();
      const router = new CascadeRouter();
      // A pinned tier model whose provider is momentarily unreachable makes
      // init() throw — but discovery (which populates the model list) runs first,
      // so swallow that and still return whatever was discovered. Otherwise the
      // Models dropdown can never fill the very models needed to fix the pin.
      try { await router.init(cascadeConfig); } catch { /* keep discovered models */ }
      let models: Array<{ id: string; provider: string; isLocal: boolean; supportsToolUse?: boolean; contextWindow?: number; isVisionCapable?: boolean }> = [];
      try {
        // Pass capability facts through — the picker shows tool/vision/context
        // badges so users can see WHY a model is/isn't suited to agentic work.
        models = (router.getAvailableModels() as Array<{ id: string; provider: string; isLocal?: boolean; supportsToolUse?: boolean; contextWindow?: number; isVisionCapable?: boolean }>)
          .map((m) => ({
            id: m.id, provider: m.provider, isLocal: Boolean(m.isLocal),
            supportsToolUse: m.supportsToolUse, contextWindow: m.contextWindow, isVisionCapable: m.isVisionCapable,
          }));
      } catch { /* selector unavailable */ }
      // If an OpenAI-compatible endpoint is configured but produced no models,
      // probe it directly so the real reason is visible (status / count / error).
      let ocProbe: { status?: number; count?: number; error?: string } | undefined;
      try {
        const ocp = (cascadeConfig.providers ?? []).find((p: { type: string; baseUrl?: string }) => p.type === 'openai-compatible' && p.baseUrl);
        if (ocp?.baseUrl && !models.some((m) => m.provider === 'openai-compatible')) {
          ocProbe = await probeModelsEndpoint(ocp.baseUrl);
        }
      } catch (e) { ocProbe = { error: e instanceof Error ? e.message : String(e) }; }
      return { ok: true, models, ocProbe };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), models: [] };
    }
  });

  ipcMain.handle('cascade:updateSettings', async (_e, data: {
    keys?: Record<string, string | undefined>;
    models?: Record<string, string | undefined>;
    budget?: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number };
    endpoints?: Record<string, string | undefined>;
    advanced?: Record<string, unknown>;
  }) => {
    try {
      if (!cascadeConfig || !configManager) return { ok: false, error: 'backend-unavailable' };
      if (!Array.isArray(cascadeConfig.providers)) cascadeConfig.providers = [];
      if (data.keys) {
        for (const [type, apiKey] of Object.entries(data.keys)) {
          if (!apiKey) continue; // blank means "keep the existing key"
          const existing = cascadeConfig.providers.find((p: { type: string }) => p.type === type);
          if (existing) existing.apiKey = apiKey;
          else cascadeConfig.providers.push({ type, apiKey });
        }
      }
      if (data.endpoints) {
        for (const [type, baseUrl] of Object.entries(data.endpoints)) {
          if (baseUrl === undefined) continue;
          const existing = cascadeConfig.providers.find((pr: { type: string }) => pr.type === type);
          if (existing) existing.baseUrl = baseUrl || undefined;
          else if (baseUrl) cascadeConfig.providers.push({ type, baseUrl });
        }
      }
      if (data.models) {
        cascadeConfig.models = cascadeConfig.models ?? {};
        for (const [tier, val] of Object.entries(data.models)) {
          if (val && val !== 'auto') cascadeConfig.models[tier] = val;
          else delete cascadeConfig.models[tier];
        }
      }
      if (data.budget) {
        cascadeConfig.budget = cascadeConfig.budget ?? {};
        if (typeof data.budget.maxCostPerRun === 'number') cascadeConfig.budget.maxCostPerRunUsd = data.budget.maxCostPerRun;
        if (data.budget.autoBias === 'balanced' || data.budget.autoBias === 'quality' || data.budget.autoBias === 'cost') {
          cascadeConfig.autoBias = data.budget.autoBias;
        }
        if (typeof data.budget.dailyBudgetUsd === 'number' && data.budget.dailyBudgetUsd >= 0) cascadeConfig.budget.dailyBudgetUsd = data.budget.dailyBudgetUsd;
        if (typeof data.budget.sessionBudgetUsd === 'number' && data.budget.sessionBudgetUsd >= 0) cascadeConfig.budget.sessionBudgetUsd = data.budget.sessionBudgetUsd;
        if (typeof data.budget.maxTokensPerRun === 'number' && data.budget.maxTokensPerRun > 0) cascadeConfig.budget.maxTokensPerRun = Math.floor(data.budget.maxTokensPerRun);
        if (typeof data.budget.warnAtPct === 'number' && data.budget.warnAtPct > 0 && data.budget.warnAtPct <= 100) cascadeConfig.budget.warnAtPct = data.budget.warnAtPct;
      }
      // Advanced settings: every field is individually validated against an
      // explicit allowlist — an unknown or malformed key is IGNORED, never
      // written, so the renderer can't inject arbitrary config.
      if (data.advanced && typeof data.advanced === 'object') {
        const a = data.advanced;
        const num = (v: unknown, min: number, max: number): number | undefined => {
          const n = Number(v);
          return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
        };
        if (a['autonomy'] === 'manual' || a['autonomy'] === 'auto') cascadeConfig.autonomy = a['autonomy'];
        if (['never', 'complex', 'all', 'always'].includes(a['planApproval'] as string)) cascadeConfig.planApproval = a['planApproval'];
        { const n = num(a['approvalTimeoutMs'], 0, 86_400_000); if (n !== undefined) cascadeConfig.approvalTimeoutMs = n; }
        if (['auto', 'parallel', 'sequential'].includes(a['t3Execution'] as string)) cascadeConfig.t3Execution = a['t3Execution'];
        { const n = num(a['localConcurrency'], 1, 16); if (n !== undefined) cascadeConfig.localConcurrency = Math.floor(n); }
        { const n = num(a['localInferenceTimeoutMs'], 10_000, 3_600_000); if (n !== undefined) cascadeConfig.localInferenceTimeoutMs = n; }
        { const n = num(a['cloudInferenceTimeoutMs'], 10_000, 3_600_000); if (n !== undefined) cascadeConfig.cloudInferenceTimeoutMs = n; }
        if (typeof a['reflectionEnabled'] === 'boolean') cascadeConfig.reflection = { ...(cascadeConfig.reflection ?? {}), enabled: a['reflectionEnabled'] };
        if (typeof a['cascadeAuto'] === 'boolean') cascadeConfig.cascadeAuto = a['cascadeAuto'];
        if (['auto', 'T1', 'T2', 'T3'].includes(a['forceTier'] as string)) cascadeConfig.routing = { ...(cascadeConfig.routing ?? {}), forceTier: a['forceTier'] };
        if (typeof a['benchmarksLive'] === 'boolean') cascadeConfig.benchmarks = { ...(cascadeConfig.benchmarks ?? {}), live: a['benchmarksLive'] };
        if (['isolate', 'worker', 'auto'].includes(a['dynamicToolSandbox'] as string)) cascadeConfig.tools = { ...(cascadeConfig.tools ?? {}), dynamicToolSandbox: a['dynamicToolSandbox'] };
        if (typeof a['factsExtraction'] === 'boolean') cascadeConfig.knowledge = { ...(cascadeConfig.knowledge ?? {}), factsExtraction: a['factsExtraction'] };
        if (typeof a['enableToolCreation'] === 'boolean') cascadeConfig.enableToolCreation = a['enableToolCreation'];
        if (typeof a['persistDynamicTools'] === 'boolean') cascadeConfig.persistDynamicTools = a['persistDynamicTools'];
        if (typeof a['telemetryEnabled'] === 'boolean') cascadeConfig.telemetry = { ...(cascadeConfig.telemetry ?? {}), enabled: a['telemetryEnabled'] };
      }
      await configManager.save();
      return { ok: true, ...settingsSnapshot() };
    } catch (err) {
      console.warn('[main] updateSettings failed:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Directory picker dialog
  ipcMain.handle('dialog:selectDirectory', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Save/open dialogs for chat/memory export bundles. The renderer fetches or
  // posts the bundle itself (REST /api/export | /api/import); main only owns
  // the native dialogs and the disk read/write.
  ipcMain.handle('dialog:saveJson', async (_e, defaultName: string, content: string) => {
    try {
      const { dialog } = require('electron');
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: defaultName,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      const { writeFile } = require('node:fs/promises');
      await writeFile(result.filePath, content, 'utf-8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('dialog:openJson', async () => {
    try {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      const { readFile } = require('node:fs/promises');
      const content = await readFile(result.filePaths[0], 'utf-8');
      return { ok: true, path: result.filePaths[0], content };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ─── Desktop meta store (persistent JSON in userData) ─────────────────────────
// Replaces the previous electron-store path — that package was never bundled, so
// `require('electron-store')` always threw and fell back to an in-memory Map that
// was wiped on every launch (the cause of onboarding re-appearing every time).
// A plain JSON file has no native deps and persists reliably across launches.
function desktopMetaPath(): string {
  return join(app.getPath('userData'), 'cascade-desktop.json');
}

function loadDesktopMeta(): Record<string, unknown> {
  try {
    const { readFileSync } = require('node:fs');
    return JSON.parse(readFileSync(desktopMetaPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveDesktopMeta(patch: Record<string, unknown>): void {
  try {
    const { writeFileSync, mkdirSync } = require('node:fs');
    const next = { ...loadDesktopMeta(), ...patch };
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(desktopMetaPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[main] saveDesktopMeta failed:', err);
  }
}

// The Cascade workspace for the embedded backend: the directory chosen during
// onboarding, or the user's home directory as a sensible default.
function getWorkspacePath(): string {
  const ws = loadDesktopMeta().workspace;
  return typeof ws === 'string' && ws.trim() ? ws : app.getPath('home');
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow(): void {
  const isMac = process.platform === 'darwin';
  const dark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: dark ? '#1b1c1e' : '#f4f5f7',
    // Frameless-style chrome on every platform: macOS keeps inset traffic
    // lights, Windows/Linux get themed window controls via titleBarOverlay.
    // The app draws its own draggable title strip (see TitleBar.tsx).
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? {}
      : { titleBarOverlay: titleBarOverlayColors() }),
    autoHideMenuBar: true, // no in-window menu bar; shortcuts stay via roles
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // node-pty in preload needs this off
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // Renderer files are served via the registered app:// protocol handler.
    mainWindow.loadURL('app://./index.html');
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Title-bar overlay (Windows/Linux native window controls) colors for the
// current theme, kept in sync when the OS or preference flips.
function titleBarOverlayColors(): Electron.TitleBarOverlay {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? '#202123' : '#ffffff',
    symbolColor: dark ? '#9ba0a8' : '#5b616b',
    height: 38,
  };
}

function updateTitleBarOverlay(): void {
  if (process.platform === 'darwin' || !mainWindow) return;
  try { mainWindow.setTitleBarOverlay(titleBarOverlayColors()); } catch { /* overlay may be unavailable */ }
}

// ─── Application menu ───────────────────────────────────────────────────────
// The window has no visible menu bar (autoHideMenuBar + hidden title bar), but
// a role-based menu is still installed so standard keyboard shortcuts
// (copy/paste/undo, reload, devtools, zoom, quit) keep working.
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray(): void {
  const iconPath = join(__dirname, '../assets/tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Cascade AI');
  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow?.show() },
    { label: 'Hide', click: () => mainWindow?.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => mainWindow?.show());
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { secure: true, standard: true, supportFetchAPI: true } },
]);

// Diagnostic: GET {baseUrl}/models via the core's nodeHttpFetch — the SAME path
// discovery uses (Node http stack, IPv4-preferring, redirect-following, gzip/br
// decoding), so the probe's status/count/error reflect the real request rather
// than a divergent raw http.get that would mis-report redirected/compressed
// endpoints. Surfaces a concrete reason for a discovery failure in the UI.
async function probeModelsEndpoint(baseUrl: string): Promise<{ status?: number; count?: number; error?: string }> {
  try {
    const { nodeHttpFetch } = loadCore();
    const target = baseUrl.replace(/\/+$/, '') + '/models';
    const res = await nodeHttpFetch(target, { headers: { Accept: 'application/json' } });
    let count = -1;
    try {
      const j = (await res.json()) as { data?: unknown[]; models?: unknown[] };
      count = Array.isArray(j.data) ? j.data.length : Array.isArray(j.models) ? j.models.length : -1;
    } catch { /* non-JSON body */ }
    return { status: res.status, count };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

app.whenReady().then(async () => {
  // Serve renderer files via app:// scheme
  protocol.handle('app', (request) => {
    const url = request.url.replace('app://.', '');
    const filePath = join(__dirname, '../dist-renderer', url === '/' ? '/index.html' : url);
    return electronNet.fetch(pathToFileURL(filePath).toString());
  });

  // Apply the saved appearance preference before the first paint so native
  // chrome (title-bar overlay, scrollbars) opens in the right mode.
  applyThemePref(getThemePref());
  // Forward OS light/dark changes to the renderer so 'System' mode tracks live.
  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('theme:changed', {
      preference: getThemePref(),
      shouldUseDark: nativeTheme.shouldUseDarkColors,
    });
    updateTitleBarOverlay();
  });

  buildAppMenu();
  registerIPC();
  await startBackend();
  createWindow();
  createTray();

  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
