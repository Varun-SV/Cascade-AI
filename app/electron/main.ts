import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  nativeImage,
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
async function startBackend(): Promise<void> {
  backendPort = await findFreePort();
  // Generate a random session token for auto-login
  authToken = require('node:crypto').randomBytes(24).toString('hex');

  try {
    // Import the cascade-ai core package (built CommonJS output lives at ../dist)
    const corePath = isDev
      ? join(__dirname, '../../dist/index.cjs')
      : join(process.resourcesPath, 'cascade-core/index.cjs');
    const { DashboardServer, ConfigManager } = require(corePath);

    // Load the shared Cascade workspace config (same .cascade/config.json the
    // `cascade` CLI uses) so API keys, per-tier models, and budget settings are
    // unified across the desktop app and the CLI.
    const workspace = getWorkspacePath();
    configManager = new ConfigManager(workspace);
    await configManager.load();
    cascadeConfig = configManager.getConfig();

    // Embed the dashboard on a private loopback port with auth disabled — this
    // is a single-user local backend reachable only from 127.0.0.1 on an
    // ephemeral port, so the JWT handshake (which the renderer can't mint) is
    // unnecessary. The CORS '*' that auth-off implies is harmless on loopback.
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
    console.warn('[main] Backend start failed:', err);
    // Reset so the renderer's `if (!backendPort) return` guard skips Socket.IO
    // entirely instead of connecting to an unused port and showing "Reconnecting".
    backendPort = 0;
    authToken = '';
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
function registerIPC(): void {
  ipcMain.handle('cascade:meta', () => ({
    port: backendPort,
    token: authToken,
    platform: process.platform,
    version: app.getVersion(),
  }));

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

  ipcMain.handle('cascade:setConfig', async (_e, cfg: { provider: string; apiKey: string; workspace: string }) => {
    try {
      saveDesktopMeta({ provider: cfg.provider, workspace: cfg.workspace, onboarding_done: true });
      // Write the key into the live Cascade config (same object the running
      // DashboardServer holds), then persist it — the next chat run picks it up
      // immediately with no backend restart.
      const { type, baseUrl } = mapProvider(cfg.provider);
      if (type && cfg.apiKey && cascadeConfig && configManager) {
        const existing = cascadeConfig.providers.find((p: { type: string }) => p.type === type);
        if (existing) {
          existing.apiKey = cfg.apiKey;
          if (baseUrl && !existing.baseUrl) existing.baseUrl = baseUrl;
        } else {
          cascadeConfig.providers.push({ type, apiKey: cfg.apiKey, ...(baseUrl ? { baseUrl } : {}) });
        }
        await configManager.save();
      }
    } catch (err) {
      console.warn('[main] setConfig failed:', err);
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
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#06080f',
    // Frameless-style chrome on every platform: macOS keeps inset traffic
    // lights, Windows/Linux get themed window controls via titleBarOverlay.
    // The app draws its own draggable title strip (see TitleBar.tsx).
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? {}
      : {
          titleBarOverlay: {
            color: '#0f1117',
            symbolColor: '#6e738d',
            height: 38,
          },
        }),
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

app.whenReady().then(async () => {
  // Serve renderer files via app:// scheme
  protocol.handle('app', (request) => {
    const url = request.url.replace('app://.', '');
    const filePath = join(__dirname, '../dist-renderer', url === '/' ? '/index.html' : url);
    return electronNet.fetch(pathToFileURL(filePath).toString());
  });

  buildAppMenu();
  registerIPC();
  await startBackend();
  createWindow();
  createTray();

  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdatesAndNotify();
    autoUpdater.on('update-available', () => {
      new Notification({ title: 'Cascade AI — Update Available', body: 'Downloading in the background.' }).show();
    });
    autoUpdater.on('update-downloaded', () => {
      new Notification({ title: 'Cascade AI — Restart to Update', body: 'A new version is ready. Relaunch to install.' }).show();
    });
  } catch { /* no-op in dev or when electron-updater is unavailable */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
