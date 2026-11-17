// ─────────────────────────────────────────────
//  Cascade Desktop — the relay device, wired to Electron and the app's window
// ─────────────────────────────────────────────

import { BrowserWindow, app, ipcMain, safeStorage, session } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CloudAuthHandle } from './cloudAuth';
import { createDesktopRelay, type DesktopRelay, type DesktopRelayCore, type StoredDesktopDevice } from './desktop-relay';
import type { ElectronDeps, RunWindow } from './relay-device';

const FILE = 'relay-device.json';

export function registerRelayIpc(opts: {
  loadCore: () => unknown;
  cloudAuth: () => CloudAuthHandle | null;
  mainWindow: () => BrowserWindow | null;
}): DesktopRelay {
  const path = join(app.getPath('userData'), FILE);
  const electron: ElectronDeps = {
    sessionFromPartition: (partition) => session.fromPartition(partition, { cache: false }) as never,
    createWindow: (partition) => {
      const win = new BrowserWindow({
        width: 1200, height: 820, show: true, title: 'Cascade run',
        // No preload and no node: this window shows untrusted pages, driven by a run.
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
      });
      win.setMenuBarVisibility(false);
      return win as unknown as RunWindow;
    },
  };
  const relay = createDesktopRelay({
    core: opts.loadCore() as DesktopRelayCore,
    electron,
    cloud: () => {
      const auth = opts.cloudAuth();
      const client = auth?.relayClient();
      const account = auth?.account();
      return client && account ? { userId: account.userId, client, serverUrl: account.serverUrl } : null;
    },
    file: {
      load: () => {
        try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) as StoredDesktopDevice : null; } catch { return null; }
      },
      save: (d) => writeFileSync(path, JSON.stringify(d, null, 2), { mode: 0o600 }),
      clear: () => { try { rmSync(path); } catch { /* already gone */ } },
    },
    vault: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, 'base64')),
    },
    notify: (channel, payload) => {
      const win = opts.mainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });

  const wrap = async <T>(fn: () => T | Promise<T>): Promise<T | { error: string }> => {
    try { return await fn(); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  };
  ipcMain.handle('relay:status', () => relay.status());
  ipcMain.handle('relay:enable', () => wrap(() => relay.enable()));
  ipcMain.handle('relay:disable', () => wrap(() => relay.disable()));
  ipcMain.handle('relay:forget', () => wrap(() => relay.forget()));
  ipcMain.handle('relay:take-over', () => relay.takeOver());
  ipcMain.handle('relay:hand-back', () => relay.handBack());
  ipcMain.handle('relay:answer', (_e, id: unknown, sites: unknown) => {
    if (typeof id !== 'number' || typeof sites !== 'string' || sites.length > 4000) return { error: 'That answer could not be read.' };
    return relay.answer(id, sites);
  });
  app.on('before-quit', () => relay.shutdown());
  // Signing out, or into another account, stops serving the one it was paired for.
  opts.cloudAuth()?.onAccountChange(() => relay.accountChanged());
  relay.resume();
  return relay;
}
