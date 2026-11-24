// The desktop service driving the real SDK: device, executor, registry and checkpoints, in a
// temp folder, against an in-process hub. A fake window answers the questions.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  type Identity, createIdentity, createMemoryNonceStore, generateStoredKey, publicKeyFromText, publicKeyToText,
} from '../../src/browser/relay/capability.js';
import { authenticateControl, createRelayHub } from '../../src/browser/relay/hub.js';
import { relayEndpoints } from '../../src/browser/relay/serve.js';
import { Checkpoints } from '../../src/core/checkpoints.js';
import { PrivacyPaths } from '../../src/core/privacy/paths.js';
import { ConfigManager } from '../../src/config/index.js';
import { STATE, statePath } from '../../src/config/project-state.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { WORKSPACE_FAMILY } from '../../src/workspace/protocol.js';
import { createWorkspaceExecutor } from '../../src/workspace/executor.js';
import { serveWorkspaceDevice } from '../../src/workspace/device.js';
import { openRemoteWorkspace } from '../../src/workspace/remote.js';
import { createDesktopWorkspace, type DesktopWorkspaceCore } from './desktop-workspace.js';

const closers: Array<() => void | Promise<void>> = [];
const savedGlobal = process.env['CASCADE_GLOBAL_DIR'];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  if (savedGlobal === undefined) delete process.env['CASCADE_GLOBAL_DIR']; else process.env['CASCADE_GLOBAL_DIR'] = savedGlobal;
});

describe('the desktop service with the real SDK', () => {
  it('asks the user, serves a folder, answers a file_read, then undoes a write', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-desk-'));
    closers.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    process.env['CASCADE_GLOBAL_DIR'] = path.join(tmp, 'global');
    const dir = path.join(tmp, 'project');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello from the desktop\n');

    // The server side: one hub, the device's public key registered under its account.
    const server = createIdentity('server');
    const key = generateStoredKey();
    const devicePub = publicKeyFromText(key.publicKey)!;
    const hub = createRelayHub({
      server, store: createMemoryNonceStore(Date.now), deviceKey: (id) => (id === 'dev-1' ? devicePub : null), family: WORKSPACE_FAMILY,
    });
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws, req) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (pathname === '/control') {
        void authenticateControl(ws, {
          serverId: server.id, timeoutMs: 1000,
          device: (id) => (id === 'dev-1' ? { userId: 'user-1', key: devicePub } as { userId: string; key: Identity['publicKey'] } : null),
        }).then((who) => { if (who) hub.attachDevice(who, ws); });
      } else if (pathname === '/run') hub.attachRun(ws);
      else if (pathname.startsWith('/agent/')) hub.attachAgent(pathname.slice('/agent/'.length), ws);
      else ws.close();
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    closers.push(() => { hub.close(); httpServer.closeAllConnections(); httpServer.close(); });

    const core = {
      // The real thing, pointed at the in-process hub's two paths.
      relayEndpoints: (url: string) => relayEndpoints(url, { controlPath: '/control', runPath: '/run' }),
      serveWorkspaceDevice, createWorkspaceExecutor, ToolRegistry, ConfigManager, PrivacyPaths, Checkpoints, statePath, STATE,
    } as unknown as DesktopWorkspaceCore;

    let settings = { enabled: false } as { enabled: boolean };
    const notes: Array<[string, any]> = [];
    // eslint-disable-next-line prefer-const
    let ws!: ReturnType<typeof createDesktopWorkspace>;
    ws = createDesktopWorkspace({
      core,
      cloud: () => ({ userId: 'acct', serverUrl: base }),
      device: {
        load: () => ({
          serverUrl: base, accountId: 'acct', deviceId: 'dev-1', name: 'Test PC (desktop app)', serverId: server.id, serverKey: publicKeyToText(server.publicKey),
          controlPath: '/x', runPath: '/y', privateKeyEnc: `enc:${key.privateKeyPem}`, enabled: false,
        }),
      },
      vault: { decrypt: (b) => b.replace(/^enc:/, '') },
      settings: { load: () => settings, save: (s) => { settings = s as typeof settings; } },
      notify: (channel, payload) => {
        notes.push([channel, payload]);
        // The user, in the window: this folder, edit tools.
        if (channel === 'workspace:ask') queueMicrotask(() => ws.answer((payload as { id: number }).id, { folder: dir, tools: ['file_read', 'file_write', 'file_list'], labelMode: 'device' }));
      },
    });
    closers.push(() => ws.shutdown());

    ws.enable();
    await vi.waitFor(() => expect(hub.deviceOnline('user-1', 'dev-1')).toBe(true), { timeout: 8000 });
    expect(ws.status().connected).toBe(true);

    const lease = await hub.requestBrowser({ userId: 'user-1', deviceId: 'dev-1', runId: 'run-1' });
    const remote = await openRemoteWorkspace(new (await import('ws')).WebSocket(`${base.replace('http', 'ws')}/agent/${lease.token}`));
    closers.push(() => remote.close());
    expect(remote.label).toBe('Workspace on Test PC (desktop app)');
    expect(remote.tools.map((t) => t.name).sort()).toEqual(['file_list', 'file_read', 'file_write']);
    expect(ws.status().serving).toMatchObject({ label: remote.label });
    const call = (name: string, input: Record<string, unknown>) =>
      remote.tools.find((t) => t.name === name)!.execute(input, { tierId: 't3', sessionId: 's', requireApproval: false });

    expect(await call('file_read', { path: 'README.md' })).toContain('hello from the desktop');
    await call('file_write', { path: 'new.txt', content: 'made by the run\n' });
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(true);
    // The run is never told where the folder is.
    expect(JSON.stringify(notes.filter((n) => n[0] === 'workspace:status').map((n) => n[1].serving))).not.toContain(dir);

    // Stop ends the run's access at once, and then the run's changes can be undone.
    expect(ws.stop()).toEqual({ ok: true });
    await vi.waitFor(() => expect(ws.status().serving).toBeNull(), { timeout: 8000 });
    await vi.waitFor(() => expect(ws.status().lastRun).toMatchObject({ canUndo: true }), { timeout: 8000 });
    expect(await ws.undoLastRun()).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('hello from the desktop\n');
  }, 60_000);
});
