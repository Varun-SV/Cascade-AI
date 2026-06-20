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
    const { DashboardServer } = require(corePath);

    const server = new DashboardServer({
      port: backendPort,
      token: authToken,
    });
    await server.start();
    console.log(`[main] Cascade backend started on port ${backendPort}`);

    // Forward escalation events to desktop notifications
    server.on?.('permission:user-required', (payload: Record<string, unknown>) => {
      if (mainWindow?.isFocused()) return;
      new Notification({
        title: 'Cascade AI — Approval Required',
        body: `Tool: ${payload.tool ?? 'unknown'} — click to review`,
      }).show();
    });

    server.on?.('session:complete', (payload: Record<string, unknown>) => {
      if (mainWindow?.isFocused()) return;
      new Notification({
        title: 'Cascade AI — Task Complete',
        body: String(payload.title ?? 'Session finished'),
      }).show();
    });
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

  // Config — read/write provider API key + workspace for onboarding
  ipcMain.handle('cascade:getConfig', async () => {
    try {
      const store = getConfigStore();
      const provider = store.get('provider', '') as string;
      const workspace = store.get('workspace', '') as string;
      const onboardingDone = store.get('onboarding_done', false) as boolean;
      let apiKey = '';
      try {
        const keytar = require('keytar');
        apiKey = (await keytar.getPassword('cascade-ai', provider)) ?? '';
      } catch { /* keytar unavailable */ }
      return { provider, apiKey, workspace, onboardingDone };
    } catch {
      return { provider: '', apiKey: '', workspace: '', onboardingDone: false };
    }
  });

  ipcMain.handle('cascade:setConfig', async (_e, cfg: { provider: string; apiKey: string; workspace: string }) => {
    try {
      const store = getConfigStore();
      store.set('provider', cfg.provider);
      store.set('workspace', cfg.workspace);
      store.set('onboarding_done', true);
      if (cfg.apiKey && cfg.provider) {
        try {
          const keytar = require('keytar');
          await keytar.setPassword('cascade-ai', cfg.provider, cfg.apiKey);
        } catch { /* keytar unavailable */ }
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

// ─── Config store (electron-store or simple JSON fallback) ────────────────────
function getConfigStore() {
  try {
    const ElectronStore = require('electron-store');
    return new ElectronStore({ name: 'cascade-config' });
  } catch {
    // Minimal in-memory fallback for dev
    const m = new Map<string, unknown>();
    return { get: (k: string, d: unknown) => m.get(k) ?? d, set: (k: string, v: unknown) => m.set(k, v) };
  }
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
