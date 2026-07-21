import { contextBridge, ipcRenderer } from 'electron';

/** A message on a cloud conversation's active path (with branching data). */
interface CloudMsg {
  id?: string;
  parentId?: string | null;
  role: string;
  content: string;
  tier?: string | null;
  model?: string | null;
  costUsd?: number | null;
  siblingIds?: string[];
}

/** A locally-executed turn to persist into the shared cloud conversation. */
interface CloudTurn {
  userContent: string;
  assistant: { content: string; tier?: string | null; model?: string | null; costUsd?: number | null };
  editOfMessageId?: string;
  regenerateFromUserMessageId?: string;
}

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

  // Rebind the running backend's task-execution workspace to a folder opened
  // in Code view — persists to desktop meta and applies immediately, no restart.
  setWorkspace: (dir: string) => ipcRenderer.invoke('cascade:setWorkspace', dir) as Promise<{ ok: boolean }>,

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
    webSearch?: { searxngUrl?: string; hasBraveKey: boolean; hasTavilyKey: boolean };
    advanced?: Record<string, unknown>;
  }>,
  updateSettings: (data: {
    keys?: Record<string, string | undefined>;
    models?: Record<string, string | undefined>;
    budget?: { maxCostPerRun?: number; autoBias?: string; dailyBudgetUsd?: number; sessionBudgetUsd?: number; maxTokensPerRun?: number; warnAtPct?: number };
    endpoints?: Record<string, string | undefined>;
    webSearch?: { searxngUrl?: string; braveApiKey?: string; tavilyApiKey?: string };
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

  // Cascade Cloud account: optional sign-in (loopback OAuth, tokens encrypted at
  // rest in the main process) + browsing the chats you started on the web.
  cloud: {
    status: () => ipcRenderer.invoke('cloud:status') as Promise<{
      signedIn: boolean;
      user: { id: string; email: string | null; name: string | null; plan?: string } | null;
      serverUrl: string;
      storage: 'keychain' | 'encrypted-file';
    }>,
    login: (provider: 'google' | 'github') => ipcRenderer.invoke('cloud:login', provider) as Promise<{
      ok: boolean;
      error?: string;
      signedIn?: boolean;
      user?: { id: string; email: string | null; name: string | null; plan?: string } | null;
      storage?: 'keychain' | 'encrypted-file';
    }>,
    cancelLogin: () => ipcRenderer.invoke('cloud:cancelLogin') as Promise<{ ok: boolean }>,
    logout: () => ipcRenderer.invoke('cloud:logout') as Promise<{ ok: boolean; signedIn?: boolean }>,
    sessions: () => ipcRenderer.invoke('cloud:sessions') as Promise<{
      ok: boolean;
      error?: string;
      conversations: Array<{ id: string; title: string; updatedAt?: number }>;
    }>,
    messages: (id: string) => ipcRenderer.invoke('cloud:messages', id) as Promise<{
      ok: boolean;
      error?: string;
      messages: CloudMsg[];
    }>,
    // Cloud-backed sessions: write a locally-executed turn + branch operations,
    // so desktop chats join the shared cloud session tree (web + CLI too).
    createConversation: (title?: string) => ipcRenderer.invoke('cloud:createConversation', title) as Promise<{
      ok: boolean; error?: string; conversation?: { id: string; title: string | null };
    }>,
    appendTurn: (id: string, turn: CloudTurn) => ipcRenderer.invoke('cloud:appendTurn', id, turn) as Promise<{
      ok: boolean; error?: string; messages: CloudMsg[];
    }>,
    selectBranch: (id: string, messageId: string) => ipcRenderer.invoke('cloud:selectBranch', id, messageId) as Promise<{
      ok: boolean; error?: string; messages: CloudMsg[];
    }>,
    deleteMessage: (id: string, messageId: string) => ipcRenderer.invoke('cloud:deleteMessage', id, messageId) as Promise<{
      ok: boolean; error?: string; messages: CloudMsg[];
    }>,
    renameConversation: (id: string, title: string) => ipcRenderer.invoke('cloud:renameConversation', id, title) as Promise<{ ok: boolean; error?: string }>,
    deleteConversation: (id: string) => ipcRenderer.invoke('cloud:deleteConversation', id) as Promise<{ ok: boolean; error?: string }>,
    // Key sync (E2E-encrypted): passphrase stays in the main process; only
    // ciphertext leaves the machine.
    syncPush: (passphrase: string) => ipcRenderer.invoke('cloud:syncPush', passphrase) as Promise<{ ok: boolean; error?: string; version?: number }>,
    syncPull: (passphrase: string) => ipcRenderer.invoke('cloud:syncPull', passphrase) as Promise<{ ok: boolean; error?: string; empty?: boolean; applied?: boolean }>,
  },

  // MCP servers — connect a remote server via OAuth (loopback in the main
  // process), list, and remove. Tokens are stored locally and auto-refreshed.
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list') as Promise<{ servers: Array<{ name: string; target: string; kind: 'oauth' | 'token' | 'local' | 'open' }> }>,
    connectOAuth: (url: string, name?: string) => ipcRenderer.invoke('mcp:connectOAuth', { url, name }) as Promise<{ ok: boolean; error?: string; name?: string }>,
    remove: (name: string) => ipcRenderer.invoke('mcp:remove', name) as Promise<{ ok: boolean }>,
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
