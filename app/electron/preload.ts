import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cascade', {
  // Synchronous platform string for first-paint layout (e.g. title-bar insets)
  platform: process.platform,

  // App metadata: backend port, auth token, platform
  getMeta: () => ipcRenderer.invoke('cascade:meta') as Promise<{
    port: number;
    token: string;
    platform: string;
    version: string;
  }>,

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
