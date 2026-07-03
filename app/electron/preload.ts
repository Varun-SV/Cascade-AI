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

  // Settings panel: backend-independent read/write of keys, per-tier models,
  // budget (incl. daily/session caps), and the allowlisted "advanced" knobs.
  getSettings: () => ipcRenderer.invoke('cascade:getSettings') as Promise<{
    models: Record<string, string>;
    budget: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number };
    providersWithKey: string[];
    endpoints: Record<string, string>;
    advanced?: Record<string, unknown>;
  }>,
  updateSettings: (data: {
    keys?: Record<string, string | undefined>;
    models?: Record<string, string | undefined>;
    budget?: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number };
    endpoints?: Record<string, string | undefined>;
    advanced?: Record<string, unknown>;
  }) => ipcRenderer.invoke('cascade:updateSettings', data) as Promise<{
    ok: boolean;
    error?: string;
    models?: Record<string, string>;
    budget?: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number };
    providersWithKey?: string[];
    advanced?: Record<string, unknown>;
  }>,

  // Real available models across configured providers (for the model pickers)
  listModels: () => ipcRenderer.invoke('cascade:listModels') as Promise<{
    ok: boolean;
    error?: string;
    models: Array<{ id: string; provider: string; isLocal: boolean }>;
    ocProbe?: { status?: number; count?: number; error?: string };
  }>,

  // Directory picker dialog
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory') as Promise<string | null>,

  // Export/import bundle dialogs (write/read the JSON on the main process)
  saveJson: (defaultName: string, content: string) =>
    ipcRenderer.invoke('dialog:saveJson', defaultName, content) as Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>,
  openJson: () =>
    ipcRenderer.invoke('dialog:openJson') as Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }>,

  // Appearance: System/Light/Dark preference + resolved dark flag
  theme: {
    get: () => ipcRenderer.invoke('theme:get') as Promise<{ preference: 'system' | 'light' | 'dark' | 'midnight'; shouldUseDark: boolean }>,
    set: (preference: 'system' | 'light' | 'dark' | 'midnight') =>
      ipcRenderer.invoke('theme:set', preference) as Promise<{ preference: 'system' | 'light' | 'dark' | 'midnight'; shouldUseDark: boolean }>,
    onChanged: (cb: (s: { preference: 'system' | 'light' | 'dark' | 'midnight'; shouldUseDark: boolean }) => void) => {
      ipcRenderer.on('theme:changed', (_e, s) => cb(s));
    },
  },

  // Self-update: current version, manual check, install, and live status events
  updates: {
    getVersion: () => ipcRenderer.invoke('update:getVersion') as Promise<string>,
    check: () => ipcRenderer.invoke('update:check') as Promise<{ ok: boolean; error?: string; version?: string; current?: string }>,
    install: () => ipcRenderer.invoke('update:install') as Promise<void>,
    onStatus: (cb: (s: { status: string; version?: string; percent?: number; message?: string }) => void) => {
      ipcRenderer.on('update:status', (_e, s) => cb(s));
    },
  },

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
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content) as Promise<{ ok: boolean }>,
    mkdir: (dirPath: string) => ipcRenderer.invoke('fs:mkdir', dirPath) as Promise<{ ok: boolean }>,
    createFile: (filePath: string) => ipcRenderer.invoke('fs:createFile', filePath) as Promise<{ ok: boolean }>,
    rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath) as Promise<{ ok: boolean }>,
    delete: (targetPath: string) => ipcRenderer.invoke('fs:delete', targetPath) as Promise<{ ok: boolean }>,
    search: (root: string, query: string) => ipcRenderer.invoke('fs:search', root, query) as Promise<Array<{ file: string; line: number; text: string }>>,
  },
});
