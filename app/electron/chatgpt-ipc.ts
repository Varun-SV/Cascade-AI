// ─────────────────────────────────────────────
//  Cascade Desktop — ChatGPT plan, wired to Electron
// ─────────────────────────────────────────────

import { BrowserWindow, ipcMain, shell } from 'electron';
import { createChatGptPlan, type ChatGptPlan, type PlanAuth } from './chatgpt-plan';

export function registerChatGptIpc(opts: {
  loadCore: () => unknown;
  mainWindow: () => BrowserWindow | null;
  /** The live config changed (a sign-in or sign-out): update its provider list. */
  onChanged: () => void | Promise<void>;
}): ChatGptPlan {
  const core = opts.loadCore() as { chatGptAuth: () => PlanAuth };
  const plan = createChatGptPlan({
    auth: core.chatGptAuth(),
    // The user's own browser, where they are already signed in to ChatGPT.
    openExternal: (url) => shell.openExternal(url),
    onChanged: opts.onChanged,
    notify: (channel, payload) => {
      const win = opts.mainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
  ipcMain.handle('chatgpt:status', () => plan.status());
  ipcMain.handle('chatgpt:signIn', (_e, a: unknown) => plan.signIn(a as never));
  ipcMain.handle('chatgpt:cancel', () => plan.cancel());
  ipcMain.handle('chatgpt:signOut', (_e, a: unknown) => plan.signOut(a as never));
  ipcMain.handle('chatgpt:switch', (_e, a: unknown) => plan.switchAccount(a as never));
  ipcMain.handle('chatgpt:dismissWelcome', () => plan.dismissWelcome());
  ipcMain.handle('chatgpt:manageUsage', () => plan.openManageUsage());
  return plan;
}
