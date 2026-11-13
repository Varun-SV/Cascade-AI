// Server hub, device client and a real Chromium, end to end: a run on the "server"
// drives a browser on the "device" through Playwright, and only as far as the user agreed.
//
// Set CHROMIUM to a browser. On CI these fail rather than skip when none is found.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { type Identity, createIdentity, createMemoryNonceStore } from './capability.js';
import { startDedicatedBrowser } from './dedicated-browser.js';
import { type DeviceClient, type LeasedBrowser, type UserConsent, connectDeviceClient } from './device.js';
import type { ProxyNetwork } from './egress-proxy.js';
import { RelayRefused, authenticateControl, createRelayHub } from './hub.js';
import { launchForRelayTests } from './launch.js';
import { RemoteBrowserController } from '../remote/controller.js';
import { RelayBrowserProvider } from '../remote/relay-provider.js';

interface PwPage { goto(u: string, o?: object): Promise<unknown>; evaluate<T>(fn: string): Promise<T>; url(): string }
interface PwBrowser { contexts(): { pages(): PwPage[]; waitForEvent(e: string, o: object): Promise<PwPage> }[]; close(): Promise<void>; isConnected(): boolean }
const pw = await import('playwright') as unknown as { chromium: { connectOverCDP(u: string): Promise<PwBrowser>; executablePath(): string } };

function browserPath(): string | null {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  try { const p = pw.chromium.executablePath(); return fs.existsSync(p) ? p : null; } catch { return null; }
}
const CHROMIUM = browserPath();
if (!CHROMIUM && process.env.CI) throw new Error('Relay browser tests need a browser on CI: set CHROMIUM.');
const suite = CHROMIUM ? describe : describe.skip;

const PUBLIC_ALLOWED = '203.0.113.10';
const PUBLIC_OFFLIST = '203.0.113.20';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await Promise.resolve(c()).catch(() => {}); });

async function site(body: string): Promise<{ hits: string[]; port: number }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>${body}</title><body>${body}</body>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { hits, port: (server.address() as AddressInfo).port };
}

async function rig(over: { answer?: UserConsent | null } = {}) {
  const allowed = await site('ALLOWEDPAGE');
  const offlist = await site('OFFLISTPAGE');
  const network: ProxyNetwork = {
    resolve: async (name) => {
      if (name === 'allowed.test') return [PUBLIC_ALLOWED];
      if (name === 'offlist.test') return [PUBLIC_OFFLIST];
      throw new Error('ENOTFOUND');
    },
    dial: (address, port): Socket => net.connect(address === PUBLIC_ALLOWED ? allowed.port : address === PUBLIC_OFFLIST ? offlist.port : port, '127.0.0.1'),
  };
  const server = createIdentity('server');
  const keys = new Map<string, Identity>();
  const owners = new Map<string, string>();
  const hub = createRelayHub({ server, store: createMemoryNonceStore(Date.now), deviceKey: (id) => keys.get(id)?.publicKey ?? null });
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/control') {
      void authenticateControl(ws, {
        serverId: server.id,
        device: (id) => (owners.has(id) && keys.has(id) ? { userId: owners.get(id)!, key: keys.get(id)!.publicKey } : null),
      }).then((who) => { if (who) hub.attachDevice(who, ws); });
    } else if (url.pathname === '/run') hub.attachRun(ws);
    else if (url.pathname.startsWith('/agent/')) hub.attachAgent(url.pathname.slice('/agent/'.length), ws);
    else ws.close();
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  closers.push(() => { hub.close(); httpServer.closeAllConnections(); httpServer.close(); });

  const asked: { userId: string; runId: string }[] = [];
  const browsers: { closed: boolean; leased: LeasedBrowser }[] = [];
  const device = async (userId: string, name: string): Promise<DeviceClient> => {
    const id = createIdentity(name);
    keys.set(name, id);
    owners.set(name, userId);
    const log: string[] = [];
    const client = connectDeviceClient({
      controlUrl: `${base}/control`, runUrl: `${base}/run`,
      device: id, serverId: server.id, serverKey: server.publicKey, log: (l) => log.push(l),
      askUser: async (run) => {
        asked.push({ userId: run.userId, runId: run.runId });
        return over.answer === undefined ? { allowedOrigins: ['http://allowed.test'], privateOrigins: [] } : over.answer;
      },
      startBrowser: async (consent) => {
        const leased = await startDedicatedBrowser({
          consent, chromiumPath: CHROMIUM!, network,
          launch: (proxy) => launchForRelayTests({ chromiumPath: CHROMIUM!, proxy, testArgs: ['--unsafely-treat-insecure-origin-as-secure=http://allowed.test'] }),
        });
        const entry = { closed: false, leased };
        browsers.push(entry);
        return { ...leased, close: async () => { entry.closed = true; await leased.close(); } };
      },
    });
    closers.push(() => client.close());
    await client.ready;
    await vi.waitFor(() => expect(hub.deviceOnline(userId, name)).toBe(true));
    return client;
  };
  /** The run's side: ask for the browser, then drive it the way the browser tool does. */
  const drive = async (userId: string, deviceId: string, runId: string) => {
    const relayed = await hub.requestBrowser({ userId, deviceId, runId });
    const pwBrowser = await pw.chromium.connectOverCDP(`${base}/agent/${relayed.token}`);
    closers.push(() => pwBrowser.close());
    const ctx = pwBrowser.contexts()[0]!;
    const page = ctx.pages()[0] ?? await ctx.waitForEvent('page', { timeout: 5000 });
    return { relayed, pwBrowser, page };
  };
  return { hub, allowed, offlist, device, drive, asked, browsers, agentUrl: (token: string) => `${base}/agent/${token}` };
}

suite('a run on the server drives a browser on the device', { timeout: 60_000 }, () => {
  it('the user approves, and the run reaches the consented site and nothing else', async () => {
    const r = await rig();
    await r.device('user-a', 'device-a');
    const { page } = await r.drive('user-a', 'device-a', 'run-1');
    expect(r.asked).toEqual([{ userId: 'user-a', runId: 'run-1' }]);
    await page.goto('http://allowed.test/hello');
    expect(await page.evaluate('document.body.textContent')).toBe('ALLOWEDPAGE');
    expect(r.allowed.hits).toContain('GET /hello');
    // A site the user didn't agree to: the navigation fails on the device, and nothing is sent.
    await expect(page.goto('http://offlist.test/secret', { timeout: 5000 })).rejects.toThrow();
    expect(r.offlist.hits).toEqual([]);
    expect(page.url()).toContain('allowed.test');
  });

  it('the user says no: the run is refused, and no browser is started', async () => {
    const r = await rig({ answer: null });
    await r.device('user-a', 'device-a');
    await expect(r.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' })).rejects.toBeInstanceOf(RelayRefused);
    expect(r.browsers).toEqual([]);
  });

  it("user A's run can't be given user B's device, and B is never asked", async () => {
    const r = await rig();
    await r.device('user-b', 'device-b');
    await expect(r.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-b', runId: 'run-1' })).rejects.toBeInstanceOf(RelayRefused);
    await sleep(200);
    expect(r.asked).toEqual([]);
    expect(r.browsers).toEqual([]);
  });

  it('a second run while the browser is in use is declined without asking, and the first carries on', async () => {
    const r = await rig();
    await r.device('user-a', 'device-a');
    const first = await r.drive('user-a', 'device-a', 'run-1');
    await expect(r.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-2' })).rejects.toBeInstanceOf(RelayRefused);
    expect(r.asked).toHaveLength(1);
    await first.page.goto('http://allowed.test/still-mine');
    expect(r.allowed.hits).toContain('GET /still-mine');
  });

  const endings: [string, (r: Awaited<ReturnType<typeof rig>>, d: DeviceClient) => void][] = [
    ['the run ending on the server', (r) => r.hub.endRun('run-1', 'the run ended')],
    ['the user pressing Stop on the device', (_r, d) => d.revoke('the user stopped it')],
    ['the device being signed out by the server', (r) => r.hub.dropDevice('device-a', 'signed out')],
  ];
  for (const [name, end] of endings) {
    it(`${name} ends the lease: the run is disconnected and the browser is gone`, async () => {
      const r = await rig();
      const d = await r.device('user-a', 'device-a');
      const { page, pwBrowser, relayed } = await r.drive('user-a', 'device-a', 'run-1');
      await page.goto('http://allowed.test/before');
      const lease = d.lease()!;
      expect(lease.state()).toBe('held');
      end(r, d);
      await relayed.closed;
      await vi.waitFor(() => expect(pwBrowser.isConnected()).toBe(false), { timeout: 10_000 });
      await vi.waitFor(() => expect(r.browsers[0]!.closed).toBe(true), { timeout: 10_000 });
      expect(lease.state()).toBe('idle');
      // Nothing more arrives anywhere.
      const hits = r.allowed.hits.length;
      await sleep(300);
      expect(r.allowed.hits.length).toBe(hits);
    });
  }

  it('after a lease ends, a new run needs a new approval and gets a fresh browser', async () => {
    const r = await rig();
    const d = await r.device('user-a', 'device-a');
    const first = await r.drive('user-a', 'device-a', 'run-1');
    r.hub.endRun('run-1', 'the run ended');
    await first.relayed.closed;
    // Until the old browser is fully gone the device is still busy, and says so.
    await vi.waitFor(() => expect(d.lease()).toBeNull(), { timeout: 10_000 });
    expect(r.browsers[0]!.closed).toBe(true);
    const second = await r.drive('user-a', 'device-a', 'run-2');
    expect(r.asked.map((a) => a.runId)).toEqual(['run-1', 'run-2']);
    expect(r.browsers).toHaveLength(2);
    await second.page.goto('http://allowed.test/second');
    expect(r.allowed.hits).toContain('GET /second');
  });
});

suite("the server's own browser controller, with the user's browser behind it", { timeout: 90_000 }, () => {
  const ctx = (sessionId: string, actorId: string) => ({ sessionId, actorId });

  it('navigating, reading, waiting and a page view work through the relay, and the device refuses nothing they need', async () => {
    const r = await rig();
    const d = await r.device('user-a', 'device-a');
    const provider = new RelayBrowserProvider({ hub: r.hub, agentUrl: r.agentUrl, userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    const c = new RemoteBrowserController({ provider });
    closers.push(() => c.dispose());

    const nav = await c.controller({ kind: 'navigate', url: 'http://allowed.test/form' }, ctx('run-1', 'w1'));
    expect(nav.ok, nav.detail).toBe(true);
    expect(r.asked).toEqual([{ userId: 'user-a', runId: 'run-1' }]);
    const text = await c.controller({ kind: 'extract_text' }, ctx('run-1', 'w1'));
    expect(text.ok, text.detail).toBe(true);
    expect(text.detail).toContain('ALLOWEDPAGE');
    const waited = await c.controller({ kind: 'wait_for', selector: 'body' }, ctx('run-1', 'w1'));
    expect(waited.ok, waited.detail).toBe(true);
    const observed = await c.controller({ kind: 'observe' }, ctx('run-1', 'w1'));
    expect(observed.ok, observed.detail).toBe(true);

    // A site the user did not agree to: refused on the device, nothing sent.
    const off = await c.controller({ kind: 'navigate', url: 'http://offlist.test/secret' }, ctx('run-1', 'w1'));
    expect(off.ok).toBe(false);
    expect(r.offlist.hits).toEqual([]);

    // What the controller asked for that the device would not do. Recorded, so a change
    // in either that breaks the pairing shows up here.
    expect([...d.relay()!.refusedMethods].sort()).toEqual([]);

    await c.endRun('run-1');
    await vi.waitFor(() => expect(d.lease()).toBeNull(), { timeout: 15_000 });
    expect(r.browsers[0]!.closed).toBe(true);
  });

  it('a user who says no gives the run a refusal it can show, and no browser', async () => {
    const r = await rig({ answer: null });
    await r.device('user-a', 'device-a');
    const provider = new RelayBrowserProvider({ hub: r.hub, agentUrl: r.agentUrl, userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    const c = new RemoteBrowserController({ provider });
    closers.push(() => c.dispose());
    const nav = await c.controller({ kind: 'navigate', url: 'http://allowed.test/' }, ctx('run-1', 'w1'));
    expect(nav.ok).toBe(false);
    expect(nav.detail).toContain('declined on the device');
    expect(r.browsers).toEqual([]);
  });

  it('with the device offline the run is told so at once', async () => {
    const r = await rig();
    const provider = new RelayBrowserProvider({ hub: r.hub, agentUrl: r.agentUrl, userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    const c = new RemoteBrowserController({ provider });
    closers.push(() => c.dispose());
    const nav = await c.controller({ kind: 'navigate', url: 'http://allowed.test/' }, ctx('run-1', 'w1'));
    expect(nav.ok).toBe(false);
    expect(nav.detail).toContain('not connected');
  });
});
