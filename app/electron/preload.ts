import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cascade', {
  // Synchronous platform string for first-paint layout (e.g. title-bar insets)
  platform: process.platform,

  // App metadata: backend port, auth token, platform, backend health
  getMeta: () => ipcRenderer.invoke('cascade:meta') as Promise<{
    port: number;
    token: string;
    platform: string;
    version: string;
    error: string | null;
  }>,

  // Retry the embedded backend; resolves with the fresh port/token/error.
  restartBackend: () => ipcRenderer.invoke('cascade:restartBackend') as Promise<{
    port: number;
    token: string;
    error: string | null;
  }>,

  // Live backend health pushes (after an on-demand restart).
  onBackendStatus: (cb: (s: { port: number; token: string; error: string | null }) => void) => {
    ipcRenderer.on('cascade:backendStatus', (_e, s) => cb(s));
  },

  // Config: read/write provider key + workspace for onboarding
  getConfig: () => ipcRenderer.invoke('cascade:getConfig') as Promise<{
    provider: string;
    apiKey: string;
    workspace: string;
    onboardingDone: boolean;
  }>,
  setConfig: (cfg: { provider: string; apiKey: string; workspace: string; baseUrl?: string }) =>
    ipcRenderer.invoke('cascade:setConfig', cfg) as Promise<void>,

  // Settings panel: backend-independent read/write of keys, per-tier models, budget
  getSettings: () => ipcRenderer.invoke('cascade:getSettings') as Promise<{
    models: Record<string, string>;
    budget: { maxCostPerRun?: number; autoBias?: string };
    providersWithKey: string[];
  }>,
  updateSettings: (data: {
    keys?: Record<string, string | undefined>;
    models?: Record<string, string | undefined>;
    budget?: { maxCostPerRun?: number; autoBias?: string };
  }) => ipcRenderer.invoke('cascade:updateSettings', data) as Promise<{
    ok: boolean;
    error?: string;
    models?: Record<string, string>;
    budget?: { maxCostPerRun?: number; autoBias?: string };
    providersWithKey?: string[];
  }>,

  // Directory picker dialog
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory') as Promise<string | null>,

  // PTY (terminal)
  pty: {
    spawn: (cwd: string) => ipcRenderer.invoke('pty:spawn', cwd),
    write: (data: string) => ipcRenderer.send('pty:write', data),
    resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', cols, rows),
    kill: () => ipcRenderer.send('pty:kill'),
    onData: (cb: (data: string) => void) => {
      ipcRenderer.on('pty:data', (_e, data) => cb(data));
    },
    onExit: (cb: () => void) => {
      ipcRenderer.on('pty:exit', () => cb());
    },
  },

  // File system (safe subset)
  fs: {
    readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath) as Promise<
      Array<{ name: string; fullPath: string; isDirectory: boolean }>
    >,
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath) as Promise<string>,
  },
});
