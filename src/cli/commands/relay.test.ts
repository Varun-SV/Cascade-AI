import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  loadRelayDevice, pairDevice, parseSites, relayDevicePath, relayEndpoints, saveRelayDevice, serveDevice,
  type StoredRelayDevice,
} from './relay.js';
import { createIdentity, createMemoryNonceStore, generateStoredKey, publicKeyFromText, publicKeyToText } from '../../browser/relay/capability.js';
import { authenticateControl, createRelayHub } from '../../browser/relay/hub.js';
import type { DeviceClient, DeviceClientOptions } from '../../browser/relay/device.js';
import type { CloudClient } from '../../cloud/client.js';

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-relay-cli-')); closers.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

describe('the sites the user types are what a run may use', () => {
  it('empty is a no', () => {
    expect(parseSites('')).toBeNull();
    expect(parseSites('   ')).toBeNull();
  });

  it('a bare name is https; a path is dropped; repeats are one', () => {
    expect(parseSites('example.com https://docs.example.com/guide?x=1, example.com')).toEqual({
      consent: { allowedOrigins: ['https://example.com', 'https://docs.example.com'], privateOrigins: [] },
    });
  });

  it('a private address is allowed only as typed, and marked private', () => {
    expect(parseSites('http://localhost:3000 192.168.1.5 example.com')).toEqual({
      consent: { allowedOrigins: ['https://example.com'], privateOrigins: ['http://localhost:3000', 'https://192.168.1.5'] },
    });
  });

  it('anything that is not an http(s) site, or carries a password, is asked again', () => {
    expect(parseSites('file:///etc/passwd')).toMatchObject({ error: expect.stringContaining('not an http') });
    expect(parseSites('javascript://x')).toMatchObject({ error: expect.any(String) });
    expect(parseSites('https://me:pw@example.com')).toMatchObject({ error: expect.stringContaining('password') });
  });
});

describe("where the device connects", () => {
  it("is the server's own address, as a WebSocket", () => {
    const paths = { controlPath: '/api/browser-relay/control', runPath: '/api/browser-relay/run' };
    expect(relayEndpoints('https://cascadeai.in', paths)).toEqual({ controlUrl: 'wss://cascadeai.in/api/browser-relay/control', runUrl: 'wss://cascadeai.in/api/browser-relay/run' });
    expect(relayEndpoints('http://127.0.0.1:8787/', paths).controlUrl).toBe('ws://127.0.0.1:8787/api/browser-relay/control');
  });
});

describe("the device's key on this machine", () => {
  const stored = (serverUrl: string): StoredRelayDevice => ({ serverUrl, deviceId: 'd1', name: 'n', privateKeyPem: 'pem', serverId: 's', serverKey: 'k' });

  it('is readable by its owner alone', () => {
    const dir = tmp();
    saveRelayDevice(stored('https://a.test'), dir);
    if (process.platform !== 'win32') expect(fs.statSync(relayDevicePath(dir)).mode & 0o777).toBe(0o600);
  });

  it("is this server's only: a device of another server is not offered to it", () => {
    const dir = tmp();
    saveRelayDevice(stored('https://a.test'), dir);
    expect(loadRelayDevice('https://a.test', dir)?.deviceId).toBe('d1');
    expect(loadRelayDevice('https://b.test', dir)).toBeNull();
  });
});

describe('pairing', () => {
  const server = createIdentity('server-1');
  const info = { serverId: 'server-1', serverKey: publicKeyToText(server.publicKey), controlPath: '/c', runPath: '/r' };
  const fakeClient = (reply: { serverId: string; serverKey: string }) => {
    const sent: unknown[] = [];
    return {
      sent,
      client: {
        server: 'https://a.test',
        relayServer: async () => info,
        registerRelayDevice: async (input: unknown) => { sent.push(input); return { device: { id: 'dev-1', name: 'laptop' }, ...reply }; },
      } as unknown as CloudClient,
    };
  };

  it('sends only the public half of a key made here, and pins the server that registered it', async () => {
    const dir = tmp();
    const { client, sent } = fakeClient({ serverId: info.serverId, serverKey: info.serverKey });
    const stored = await pairDevice(client, 'laptop', dir);
    expect(sent).toHaveLength(1);
    const body = sent[0] as { publicKey: string; kind: string };
    expect(body.kind).toBe('cli');
    expect(publicKeyFromText(body.publicKey)).not.toBeNull();
    expect(JSON.stringify(sent)).not.toContain('PRIVATE');
    expect(stored).toMatchObject({ deviceId: 'dev-1', serverId: 'server-1', serverKey: info.serverKey });
    expect(stored.privateKeyPem).toContain('PRIVATE KEY');
    expect(loadRelayDevice('https://a.test', dir)?.deviceId).toBe('dev-1');
  });

  it('a server whose identity changed between the two calls gets nothing saved', async () => {
    const dir = tmp();
    const other = publicKeyToText(createIdentity('x').publicKey);
    const { client } = fakeClient({ serverId: info.serverId, serverKey: other });
    await expect(pairDevice(client, 'laptop', dir)).rejects.toThrow(/identity/);
    expect(fs.existsSync(relayDevicePath(dir))).toBe(false);
  });
});

/** A hub on a real socket that knows one device, as the server does after pairing. */
async function hubWithDevice() {
  const server = createIdentity('server-1');
  const key = generateStoredKey();
  const known = new Map([['dev-1', publicKeyFromText(key.publicKey)!]]);
  const hub = createRelayHub({ server, store: createMemoryNonceStore(Date.now), deviceKey: (id) => known.get(id) ?? null });
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws, req) => {
    if (req.url === '/c') {
      void authenticateControl(ws, { serverId: server.id, device: (id) => (known.has(id) ? { userId: 'user-a', key: known.get(id)! } : null) })
        .then((who) => { if (who) hub.attachDevice(who, ws); });
    } else if (req.url === '/r') hub.attachRun(ws);
    else ws.close();
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  closers.push(() => { hub.close(); httpServer.closeAllConnections(); httpServer.close(); });
  const base = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const stored: StoredRelayDevice = {
    serverUrl: 'http://x', deviceId: 'dev-1', name: 'laptop', privateKeyPem: key.privateKeyPem,
    serverId: server.id, serverKey: publicKeyToText(server.publicKey),
  };
  return { hub, known, stored, endpoints: { controlUrl: `${base}/c`, runUrl: `${base}/r` } };
}

describe('serving', () => {
  const noBrowser = async () => { throw new Error('not in this test'); };

  it('the saved key is accepted by the server, and the device is online until stopped', async () => {
    const h = await hubWithDevice();
    const stop = new AbortController();
    const lines: string[] = [];
    const serving = serveDevice({ stored: h.stored, endpoints: h.endpoints, signal: stop.signal, askUser: async () => null, startBrowser: noBrowser, log: (l) => lines.push(l) });
    await vi.waitFor(() => expect(h.hub.deviceOnline('user-a', 'dev-1')).toBe(true));
    stop.abort();
    expect(await serving).toBe('stopped');
    await vi.waitFor(() => expect(h.hub.deviceOnline('user-a', 'dev-1')).toBe(false));
    expect(lines.some((l) => l.startsWith('connected'))).toBe(true);
  });

  it('a dropped connection comes back by itself', async () => {
    const h = await hubWithDevice();
    const stop = new AbortController();
    const serving = serveDevice({ stored: h.stored, endpoints: h.endpoints, signal: stop.signal, askUser: async () => null, startBrowser: noBrowser, log: () => {}, sleep: async () => {} });
    await vi.waitFor(() => expect(h.hub.deviceOnline('user-a', 'dev-1')).toBe(true));
    h.hub.dropDevice('dev-1', 'the server restarted');
    expect(h.hub.deviceOnline('user-a', 'dev-1')).toBe(false);
    await vi.waitFor(() => expect(h.hub.deviceOnline('user-a', 'dev-1')).toBe(true));
    stop.abort();
    expect(await serving).toBe('stopped');
  });

  it('a device the server no longer knows stops trying, and says so', async () => {
    const h = await hubWithDevice();
    h.known.delete('dev-1');
    const outcome = await serveDevice({ stored: h.stored, endpoints: h.endpoints, signal: new AbortController().signal, askUser: async () => null, startBrowser: noBrowser, log: () => {}, sleep: async () => {} });
    expect(outcome).toBe('refused');
  });

  it('backs off between attempts, and starts over once connected', async () => {
    const waits: number[] = [];
    const stop = new AbortController();
    let n = 0;
    const connect = (_o: DeviceClientOptions): DeviceClient => {
      n += 1;
      const ok = n === 4;
      if (n === 6) stop.abort();
      return {
        ready: ok ? Promise.resolve() : Promise.reject(new Error('no')),
        closed: Promise.resolve('gone'),
        close: async () => {},
      } as unknown as DeviceClient;
    };
    const h = await hubWithDevice();
    await serveDevice({ stored: h.stored, endpoints: h.endpoints, signal: stop.signal, askUser: async () => null, startBrowser: noBrowser, log: () => {}, connect, sleep: async (ms) => { waits.push(ms); }, maxRefusals: 10 });
    expect(waits).toEqual([1000, 2000, 4000, 1000, 2000]);
  });
});
