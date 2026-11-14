// ─────────────────────────────────────────────
//  The Chrome extension, built and loaded into a real Chromium
// ─────────────────────────────────────────────
//
//  Not a stand-in for chrome.debugger: the extension as a user installs it, its MV3
//  service worker connected to a relay hub, the run's tab driven by Playwright through
//  the relay as the server drives it. Every "nothing was sent" is counted at the
//  destination server.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createIdentity, createMemoryNonceStore, generateStoredKey, publicKeyFromText, publicKeyToText } from '../../src/browser/relay/capability.js';
import { authenticateControl, createRelayHub, type RelayHub } from '../../src/browser/relay/hub.js';
import { connectCdp } from '../../src/browser/relay/cdp-client.js';

interface PwPage { goto(u: string, o?: object): Promise<unknown>; evaluate<T>(fn: string): Promise<T>; url(): string; fill(s: string, v: string): Promise<void>; click(s: string): Promise<void>; waitForURL?(u: string): Promise<void>; isClosed(): boolean; close(): Promise<void> }
interface PwContext { pages(): PwPage[]; serviceWorkers(): { evaluate<T>(fn: (arg: never) => unknown, arg?: unknown): Promise<T>; url(): string }[]; waitForEvent(e: string, o?: object): Promise<never>; close(): Promise<void> }
interface PwBrowser { contexts(): { pages(): PwPage[]; waitForEvent(e: string, o: object): Promise<PwPage> }[]; close(): Promise<void> }
const pw = await import('playwright') as unknown as {
  chromium: { connectOverCDP(u: string): Promise<PwBrowser>; launchPersistentContext(dir: string, o: object): Promise<PwContext>; executablePath(): string };
};

function browserPath(): string | null {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  try { const p = pw.chromium.executablePath(); return fs.existsSync(p) ? p : null; } catch { return null; }
}
const CHROMIUM = browserPath();
if (!CHROMIUM && process.env.CI) throw new Error('The extension tests need a browser on CI: set CHROMIUM.');
const suite = CHROMIUM ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A request the test awaits later: its refusal may come while the test is still answering. */
const handled = <T>(p: Promise<T>): Promise<T> => { p.catch(() => {}); return p; };
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await Promise.resolve(c()).catch(() => {}); });

beforeAll(() => {
  if (!CHROMIUM) return;
  execFileSync(process.execPath, [path.join(here, '..', 'build.mjs')], { stdio: 'pipe' });
}, 120_000);
afterAll(() => {});

interface Site { hits: string[]; port: number }
async function site(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean): Promise<Site> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (handler?.(req, res)) return;
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>page</title><body>page</body>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return { hits, port: (server.address() as AddressInfo).port };
}

async function rig() {
  const offlist = await site();
  const allowed = await site((req, res) => {
    const html = (body: string) => { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><body>${body}</body>`); return true; };
    switch (req.url) {
      case '/links': return html('<a id=off href="http://offlist.test/link">off</a>');
      case '/redirect': res.statusCode = 302; res.setHeader('location', 'http://offlist.test/from-redirect'); res.end(); return true;
      case '/attachment': res.setHeader('content-type', 'application/octet-stream'); res.setHeader('content-disposition', 'attachment; filename="report.bin"'); res.end('BYTES'); return true;
      case '/form': return html('<label for=q>Name</label><input id=q><button id=go onclick="document.getElementById(\'out\').textContent=\'SENT:\'+q.value">Send</button><p id=out></p>');
      default: return false;
    }
  });

  const server = createIdentity('server-1');
  const key = generateStoredKey();
  const deviceKey = publicKeyFromText(key.publicKey)!;
  const hub: RelayHub = createRelayHub({ server, store: createMemoryNonceStore(Date.now), deviceKey: (id) => (id === 'dev-ext' ? deviceKey : null) });
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws, req) => {
    const p = (req.url ?? '').split('?')[0]!;
    if (p === '/control') {
      void authenticateControl(ws, { serverId: server.id, device: (id) => (id === 'dev-ext' ? { userId: 'user-a', key: deviceKey } : null) })
        .then((who) => { if (who) hub.attachDevice(who, ws); });
    } else if (p === '/run') hub.attachRun(ws);
    else if (p.startsWith('/agent/')) hub.attachAgent(p.slice('/agent/'.length), ws);
    else ws.close();
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  closers.push(() => { hub.close(); httpServer.closeAllConnections(); httpServer.close(); });
  const port = (httpServer.address() as AddressInfo).port;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ext-'));
  const downloads = path.join(profile, 'Downloads');
  fs.mkdirSync(downloads);
  const ctx = await pw.chromium.launchPersistentContext(profile, {
    executablePath: CHROMIUM!, headless: true, acceptDownloads: true, downloadsPath: downloads,
    args: [
      `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
      `--host-resolver-rules=MAP allowed.test 127.0.0.1:${allowed.port}, MAP offlist.test 127.0.0.1:${offlist.port}`,
      // A second way in, for a test that stops the extension's worker as Chrome would.
      '--remote-debugging-port=0',
    ],
  });
  const browserCdp = async () => {
    const [portLine] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf-8').split('\n');
    const list = await (await fetch(`http://127.0.0.1:${portLine}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const c = await connectCdp(list.webSocketDebuggerUrl);
    closers.push(() => c.close());
    return c;
  };
  closers.push(async () => { await ctx.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  const sw = ctx.serviceWorkers().find((w) => w.url().endsWith('/background.js')) ?? await ctx.waitForEvent('serviceworker');

  const device = {
    serverUrl: `http://127.0.0.1:${port}`, deviceId: 'dev-ext', name: 'Test Chrome', privateKeyPem: key.privateKeyPem,
    serverId: server.id, serverKey: publicKeyToText(server.publicKey), controlPath: '/control', runPath: '/run',
  };
  await sw.evaluate((d) => chrome.storage.local.set({ device: d }), device as never);
  await vi.waitFor(() => expect(hub.deviceOnline('user-a', 'dev-ext')).toBe(true), { timeout: 15_000 });

  /** Waits for the extension's question, and answers it in its own window as a person would. */
  const answer = async (sites: string | null) => {
    let consent: PwPage | undefined;
    await vi.waitFor(() => { consent = ctx.pages().find((p) => p.url().includes('consent.html')); expect(consent).toBeTruthy(); }, { timeout: 10_000 });
    await vi.waitFor(async () => expect(await consent!.evaluate<string>('document.getElementById("who").textContent')).not.toBe('Loading…'));
    if (sites === null) await consent!.click('#decline');
    else { await consent!.fill('#sites', sites); await consent!.click('#allow'); }
    return consent!;
  };

  /** A run asks for the browser; the user answers; the run drives it through the relay. */
  const run = async (runId: string, sites = 'http://allowed.test') => {
    const asked = hub.requestBrowser({ userId: 'user-a', deviceId: 'dev-ext', runId });
    await answer(sites);
    const relayed = await asked;
    const agent = await pw.chromium.connectOverCDP(`ws://127.0.0.1:${port}/agent/${relayed.token}`);
    closers.push(() => agent.close());
    const c = agent.contexts()[0]!;
    const page = c.pages()[0] ?? await c.waitForEvent('page', { timeout: 10_000 });
    return { relayed, agent, page };
  };
  /** The worker's own state and recent log, as DevTools on it would show. */
  const status = () => sw.evaluate<{ status: { run?: { runId: string; sites: string[] }; connection: string; notice?: string }; recent: string[] }>(
    () => JSON.parse(JSON.stringify((globalThis as unknown as { cascade: object }).cascade)) as never);
  return { hub, ctx, sw, allowed, offlist, downloads, answer, run, status, browserCdp };
}

suite('the extension in a real Chromium', { timeout: 90_000 }, () => {
  it('connects as the paired device, and a run it allows reaches the consented site', async () => {
    const r = await rig();
    const { page } = await r.run('run-1').catch(async (e: Error) => { throw new Error(`${e.message}\n${(await r.status()).recent.join('\n')}`); });
    await page.goto('http://allowed.test/hello');
    expect(await page.evaluate<string>('document.body.textContent')).toBe('page');
    expect(r.allowed.hits).toContain('GET /hello');
  });

  it('P2: agent navigation, a link, script, a redirect and an iframe send nothing to a site without consent', async () => {
    const r = await rig();
    const { page } = await r.run('run-1');
    await expect(page.goto('http://offlist.test/agent', { timeout: 5000 })).rejects.toThrow();
    await page.goto('http://allowed.test/links');
    await page.click('#off').catch(() => {});
    await page.evaluate("location.href = 'http://offlist.test/script'").catch(() => {});
    await page.goto('http://allowed.test/links');
    await page.goto('http://allowed.test/redirect').catch(() => {});
    await page.goto('http://allowed.test/links');
    await page.evaluate("(() => { const f = document.createElement('iframe'); f.src = 'http://offlist.test/frame'; document.body.append(f); return 1; })()");
    await sleep(1500);
    expect(r.allowed.hits).toContain('GET /redirect');
    expect(r.offlist.hits).toEqual([]);
    // Still the run's: none of that ended it.
    expect(page.url()).toContain('allowed.test');
  });

  it('fill and click work in the run tab', async () => {
    const r = await rig();
    const { page } = await r.run('run-1');
    await page.goto('http://allowed.test/form');
    await page.fill('#q', 'from the agent');
    await page.click('#go');
    expect(await page.evaluate<string>("document.getElementById('out').textContent")).toBe('SENT:from the agent');
  });

  it('a user who says no: the run is refused and no window is opened for it', async () => {
    const r = await rig();
    const before = r.ctx.pages().length;
    const asked = handled(r.hub.requestBrowser({ userId: 'user-a', deviceId: 'dev-ext', runId: 'run-1' }));
    await r.answer(null);
    await expect(asked).rejects.toThrow(/declined/);
    await sleep(300);
    expect(r.ctx.pages().filter((p) => !p.url().includes('consent.html')).length).toBeLessThanOrEqual(before);
  });

  it('a private-network site is not accepted as an answer: the user is told why and asked again', async () => {
    const r = await rig();
    const asked = handled(r.hub.requestBrowser({ userId: 'user-a', deviceId: 'dev-ext', runId: 'run-1' }));
    const consent = await r.answer('http://localhost:3000');
    await vi.waitFor(async () => expect(await consent.evaluate<string>("document.getElementById('error').textContent")).toMatch(/private network/));
    expect(consent.isClosed()).toBe(false);
    await consent.fill('#sites', 'http://allowed.test');
    await consent.click('#allow');
    const relayed = await asked;
    relayed.close('done');
  });

  it("P4: a download from the run tab stops the run, and isn't cancelled; the user's own download is untouched", async () => {
    const r = await rig();
    const { page, relayed } = await r.run('run-1', 'http://allowed.test');
    await page.goto('http://allowed.test/links');
    // The user's own tab, downloading at the same time.
    const mine = r.ctx.pages()[0]!;
    const own = (mine as unknown as { waitForEvent(e: string): Promise<{ path(): Promise<string | null> }> }).waitForEvent('download');
    await mine.goto('http://allowed.test/attachment').catch(() => {});
    const started = Date.now();
    await page.evaluate("(() => { const a = document.createElement('a'); a.href = '/attachment'; document.body.append(a); a.click(); return 1; })()").catch(() => {});
    await Promise.race([relayed.closed, sleep(5000).then(() => { throw new Error('the run did not stop'); })]);
    expect(Date.now() - started).toBeLessThan(3000);
    await vi.waitFor(async () => {
      const st = await r.status();
      expect(st.status.notice).toMatch(/download/);
      expect(st.status.run).toBeUndefined();
    }, { timeout: 5000 });
    // Neither download was cancelled: the user's completes.
    expect(await (await own).path()).toBeTruthy();
  });

  it("a page the run tab opens is closed, and the opener's script carries on", async () => {
    const r = await rig();
    const { page } = await r.run('run-1');
    await page.goto('http://allowed.test/links');
    const before = r.ctx.pages().length;
    // Synchronous, as a page's own script or a target=_blank click does it.
    const answered = await Promise.race([page.evaluate<number>("window.open('http://allowed.test/popup'); 1"), sleep(5000).then(() => 'stalled')]);
    expect(answered).toBe(1);
    await vi.waitFor(() => expect(r.ctx.pages().some((p) => p.url().includes('/popup'))).toBe(false), { timeout: 5000 });
    expect(r.ctx.pages().length).toBeLessThanOrEqual(before);
    expect(await page.evaluate<number>('1 + 1')).toBe(2);
  });

  it('R-A3: the service worker stopping mid-run ends the run, its window goes, and nothing reattaches without a new yes', async () => {
    const r = await rig();
    const { page, relayed } = await r.run('run-1');
    await page.goto('http://allowed.test/hello');
    // As Chrome does to an idle MV3 worker: stop it, from outside.
    const cdp = await r.browserCdp();
    const targets = (await cdp.send('Target.getTargets')).targetInfos as { targetId: string; type: string; url: string }[];
    const worker = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'))!;
    await cdp.send('Target.closeTarget', { targetId: worker.targetId });
    await Promise.race([relayed.closed, sleep(10_000).then(() => { throw new Error('the run did not end'); })]);
    await expect(page.goto('http://allowed.test/again', { timeout: 3000 })).rejects.toThrow();
    // Woken again, as an alarm or the toolbar button would: what the last worker left goes first.
    const extId = new URL(r.sw.url()).host;
    const popup = r.ctx.pages()[0]!;
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await vi.waitFor(() => expect(r.ctx.pages().some((p) => p.url().includes('/hello'))).toBe(false), { timeout: 10_000 });
    const after = (await cdp.send('Target.getTargets')).targetInfos as { attached: boolean; url: string; type: string }[];
    expect(after.filter((t) => t.type === 'page' && t.url.includes('allowed.test'))).toEqual([]);
    await vi.waitFor(() => expect(r.hub.deviceOnline('user-a', 'dev-ext')).toBe(true), { timeout: 15_000 });
    // A new run asks again, and only a new answer gives it a browser.
    const again = handled(r.hub.requestBrowser({ userId: 'user-a', deviceId: 'dev-ext', runId: 'run-2' }));
    await r.answer(null);
    await expect(again).rejects.toThrow(/declined/);
    expect(r.allowed.hits.filter((h) => h === 'GET /again')).toEqual([]);
  });

  it('Stop in the toolbar popup ends the run', async () => {
    const r = await rig();
    const { relayed } = await r.run('run-1');
    const extId = new URL(r.sw.url()).host;
    const popup = r.ctx.pages()[0]!;
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await vi.waitFor(async () => expect(await popup.evaluate<boolean>("!document.getElementById('run').hidden")).toBe(true));
    await popup.click('#stop');
    await Promise.race([relayed.closed, sleep(5000).then(() => { throw new Error('the run did not stop'); })]);
  });

  it('closing the run window ends the run', async () => {
    const r = await rig();
    const { relayed } = await r.run('run-1');
    const st = await r.status();
    await r.sw.evaluate((id: never) => chrome.windows.remove(id), (st.status.run as { windowId: number }).windowId as never);
    await Promise.race([relayed.closed, sleep(5000).then(() => { throw new Error('the run did not end'); })]);
  });

  it("the user's other tabs are not policed: the rules are the run tab's alone", async () => {
    const r = await rig();
    await r.run('run-1');
    const mine = r.ctx.pages()[0]!;
    await mine.goto('http://offlist.test/mine');
    expect(r.offlist.hits).toEqual(['GET /mine']);
  });
});
