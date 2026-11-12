// The device client without a browser: what it does with the bytes on its run connection.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createIdentity, issueGrant } from './capability.js';
import { type LeasedBrowser, connectDeviceClient } from './device.js';
import { authenticateControl } from './hub.js';
import type { RequestEnforcer } from './request-enforcer.js';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await Promise.resolve(c()).catch(() => {}); });

const enforcer: RequestEnforcer = {
  decisions: [], closedPages: [], children: [], dismissedDialogs: [],
  checkTabBeforeLease: async () => ({ ok: true as const }),
  clearForeignHistory: async () => true,
  onForeignDocument: () => {},
  onPolicyLost: () => {},
  endPageActivity: async () => true,
  close: () => {},
};

/** One unmasked text frame, as a server writes it. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error('keep test frames short');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/** A tab that answers every command. */
async function fakeTab(): Promise<string> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const { id } = JSON.parse(String(raw)) as { id: number };
    ws.send(JSON.stringify({ id, result: {} }));
  }));
  await new Promise((r) => wss.once('listening', r));
  closers.push(() => wss.close());
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`;
}

/**
 * A server that accepts the claim and writes its reply and the run's first commands in ONE
 * socket write, which is what a proxy coalescing two sends looks like to the device.
 */
async function coalescingServer(firstCommands: string[]) {
  const server = createIdentity('server');
  const device = createIdentity('device-a');
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const fromDevice: string[] = [];
  wss.on('connection', (ws: WebSocket, req) => {
    if (req.url === '/control') {
      void authenticateControl(ws, { serverId: server.id, device: (id) => (id === device.id ? { userId: 'user-a', key: device.publicKey } : null) }).then((who) => {
        if (!who) return;
        const grant = issueGrant(server, { userId: 'user-a', deviceId: device.id, runId: 'run-1', ttlMs: 600_000, now: Date.now() });
        ws.send(JSON.stringify({ v: 1, t: 'offer', grant }));
      });
      return;
    }
    let claimed = false;
    ws.on('message', (raw) => {
      if (claimed) { fromDevice.push(String(raw)); return; }
      claimed = true;
      const socket = (ws as unknown as { _socket: { write(b: Buffer): void } })._socket;
      socket.write(Buffer.concat([textFrame(JSON.stringify({ v: 1, t: 'claimed' })), ...firstCommands.map(textFrame)]));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  closers.push(() => { httpServer.closeAllConnections(); httpServer.close(); });
  return { server, device, base, fromDevice };
}

describe("the run's first commands, arriving in the same read as the claim's reply (Codex on d144a3d)", () => {
  it('are not lost: each is answered, in order', async () => {
    const commands = [1, 2, 3].map((id) => JSON.stringify({ id, method: 'Browser.getVersion' }));
    const s = await coalescingServer(commands);
    const tabWs = await fakeTab();
    const browser: LeasedBrowser = { tabWs, tabTargetId: 'tab-1', enforcer, pageEnd: 'close', onEgressDown: () => {}, close: async () => {} };
    const client = connectDeviceClient({
      controlUrl: `${s.base}/control`, runUrl: `${s.base}/run`,
      device: s.device, serverId: s.server.id, serverKey: s.server.publicKey,
      askUser: async () => ({ allowedOrigins: ['https://a.test'], privateOrigins: [] }),
      startBrowser: async () => browser,
    });
    closers.push(() => client.close());
    const deadline = Date.now() + 4000;
    while (s.fromDevice.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const ids = s.fromDevice.map((f) => (JSON.parse(f) as { id?: number; result?: { product?: string } })).filter((m) => m.result?.product).map((m) => m.id);
    expect(ids).toEqual([1, 2, 3]);
  });
});
