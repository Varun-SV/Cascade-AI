// The desktop's webContents.debugger adapter under a real Playwright session, through
// the relay. Electron isn't run here: its debugger is stood in for by a real Chromium
// tab's DevTools connection with the same shape (sendCommand, 'message', 'detach').

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createIdentity, createMemoryNonceStore } from '../../src/browser/relay/capability.js';
import { connectCdp } from '../../src/browser/relay/cdp-client.js';
import { startDedicatedBrowser } from '../../src/browser/relay/dedicated-browser.js';
import { connectDeviceClient } from '../../src/browser/relay/device.js';
import type { ProxyNetwork } from '../../src/browser/relay/egress-proxy.js';
import { authenticateControl, createRelayHub } from '../../src/browser/relay/hub.js';
import { launchForRelayTests } from '../../src/browser/relay/launch.js';
import { debuggerCdp, type ElectronDebugger } from './relay-device.js';

interface PwPage { goto(u: string, o?: object): Promise<unknown>; evaluate<T>(fn: string): Promise<T>; fill(s: string, v: string): Promise<void>; click(s: string): Promise<void> }
interface PwBrowser { contexts(): { pages(): PwPage[]; waitForEvent(e: string, o: object): Promise<PwPage> }[]; close(): Promise<void> }
const pw = await import('playwright') as unknown as { chromium: { connectOverCDP(u: string): Promise<PwBrowser>; executablePath(): string } };
const CHROMIUM = process.env.CHROMIUM ?? (() => { try { const p = pw.chromium.executablePath(); return fs.existsSync(p) ? p : null; } catch { return null; } })();
if (!CHROMIUM && process.env.CI) throw new Error('These tests need a browser on CI: set CHROMIUM.');
const suite = CHROMIUM ? describe : describe.skip;
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await Promise.resolve(c()).catch(() => {}); });

/** A tab's DevTools connection, shaped as Electron's webContents.debugger. */
async function debuggerOver(tabWs: string): Promise<ElectronDebugger> {
  const cdp = await connectCdp(tabWs);
  const ee = new EventEmitter();
  cdp.on((m) => { if (m.method) ee.emit('message', {}, m.method, m.params ?? {}, m.sessionId); });
  cdp.onClose(() => ee.emit('detach', {}, 'target closed'));
  return {
    attach: () => {}, detach: () => cdp.close(), isAttached: () => !cdp.closed,
    sendCommand: (method: string, params?: object, sessionId?: string) => cdp.send(method, (params ?? {}) as Record<string, unknown>, sessionId),
    on: ((e: string, fn: (...a: never[]) => void) => ee.on(e, fn as (...a: unknown[]) => void)) as ElectronDebugger['on'],
    removeListener: (e: string, fn: (...a: never[]) => void) => ee.removeListener(e, fn as (...a: unknown[]) => void),
  };
}

suite("the desktop's debugger adapter, driven through the relay", { timeout: 90_000 }, () => {
  it('Playwright navigates, fills and clicks on a consented site, and the off-list one gets nothing', async () => {
    const hits: string[] = [];
    const offHits: string[] = [];
    const site = (log: string[], body: string) => http.createServer((req, res) => {
      log.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'text/html');
      res.end(req.url === '/form' ? '<input id=q><button id=go onclick="document.getElementById(\'o\').textContent=\'SENT:\'+q.value">go</button><p id=o></p>' : body);
    });
    const allowed = site(hits, 'ALLOWED');
    const offlist = site(offHits, 'OFF');
    for (const s of [allowed, offlist]) { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); closers.push(() => { s.closeAllConnections(); s.close(); }); }
    const port = (s: http.Server) => (s.address() as AddressInfo).port;
    const network: ProxyNetwork = {
      resolve: async (name) => { if (name === 'allowed.test') return ['203.0.113.10']; if (name === 'offlist.test') return ['203.0.113.20']; throw new Error('ENOTFOUND'); },
      dial: (address, p): Socket => net.connect(address === '203.0.113.10' ? port(allowed) : address === '203.0.113.20' ? port(offlist) : p, '127.0.0.1'),
    };

    const server = createIdentity('server');
    const device = createIdentity('desktop-1');
    const hub = createRelayHub({ server, store: createMemoryNonceStore(Date.now), deviceKey: (id) => (id === 'desktop-1' ? device.publicKey : null) });
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws, req) => {
      const p = req.url ?? '';
      if (p === '/control') void authenticateControl(ws, { serverId: server.id, device: (id) => (id === 'desktop-1' ? { userId: 'u', key: device.publicKey } : null) }).then((who) => { if (who) hub.attachDevice(who, ws); });
      else if (p === '/run') hub.attachRun(ws);
      else if (p.startsWith('/agent/')) hub.attachAgent(p.slice(7), ws);
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    closers.push(() => { hub.close(); httpServer.closeAllConnections(); httpServer.close(); });
    const base = `ws://127.0.0.1:${port(httpServer as unknown as http.Server)}`;

    const client = connectDeviceClient({
      controlUrl: `${base}/control`, runUrl: `${base}/run`, device, serverId: server.id, serverKey: server.publicKey,
      askUser: async () => ({ allowedOrigins: ['http://allowed.test'], privateOrigins: [] }),
      startBrowser: async (consent) => {
        const leased = await startDedicatedBrowser({
          consent, chromiumPath: CHROMIUM!, network,
          launch: (proxy) => launchForRelayTests({ chromiumPath: CHROMIUM!, proxy }),
        });
        closers.push(() => leased.close());
        // The relay reaches the tab the way the desktop does: through its debugger.
        return { ...leased, connectTab: async () => debuggerCdp(await debuggerOver(leased.tabWs)) };
      },
    });
    closers.push(() => client.close());
    await client.ready;
    await vi.waitFor(() => expect(hub.deviceOnline('u', 'desktop-1')).toBe(true));
    const relayed = await hub.requestBrowser({ userId: 'u', deviceId: 'desktop-1', runId: 'run-1' });
    const agent = await pw.chromium.connectOverCDP(`${base}/agent/${relayed.token}`);
    closers.push(() => agent.close());
    const ctx = agent.contexts()[0]!;
    const page = ctx.pages()[0] ?? await ctx.waitForEvent('page', { timeout: 10_000 });

    await page.goto('http://allowed.test/form');
    await page.fill('#q', 'from the desktop adapter');
    await page.click('#go');
    expect(await page.evaluate<string>("document.getElementById('o').textContent")).toBe('SENT:from the desktop adapter');
    await expect(page.goto('http://offlist.test/secret', { timeout: 5000 })).rejects.toThrow();
    expect(offHits).toEqual([]);
    expect(hits).toContain('GET /form');
    expect([...client.relay()!.refusedMethods]).toEqual([]);
  });
});
