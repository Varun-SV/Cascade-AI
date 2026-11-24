// ─────────────────────────────────────────────
//  Cascade Desktop — the workspace service, wired to Electron and the app's window
// ─────────────────────────────────────────────

import { BrowserWindow, app, dialog, ipcMain, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudAuthHandle } from './cloudAuth';
import type { StoredDesktopDevice } from './desktop-relay';
import { createDesktopWorkspace, type DesktopWorkspace, type DesktopWorkspaceCore, type WorkspaceSettings } from './desktop-workspace';

const SETTINGS_FILE = 'workspace-device.json';
/** The browser relay's pairing: this reads it, and never writes it. */
const DEVICE_FILE = 'relay-device.json';

export function registerWorkspaceIpc(opts: {
  loadCore: () => unknown;
  cloudAuth: () => CloudAuthHandle | null;
  mainWindow: () => BrowserWindow | null;
  /** Opens the main window when there is none (macOS keeps the app running with none). */
  ensureWindow?: () => void;
}): DesktopWorkspace {
  const settingsPath = join(app.getPath('userData'), SETTINGS_FILE);
  const devicePath = join(app.getPath('userData'), DEVICE_FILE);
  const ws = createDesktopWorkspace({
    core: opts.loadCore() as DesktopWorkspaceCore,
    cloud: () => {
      const account = opts.cloudAuth()?.account();
      return account ? { userId: account.userId, serverUrl: account.serverUrl } : null;
    },
    device: {
      load: () => {
        try { return existsSync(devicePath) ? JSON.parse(readFileSync(devicePath, 'utf-8')) as StoredDesktopDevice : null; } catch { return null; }
      },
    },
    vault: { decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, 'base64')) },
    settings: {
      load: () => {
        try { return existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf-8')) as WorkspaceSettings : { enabled: false }; } catch { return { enabled: false }; }
      },
      save: (s) => writeFileSync(settingsPath, JSON.stringify(s, null, 2), { mode: 0o600 }),
    },
    notify: (channel, payload) => {
      const asking = channel === 'workspace:ask' || channel === 'workspace:call-ask';
      // A question with no window to show it in opens one; the window's renderer then
      // reads what is open with workspace:pending, so nothing asked before it loaded is lost.
      if (asking && !opts.mainWindow()) opts.ensureWindow?.();
      const win = opts.mainWindow();
      if (win && !win.isDestroyed()) {
        if (asking) { if (win.isMinimized()) win.restore(); win.show(); }
        win.webContents.send(channel, payload);
      }
    },
  });

  const wrap = async <T>(fn: () => T | Promise<T>): Promise<T | { error: string }> => {
    try { return await fn(); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  };
  ipcMain.handle('workspace:status', () => ws.status());
  ipcMain.handle('workspace:pending', () => ws.pending());
  ipcMain.handle('workspace:enable', () => wrap(() => ws.enable()));
  ipcMain.handle('workspace:disable', () => wrap(() => ws.disable()));
  ipcMain.handle('workspace:clear-defaults', () => wrap(() => ws.clearDefaults()));
  ipcMain.handle('workspace:stop', () => ws.stop());
  ipcMain.handle('workspace:undo', () => wrap(() => ws.undoLastRun()));
  ipcMain.handle('workspace:dismiss-last', () => { ws.dismissLastRun(); return { ok: true }; });
  // The picker: the folder is shown in this window only; it is checked again when answered.
  ipcMain.handle('workspace:pick-folder', async () => {
    const win = opts.mainWindow();
    const r = await (win ? dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : dialog.showOpenDialog({ properties: ['openDirectory'] }));
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    return ws.checkFolder(r.filePaths[0]);
  });
  ipcMain.handle('workspace:answer', (_e, id: unknown, a: unknown) => {
    if (typeof id !== 'number') return { error: 'That answer could not be read.' };
    if (a === null) return ws.answer(id, null);
    if (typeof a !== 'object') return { error: 'That answer could not be read.' };
    return ws.answer(id, a as Record<string, unknown>);
  });
  ipcMain.handle('workspace:call-answer', (_e, id: unknown, answer: unknown) => {
    if (typeof id !== 'number' || (answer !== 'allow' && answer !== 'deny' && answer !== 'all')) return { error: 'That answer could not be read.' };
    return ws.answerCall(id, answer);
  });
  app.on('before-quit', () => ws.shutdown());
  opts.cloudAuth()?.onAccountChange(() => ws.accountChanged());
  ws.resume();
  return ws;
}
