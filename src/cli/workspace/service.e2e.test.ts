// The CLI service driving the real SDK: device, executor, registry and checkpoints, in a
// temp folder, against an in-process hub. A fake terminal answers the questions.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  type Identity, createIdentity, createMemoryNonceStore, generateStoredKey, publicKeyFromText, publicKeyToText,
} from '../../browser/relay/capability.js';
import { authenticateControl, createRelayHub } from '../../browser/relay/hub.js';
import { relayEndpoints } from '../../browser/relay/serve.js';
import { WORKSPACE_FAMILY } from '../../workspace/protocol.js';
import { openRemoteWorkspace } from '../../workspace/remote.js';
import { realCore } from '../commands/workspace.js';
import { createCliWorkspace, type CliWorkspaceCore, type WorkspaceUi } from './service.js';

const closers: Array<() => void | Promise<void>> = [];
const savedGlobal = process.env['CASCADE_GLOBAL_DIR'];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  if (savedGlobal === undefined) delete process.env['CASCADE_GLOBAL_DIR']; else process.env['CASCADE_GLOBAL_DIR'] = savedGlobal;
});

describe('the CLI service with the real SDK', () => {
  it('asks, serves a folder, answers a file_read, lands a file_write, then stops and undoes', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-cli-ws-')));
    closers.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    process.env['CASCADE_GLOBAL_DIR'] = path.join(tmp, 'global');
    const dir = path.join(tmp, 'project');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello from the cli\n');
    fs.mkdirSync(path.join(dir, 'private'));
    fs.writeFileSync(path.join(dir, 'private', 'customers.csv'), 'name,email\n');
    fs.writeFileSync(path.join(dir, '.cascadeignore'), 'private/\n');

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

    // The real modules, with the endpoints pointed at the in-process hub's two paths.
    const core: CliWorkspaceCore = { ...realCore, relayEndpoints: (url) => relayEndpoints(url, { controlPath: '/control', runPath: '/run' }) };

    const asked: string[] = [];
    const lines: string[] = [];
    const ended: Array<{ canUndo: boolean; changed: number | null }> = [];
    const ui: WorkspaceUi = {
      // The person at the terminal: edit tools, the device's name.
      askConsent: async (q) => { asked.push(JSON.stringify(q)); return { tools: ['file_read', 'file_write', 'file_list'], labelMode: 'device' }; },
      askCall: async () => 'deny',
      served: () => {},
      activity: (l) => { lines.push(l); },
      runEnded: (s) => { ended.push(s); },
      notice: () => {},
    };
    const ws = createCliWorkspace({
      core, folder: dir, ui,
      device: { serverUrl: base, deviceId: 'dev-1', name: 'Test PC', privateKeyPem: key.privateKeyPem, serverId: server.id, serverKey: publicKeyToText(server.publicKey) },
    });
    closers.push(() => ws.shutdown());

    const loop = ws.start();
    await vi.waitFor(() => expect(hub.deviceOnline('user-1', 'dev-1')).toBe(true), { timeout: 8000 });
    expect(ws.status().connected).toBe(true);

    const lease = await hub.requestBrowser({ userId: 'user-1', deviceId: 'dev-1', runId: 'run-1' });
    const remote = await openRemoteWorkspace(new WebSocket(`${base.replace('http', 'ws')}/agent/${lease.token}`));
    closers.push(() => remote.close());
    expect(remote.label).toBe('Workspace on Test PC');
    expect(remote.tools.map((t) => t.name).sort()).toEqual(['file_list', 'file_read', 'file_write']);
    expect(ws.status().serving).toMatchObject({ label: remote.label });
    const call = (name: string, input: Record<string, unknown>) =>
      remote.tools.find((t) => t.name === name)!.execute(input, { tierId: 't3', sessionId: 's', requireApproval: false });

    // A file_read round-trips.
    expect(await call('file_read', { path: 'README.md' })).toContain('hello from the cli');
    // What the folder's .cascadeignore lists, no run reads or writes.
    await expect(call('file_read', { path: 'private/customers.csv' })).rejects.toThrow();
    await expect(call('file_write', { path: 'private/customers.csv', content: 'x' })).rejects.toThrow();
    expect(fs.readFileSync(path.join(dir, 'private', 'customers.csv'), 'utf8')).toBe('name,email\n');
    // A file_write lands.
    await call('file_write', { path: 'new.txt', content: 'made by the run\n' });
    expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('made by the run\n');

    // The run is never told where the folder is, and the live line names the tool and a relative path.
    expect(asked.join()).not.toContain(dir);
    expect(JSON.stringify(remote.label)).not.toContain(dir);
    expect(lines).toContain('file_read README.md');
    expect(lines).toContain('file_write new.txt');
    expect(lines.join('\n')).not.toContain('made by the run');
    expect(lines.join('\n')).not.toContain(dir);

    // Stop ends the run's access at once, and then the run's changes can be undone.
    expect(ws.stopRun()).toEqual({ ok: true });
    await vi.waitFor(() => expect(ws.status().serving).toBeNull(), { timeout: 8000 });
    await vi.waitFor(() => expect(ws.status().lastRun).toMatchObject({ canUndo: true }), { timeout: 8000 });
    expect(ended.at(-1)).toMatchObject({ canUndo: true });
    // Stopped on this machine: the run's tool calls no longer land.
    await expect(call('file_write', { path: 'late.txt', content: 'x' })).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'late.txt'))).toBe(false);

    // Undo removes the file and leaves the rest.
    expect(await ws.undoLastRun()).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('hello from the cli\n');

    ws.stop();
    await expect(loop).resolves.toBe('stopped');
  }, 60_000);
});
