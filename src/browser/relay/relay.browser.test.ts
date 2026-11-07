// The relay against a real Chromium. Every "blocked" here is asserted where the
// traffic would arrive: servers and sockets that only count. Each family has a control
// with no policy that must reach them, or the test couldn't have detected a leak.
//
// Set CHROMIUM to a browser. On CI these fail rather than skip when none is found.

import { execFileSync, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient, type WebSocket, WebSocketServer } from 'ws';
import { connectCdp } from './cdp-client.js';
import { type EgressProxy, type ProxyNetwork, browserProxyArgs, startEgressProxy } from './egress-proxy.js';
import { type Consent, makeConsent } from './egress-rules.js';
import { navigateHistory } from './history.js';
import { type LaunchedBrowser, isBrowserOwnUi, launchBehindProxy, launchForRelayTests, verifyLaunchedProfile } from './launch.js';
import { type DeviceRelay, createDeviceRelay } from './relay.js';
import { type PageEndMode, type RequestEnforcer, startRequestPolicy } from './request-enforcer.js';
import { createTabLease, type TabLease } from './tab-lease.js';

interface PwPage {
  goto(u: string, o?: object): Promise<unknown>;
  evaluate<T>(fn: string | ((a: never) => T), a?: unknown): Promise<T>;
  click(s: string, o?: object): Promise<void>;
  mouse: { click(x: number, y: number): Promise<void> };
  setContent(h: string): Promise<void>;
  url(): string;
  goBack(o: object): Promise<unknown>;
  goForward(o: object): Promise<unknown>;
  waitForLoadState(s: string, o?: object): Promise<unknown>;
  on(e: string, f: (x: { dismiss(): Promise<void> }) => void): void;
}
interface PwBrowser { contexts(): { pages(): PwPage[]; waitForEvent(e: string, o: object): Promise<PwPage>; newCDPSession(p: PwPage): Promise<{ send(m: string, p?: object): Promise<unknown> }> }[]; close(): Promise<void> }
const pw = await import('playwright') as unknown as {
  chromium: { connectOverCDP(u: string, o?: object): Promise<PwBrowser>; executablePath(): string; launch(o: object): Promise<PwBrowser & { newPage(): Promise<PwPage> }> };
};

function browserPath(): string | null {
  const fromEnv = process.env.CHROMIUM;
  if (fromEnv) return fromEnv;
  try { const p = pw.chromium.executablePath(); return fs.existsSync(p) ? p : null; } catch { return null; }
}
const CHROMIUM = browserPath();
// On CI a missing browser is a failure: a skipped P2 gate is an absent one.
if (!CHROMIUM && process.env.CI) throw new Error('Relay browser tests need a browser on CI: set CHROMIUM.');
const suite = CHROMIUM ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Counting { hits: string[]; accepts: number; port: number; close(): void }
/** `handle` answers the paths it knows and returns true; anything else gets a plain page. */
function countingServer(handle: (path: string, res: http.ServerResponse, req: http.IncomingMessage) => boolean = () => false, host = '127.0.0.1'): Promise<Counting> {
  const state = { hits: [] as string[], accepts: 0 };
  const server = http.createServer((req, res) => {
    state.hits.push(`${req.method} ${req.url}`);
    if (handle((req.url ?? '/').split('?')[0]!, res, req)) return;
    res.setHeader('content-type', 'text/html');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end('<!doctype html><title>page</title><body>page</body>');
  });
  server.on('connection', () => { state.accepts += 1; });
  server.on('upgrade', (_q, s) => s.destroy());
  return new Promise((resolve, reject) => server.once('error', reject).listen(0, host, () => {
    const port = (server.address() as AddressInfo).port;
    resolve({ get hits() { return state.hits; }, get accepts() { return state.accepts; }, port, close() { server.closeAllConnections(); server.close(); } });
  }));
}
function udpCounter(): Promise<{ count(): number; port: number; close(): void }> {
  let n = 0;
  const s = dgram.createSocket('udp4');
  s.on('message', () => { n += 1; });
  return new Promise((resolve) => s.bind(0, '127.0.0.1', () => resolve({ count: () => n, port: s.address().port, close: () => s.close() })));
}

/** What `/hold` has seen: a response it never finishes, and a slowly read upload. */
const held = { open: 0, uploaded: 0, slow: true };
function holdOpen(req: http.IncomingMessage, res: http.ServerResponse): void {
  held.open += 1;
  res.on('close', () => { held.open -= 1; });
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'POST') {
    // Slow enough that the upload is still going when the lease ends.
    req.on('data', (d: Buffer) => {
      held.uploaded += d.length;
      if (!held.slow) return;
      req.pause();
      setTimeout(() => req.resume(), 100);
    });
  }
  res.write('first');
}

const PUBLIC_ALLOWED = '203.0.113.10';
const PUBLIC_OFFLIST = '203.0.113.20';
const WORKER_JS = "fetch(self.location.origin + '/beacon?ran').catch(() => {});";

interface Rig {
  allowed: Counting; offlist: Counting; priv: Counting;
  proxy: EgressProxy; browser: LaunchedBrowser; enforcer: RequestEnforcer; lease: TabLease; relay: DeviceRelay; consent: Consent;
  dials: { address: string; port: number }[];
  /** Every name the browser asked the proxy to reach. */
  resolved: string[];
  setFlip(a: string): void;
  agentFrames: string[];
  page: PwPage; pwBrowser: PwBrowser; agent: { close(): void; send(raw: string): void };
  /** A direct command on the tab's session, as an agent not using Playwright would send it. */
  command(method: string, params?: object): Promise<{ result?: Record<string, unknown>; error?: { message: string } }>;
  serving: Promise<void>;
  stop(): Promise<void>;
}
const rigs: Rig[] = [];

async function startRig(opts: {
  pageEnd?: PageEndMode; consent?: Consent; raw?: boolean; beforePolicy?: (b: LaunchedBrowser) => Promise<void>;
  /** For one test: the relay's consent, narrower than the network policy's. */
  relayConsent?: Consent;
  /** For controls: a profile with none of the launch's preferences. */
  bareProfile?: boolean;
} = {}): Promise<Rig> {
  const script = (res: http.ServerResponse, extra = ''): boolean => { res.setHeader('content-type', 'text/javascript'); res.end(WORKER_JS + extra); return true; };
  const redirect = (res: http.ServerResponse, to: string): boolean => { res.statusCode = 302; res.setHeader('location', to); res.end(); return true; };
  const allowed = await countingServer((path, res, req) => {
    switch (path) {
      case '/sw-private.js': return script(res, `fetch(${JSON.stringify(decodeURIComponent((req.url ?? '').split('u=')[1] ?? ''))}, { mode: 'no-cors' }).catch(() => {});`);
      case '/worker.js': case '/sw.js': return script(res);
      case '/hold': holdOpen(req, res); return true;
      case '/prerender-rules':
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><script type="speculationrules">' + JSON.stringify({ prerender: [{ urls: ['/pre-same', '/pre-redirect'] }] }) + '</script>');
        return true;
      case '/pre-redirect': return redirect(res, 'http://offlist.test/pre-foreign');
      case '/prerender-same-site':
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><script type="speculationrules">' + JSON.stringify({ prerender: [{ urls: ['http://sub.allowed.test/pre-same-site'] }] }) + '</script>');
        return true;
      case '/prefetch-rules':
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><script type="speculationrules">' + JSON.stringify({ prefetch: [{ urls: ['http://offlist.test/pf-cross-site', 'http://sub.allowed.test/pf-same-site'] }] }) + '</script>');
        return true;
      case '/pre-same-site':
        res.setHeader('content-type', 'text/html');
        res.setHeader('Supports-Loading-Mode', 'credentialed-prerender');
        res.end('<!doctype html><title>PRERENDERTITLE</title>PRERENDERBODY');
        return true;
      case '/timer-worker.js': return script(res, "setInterval(() => fetch('/beacon?worker-timer').catch(() => {}), 50);");
      case '/cached':
        res.setHeader('content-type', 'text/html');
        res.setHeader('Cache-Control', 'max-age=3600');
        res.end('<!doctype html>from the cache');
        return true;
      case '/sw-import.js': res.setHeader('content-type', 'text/javascript'); res.end("importScripts('http://flip.test/imported.js');"); return true;
      case '/csp':
        res.setHeader('content-type', 'text/html');
        res.setHeader('Content-Security-Policy', "img-src 'none'; report-uri http://offlist.test/csp-report");
        res.end('<!doctype html><img src="/blocked.png">');
        return true;
      case '/redirect': return redirect(res, 'http://offlist.test/from-redirect');
      case '/redirect-marked': return redirect(res, 'http://offlist.test/MARKPATH?q=MARKQUERY');
      case '/redirect-https': return redirect(res, 'https://offlist.test/from-redirect-https');
      case '/redirect-private': return redirect(res, `http://127.0.0.1:${privPortRef.port}/from-redirect`);
      case '/redirect-self': return redirect(res, '/landed');
      case '/links':
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><a id=a href="/two">two</a> <a id=off href="http://offlist.test/link">off</a>');
        return true;
      default: return false;
    }
  });
  const offlist = await countingServer((path, res) => {
    if (path !== '/lib.js' && path !== '/imported.js') return false;
    res.setHeader('content-type', 'text/javascript');
    res.end('self.__lib = 1;');
    return true;
  });
  const privPortRef = { port: 0 };
  const priv = await countingServer();
  privPortRef.port = priv.port;
  let flip = PUBLIC_OFFLIST;
  const dns = new Map<string, string[]>([
    ['allowed.test', [PUBLIC_ALLOWED]], ['sub.allowed.test', [PUBLIC_ALLOWED]], ['other.test', [PUBLIC_ALLOWED]], ['offlist.test', [PUBLIC_OFFLIST]],
    ['alias.test', ['127.0.0.1']], ['alias6.test', ['::1']], ['mixed.test', [PUBLIC_OFFLIST, '127.0.0.1']],
  ]);
  const routes = new Map([[PUBLIC_ALLOWED, allowed.port], [PUBLIC_OFFLIST, offlist.port]]);
  const dials: { address: string; port: number }[] = [];
  const resolved: string[] = [];
  const network: ProxyNetwork = {
    resolve: async (name) => {
      resolved.push(name);
      if (name === 'flip.test') return [flip];
      const a = dns.get(name);
      if (!a) throw new Error('ENOTFOUND');
      return a;
    },
    dial: (address, port): Socket => {
      dials.push({ address, port });
      const to = routes.get(address);
      return to ? net.connect(to, '127.0.0.1') : net.connect(port, address);
    },
  };
  const consent = opts.consent ?? makeConsent(['http://allowed.test']);
  const proxy = await startEgressProxy({ consent, network });
  const bareDir = opts.bareProfile ? fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-relay-bare-')) : null;
  const browser = await launchForRelayTests({
    chromiumPath: CHROMIUM!, proxy,
    testArgs: [
      '--unsafely-treat-insecure-origin-as-secure=http://allowed.test,http://other.test,http://sub.allowed.test',
    ],
    ...(bareDir ? { bareProfileDir: bareDir } : {}),
  });
  await opts.beforePolicy?.(browser);
  const enforcer = await startRequestPolicy({ browser, consent });
  const lease = createTabLease();
  proxy.onClose(() => lease.revoke('egress-proxy-down'));
  lease.promote(lease.reserve()!, { expiresAt: Date.now() + 600_000 });
  const relay = createDeviceRelay({ tabWs: browser.tabWs, consent: opts.relayConsent ?? consent, lease, enforcer, pageEnd: opts.pageEnd ?? 'blank' });
  const http2 = http.createServer();
  const wss = new WebSocketServer({ server: http2 });
  const agentFrames: string[] = [];
  let nextRawId = 0;
  let serving: Promise<void> = Promise.resolve();
  let agentSocket!: WebSocket;
  wss.on('connection', (ws) => {
    const send = ws.send.bind(ws) as (d: string) => void;
    (ws as unknown as { send(d: string): void }).send = (d: string) => { agentFrames.push(d); send(d); };
    agentSocket = ws;
    serving = relay.serve(ws);
  });
  await new Promise<void>((r) => http2.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(http2.address() as AddressInfo).port}/`;
  // An agent is either Playwright or a plain socket, never both: frame ids rise per connection.
  let rawClient: WebSocket | null = null;
  const rawReplies = new Map<number, (m: never) => void>();
  let pwBrowser = null as unknown as PwBrowser;
  let page = null as unknown as PwPage;
  if (opts.raw) {
    rawClient = new WsClient(url);
    await new Promise((res) => rawClient!.once('open', res));
    rawClient.on('message', (d) => {
      const m = JSON.parse(String(d)) as { id?: number };
      if (m.id !== undefined) rawReplies.get(m.id)?.(m as never);
    });
  } else {
    pwBrowser = await pw.chromium.connectOverCDP(url);
    const ctx = pwBrowser.contexts()[0]!;
    page = ctx.pages()[0] ?? await ctx.waitForEvent('page', { timeout: 5000 });
  }
  const rig: Rig = {
    allowed, offlist, priv, proxy, browser, enforcer, lease, relay, consent, dials, resolved, agentFrames, page, pwBrowser,
    setFlip: (a) => { flip = a; },
    agent: { close: () => agentSocket.close(), send: (raw: string) => (rawClient ?? agentSocket).send(raw) },
    command(method: string, params: object = {}) {
      const id = (nextRawId += 1);
      return new Promise((resolve) => {
        rawReplies.set(id, resolve as never);
        rawClient!.send(JSON.stringify({ id, method, params, sessionId: 'cascade-tab-1' }));
      });
    },
    get serving() { return serving; },
    async stop() {
      if (pwBrowser) await pwBrowser.close().catch(() => {});
      rawClient?.close();
      enforcer.close();
      await browser.close();
      await proxy.close();
      http2.closeAllConnections(); http2.close();
      allowed.close(); offlist.close(); priv.close();
      if (bareDir) fs.rmSync(bareDir, { recursive: true, force: true });
    },
  } as Rig;
  rigs.push(rig);
  if (opts.raw) {
    await rig.command('Page.navigate', { url: 'http://allowed.test/' });
    await sleep(150);
  } else await page.goto('http://allowed.test/');
  return rig;
}
afterEach(async () => { for (const r of rigs.splice(0)) await r.stop().catch(() => {}); });

const tryFetch = (u: string) => `fetch(${JSON.stringify(u)}, { mode: 'no-cors' }).then(() => 'reached', () => 'failed')`;
const tryWs = (u: string) => new Promise<string>((res) => {
  const w = new (globalThis as unknown as { WebSocket: new (u: string) => { onopen: unknown; onerror: unknown } }).WebSocket(u);
  w.onopen = () => res('open');
  w.onerror = () => res('failed');
  setTimeout(() => res('timeout'), 1500);
});

suite('P1 in a real browser', { timeout: 60_000 }, () => {
  it('normal Playwright use hits no refusals, and refused methods never work', async () => {
    const r = await startRig();
    await r.page.goto('http://allowed.test/links');
    await r.page.click('#a');
    await r.page.evaluate('1 + 1');
    await sleep(100);
    expect(r.allowed.hits).toContain('GET /two');
    expect([...r.relay.refusedMethods].filter((m) => m !== 'Target.detachFromTarget')).toEqual([]);
  });
  it('refused methods get a refusal, and never reach the browser', async () => {
    const r = await startRig({ raw: true });
    for (const m of ['Emulation.setGeolocationOverride', 'Emulation.setUserAgentOverride', 'Fetch.disable', 'Network.getAllCookies', 'Storage.getCookies', 'Page.setDownloadBehavior']) {
      const res = await r.command(m);
      expect(res.error?.message, m).toContain('Denied by Cascade relay policy');
    }
  });
  it('a file: navigation is refused by the relay', async () => {
    const r = await startRig();
    await expect(r.page.goto('file:///etc/hostname')).rejects.toThrow();
    expect(r.relay.refusals.join()).toContain('Page.navigate to file:');
  });
});

suite('P2: no request reaches a destination without consent', { timeout: 90_000 }, () => {
  it('control: with no policy, the same attempts do reach the servers', async () => {
    const off = await countingServer();
    const b = await pw.chromium.launch({ executablePath: CHROMIUM!, args: [`--host-resolver-rules=MAP offlist.test 127.0.0.1:${off.port}`, '--no-sandbox', '--no-proxy-server'] });
    try {
      const p = await b.newPage();
      await p.goto(`http://127.0.0.1:${off.port}/`);
      await p.evaluate(`${tryFetch(`http://127.0.0.1:${off.port}/fetch`)}`);
      await p.goto('http://offlist.test/nav');
      await sleep(100);
      expect(off.hits.some((h) => h.includes('/fetch'))).toBe(true);
      expect(off.hits.some((h) => h.includes('/nav'))).toBe(true);
    } finally { await b.close(); off.close(); }
  });

  it('agent navigation, link, script, form, redirects and iframe: 0 at the off-list server', async () => {
    const r = await startRig();
    const p = r.page;
    const offHits = () => r.offlist.hits.filter((h) => !h.includes('/lib.js'));
    await p.goto('http://offlist.test/agent').catch(() => {});
    await p.goto('http://allowed.test/links');
    await p.click('#off', { noWaitAfter: true }).catch(() => {});
    await sleep(200);
    await p.goto('http://allowed.test/');
    await p.evaluate("location.href = 'http://offlist.test/script'").catch(() => {});
    await sleep(200);
    await p.goto('http://allowed.test/');
    await p.evaluate("(() => { const f = document.createElement('form'); f.method = 'POST'; f.action = 'http://offlist.test/form'; document.body.append(f); f.submit(); })()").catch(() => {});
    await sleep(200);
    await p.goto('http://allowed.test/redirect').catch(() => {});
    await p.goto('http://allowed.test/redirect-https').catch(() => {});
    await p.goto('http://allowed.test/');
    await p.evaluate("(() => { const f = document.createElement('iframe'); f.src = 'http://offlist.test/frame'; document.body.append(f); })()");
    await sleep(300);
    expect(offHits()).toEqual([]);
    // The redirect's first hop is on the consented server, so the test really redirected.
    expect(r.allowed.hits).toContain('GET /redirect');
    expect(r.allowed.hits).toContain('GET /redirect-https');
    expect(r.offlist.accepts).toBe(0);
  });

  it('a redirect within the consented origin still works', async () => {
    const r = await startRig();
    await r.page.goto('http://allowed.test/redirect-self');
    expect(r.page.url()).toBe('http://allowed.test/landed');
  });

  it('a redirect from a consented site to a private address: 0 at the private server', async () => {
    const r = await startRig();
    await r.page.goto('http://allowed.test/redirect-private').catch(() => {});
    await sleep(100);
    expect(r.priv.accepts).toBe(0);
  });

  it('a blocked redirect leaves no error page holding its URL, in the tab or an iframe', async () => {
    // Chromium's error page for a blocked navigation keeps the URL it was refused, query
    // included, and any allowed script could read it. A blocked document is aborted
    // instead, so no error page commits and the frame keeps what it had.
    const r = await startRig();
    const p = r.page;
    const read = async (): Promise<string> => (await Promise.all(p.frames().map((f) => f.evaluate(
      () => `${location.href} ${document.documentElement.outerHTML}`,
    ).catch((e: Error) => `unreadable ${e.message}`)))).join('\n');
    await p.goto('http://allowed.test/');
    await p.goto('http://allowed.test/redirect-marked').catch(() => {});
    await p.goto('http://allowed.test/redirect-private').catch(() => {});
    await sleep(200);
    const tabText = await read();
    await p.goto('http://allowed.test/');
    await p.evaluate("(() => { for (const u of ['/redirect-marked', '/redirect-private']) { const f = document.createElement('iframe'); f.src = u; document.body.append(f); } })()");
    await sleep(400);
    const frameText = await read();
    expect(r.allowed.hits.filter((h) => h === 'GET /redirect-marked'), 'the redirects ran').toHaveLength(2);
    expect(p.frames().length, 'the iframes are there to read').toBe(3);
    for (const text of [tabText, frameText]) {
      expect(text).not.toMatch(/MARKPATH|MARKQUERY|from-redirect|chrome-error/);
    }
    expect(r.offlist.accepts).toBe(0);
    expect(r.priv.accepts).toBe(0);
  });

  it('private destinations: 0 TCP accepts, by every route from the page', async () => {
    const r = await startRig();
    const port = r.priv.port;
    for (const u of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://[::ffff:7f00:1]:${port}/`]) {
      expect(await r.page.evaluate(tryFetch(u)), u).toBe('failed');
    }
    for (const u of [`ws://127.0.0.1:${port}/`, `wss://127.0.0.1:${port}/`, `ws://[::ffff:127.0.0.1]:${port}/`]) {
      expect(await r.page.evaluate(tryWs as never, u), u).not.toBe('open');
    }
    expect(r.priv.accepts).toBe(0);
    expect(r.proxy.decisions.some((d) => d.kind === 'connect' && !d.allowed)).toBe(true);
  });

  it('a confirmed private http origin loads, but a ws: to it is a CONNECT the proxy refuses', async () => {
    const mine = await countingServer();
    const r = await startRig({ consent: makeConsent(['http://allowed.test'], [`http://127.0.0.1:${mine.port}`]) });
    try {
      await r.page.goto(`http://127.0.0.1:${mine.port}/page`);
      expect(mine.hits, 'control: the confirmed origin is reachable through the proxy').toContain('GET /page');
      expect(await r.page.evaluate(tryWs as never, `ws://127.0.0.1:${mine.port}/ws`)).not.toBe('open');
      await sleep(200);
      const tunnels = r.proxy.decisions.filter((d) => d.kind === 'connect' && d.port === String(mine.port));
      // Chromium tunnels a plain ws: through an http proxy, and a confirmed http: origin doesn't cover a tunnel.
      expect(tunnels.length, 'the ws: reached the proxy as a CONNECT').toBeGreaterThan(0);
      expect(tunnels.every((d) => !d.allowed && d.reason === 'private-network destination')).toBe(true);
      expect(mine.hits.filter((h) => h.includes('/ws'))).toEqual([]);
    } finally { mine.close(); }
  });

  it('DNS: an alias, a mixed answer and a rebinding answer never reach a private address', async () => {
    const r = await startRig();
    const port = r.priv.port;
    for (const host of ['alias.test', 'mixed.test', 'alias6.test']) {
      // The proxy answers 403 itself, which a no-cors fetch can't tell from a reply;
      // what matters is below, at the private server.
      await r.page.evaluate(tryFetch(`http://${host}:${port}/`));
      expect(await r.page.evaluate(tryWs as never, `ws://${host}:${port}/`), host).not.toBe('open');
    }
    expect(r.priv.accepts).toBe(0);
    expect(r.dials.some((d) => d.address === '127.0.0.1' || d.address === '::1')).toBe(false);
    // Rebinding: public on the first connection, private on the next.
    expect(await r.page.evaluate(tryFetch('http://flip.test/first'))).toBe('reached');
    r.setFlip('127.0.0.1');
    await r.page.evaluate(tryFetch(`http://flip.test:${port}/second`));
    expect(r.priv.accepts).toBe(0);
    expect(r.dials.filter((d) => d.address === '127.0.0.1')).toEqual([]);
  });

  it('IPv6: a real server on ::1 gets 0 accepts through the relay, and is reached by the control', async (ctx) => {
    const six = await countingServer(() => false, '::1').catch((e: NodeJS.ErrnoException) => {
      // Some sandboxes have no IPv6 at all. CI must, or this gate would silently vanish.
      if (e.code === 'EAFNOSUPPORT' && !process.env.CI) return null;
      throw e;
    });
    if (!six) return ctx.skip();
    const literal = `http://[::1]:${six.port}/`;
    const b = await pw.chromium.launch({ executablePath: CHROMIUM!, args: ['--no-sandbox', '--no-proxy-server'] });
    const control = await b.newPage();
    await control.goto(literal);
    await b.close();
    expect(six.accepts, 'control: with no proxy the server is reachable').toBeGreaterThan(0);
    const before = six.accepts;

    const r = await startRig();
    expect(await r.page.evaluate(tryFetch(literal))).toBe('failed');
    expect(await r.page.evaluate(tryWs as never, `ws://[::1]:${six.port}/`)).not.toBe('open');
    await r.page.evaluate(tryFetch(`http://alias6.test:${six.port}/`));
    expect(await r.page.evaluate(tryWs as never, `ws://alias6.test:${six.port}/`)).not.toBe('open');
    await r.page.evaluate(((u: string) => { const f = document.createElement('iframe'); f.src = u; document.body.append(f); }) as never, literal);
    await sleep(200);
    expect(six.accepts).toBe(before);
    expect(r.dials.some((d) => d.address === '::1')).toBe(false);
    six.close();
  });

  it('a public subresource still loads: the stated limit, with its query kept from the agent', async () => {
    const r = await startRig();
    await r.page.evaluate("new Promise((res) => { const s = document.createElement('script'); s.src = 'http://offlist.test/lib.js?token=SUBRESOURCE-TOKEN'; s.onload = res; s.onerror = res; document.head.append(s); })");
    expect(r.offlist.hits.some((h) => h.includes('/lib.js'))).toBe(true);
    expect(r.agentFrames.join()).not.toContain('SUBRESOURCE-TOKEN');
  });

  it('workers stay inside the policy, and still reach the consented origin', async () => {
    const r = await startRig();
    const port = r.priv.port;
    await r.page.evaluate(`(() => {
      const code = 'fetch("http://127.0.0.1:${port}/from-worker", { mode: "no-cors" }).catch(() => {}); try { new WebSocket("ws://127.0.0.1:${port}/ws-from-worker"); } catch {}';
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      window.__d = new Worker(url);
      window.__s = new SharedWorker(url);
    })()`);
    await r.page.evaluate("new Worker('/worker.js')");
    await r.page.evaluate("navigator.serviceWorker.register('/sw.js').catch(() => {})");
    await sleep(800);
    expect(r.priv.accepts).toBe(0);
    expect(r.allowed.hits.filter((h) => h.includes('/beacon?ran')).length).toBeGreaterThan(0);
  });

  it('the request policy itself blocks what each worker type sends, not only the proxy', async () => {
    const r = await startRig();
    const port = r.priv.port;
    const url = `http://127.0.0.1:${port}/`;
    const targets = { dedicated: 'dedicated-marker', shared: 'shared-marker', service: 'service-marker' };
    await r.page.evaluate(((a: { url: string; t: typeof targets }) => {
      const code = (m: string) => `fetch(${JSON.stringify(a.url + m)}, { mode: 'no-cors' }).catch(() => {});`;
      const blob = (m: string) => URL.createObjectURL(new Blob([code(m)], { type: 'text/javascript' }));
      (globalThis as never as { __k: unknown[] }).__k = [new Worker(blob(a.t.dedicated)), new SharedWorker(blob(a.t.shared))];
    }) as never, { url, t: targets });
    await r.page.evaluate(`navigator.serviceWorker.register('/sw-private.js?u=' + ${JSON.stringify(encodeURIComponent(`${url}${targets.service}`))}).catch(() => {})`);
    await sleep(900);
    expect(r.priv.accepts).toBe(0);
    for (const marker of Object.values(targets)) {
      const hit = r.enforcer.decisions.find((d) => d.url === `${url}${marker}`);
      expect(hit, `${marker} reached the policy`).toBeDefined();
      expect(hit!.allowed, marker).toBe(false);
    }
    expect(r.enforcer.children.every((c) => c.coverage !== null), JSON.stringify(r.enforcer.children)).toBe(true);
    const types = new Set(r.enforcer.children.map((c) => c.type));
    for (const t of ['worker', 'shared_worker', 'service_worker']) expect(types.has(t), t).toBe(true);
  });

  it('a new page is closed, and sends nothing, including a burst', async () => {
    const r = await startRig();
    await r.page.evaluate("for (let i = 0; i < 10; i++) window.open('http://offlist.test/popup' + i)");
    await r.page.evaluate("window.open('http://offlist.test/noopener', '_blank', 'noopener')");
    await sleep(800);
    expect(r.offlist.hits.filter((h) => h.includes('popup') || h.includes('noopener'))).toEqual([]);
    const list = await (await fetch(`http://127.0.0.1:${r.browser.port}/json/list`)).json() as { type: string }[];
    expect(list.filter((t) => t.type === 'page')).toHaveLength(1);
    expect(r.enforcer.closedPages.length).toBeGreaterThan(0);
  });

  it('UDP: WebRTC, QUIC and WebTransport send nothing past the proxy', async () => {
    const r = await startRig();
    const udp = await udpCounter();
    try {
      await r.page.evaluate(`(async () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udp.port}' }, { urls: 'turn:127.0.0.1:${udp.port}?transport=udp', username: 'u', credential: 'c' }] });
        pc.createDataChannel('x');
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((res) => setTimeout(res, 1200));
        pc.close();
        try { const t = new WebTransport('https://127.0.0.1:${udp.port}/'); t.ready.catch(() => {}); t.closed.catch(() => {}); } catch {}
        const url = URL.createObjectURL(new Blob(['try { const t = new WebTransport("https://127.0.0.1:${udp.port}/"); t.ready.catch(() => {}); t.closed.catch(() => {}); } catch {}'], { type: 'text/javascript' }));
        window.__w = new Worker(url);
        window.__sw = new SharedWorker(url);
      })()`);
      await sleep(1000);
      expect(udp.count()).toBe(0);
    } finally { udp.close(); }
  });

  const turn = (p: PwPage, url: string) => p.evaluate(`(async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(url)}, username: 'u', credential: 'c' }], iceTransportPolicy: 'relay' });
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((res) => setTimeout(res, 1200));
    pc.close();
  })()`);
  const tcpCounter = () => new Promise<{ count(): number; port: number; close(): void }>((resolve) => {
    let n = 0;
    const s = net.createServer((c) => { n += 1; c.on('error', () => {}); c.destroy(); });
    s.listen(0, '127.0.0.1', () => resolve({ count: () => n, port: (s.address() as AddressInfo).port, close: () => s.close() }));
  });

  it('control: with no proxy, TURN and forced QUIC do reach the sockets', async () => {
    const udp = await udpCounter(); const tcp = await tcpCounter(); const quic = await udpCounter();
    const pageSrv = await countingServer();
    const b = await pw.chromium.launch({ executablePath: CHROMIUM!, args: ['--no-sandbox', '--no-proxy-server', '--enable-quic', `--origin-to-force-quic-on=127.0.0.1:${quic.port}`] });
    try {
      const p = await b.newPage();
      await p.goto(`http://127.0.0.1:${pageSrv.port}/`);
      await turn(p, `turn:127.0.0.1:${udp.port}?transport=udp`);
      await turn(p, `turn:127.0.0.1:${tcp.port}?transport=tcp`);
      await p.evaluate(tryFetch(`https://127.0.0.1:${quic.port}/`));
      await sleep(400);
      expect(udp.count()).toBeGreaterThan(0);
      expect(tcp.count()).toBeGreaterThan(0);
      expect(quic.count()).toBeGreaterThan(0);
    } finally { await b.close(); udp.close(); tcp.close(); quic.close(); pageSrv.close(); }
  });
  it('TURN over UDP and TCP stay inside the proxy', async () => {
    const r = await startRig();
    const udp = await udpCounter(); const tcp = await tcpCounter();
    try {
      await turn(r.page, `turn:127.0.0.1:${udp.port}?transport=udp`);
      await turn(r.page, `turn:127.0.0.1:${tcp.port}?transport=tcp`);
      expect(udp.count()).toBe(0);
      expect(tcp.count()).toBe(0);
    } finally { udp.close(); tcp.close(); }
  });
  it('forced QUIC stays inside the proxy', async () => {
    const quic = await udpCounter();
    const consent = makeConsent(['http://allowed.test']);
    const proxy = await startEgressProxy({ consent });
    const browser = await launchForRelayTests({ chromiumPath: CHROMIUM!, proxy, testArgs: ['--enable-quic', `--origin-to-force-quic-on=127.0.0.1:${quic.port}`] });
    const raw = await connectCdp(browser.tabWs);
    try {
      await raw.send('Runtime.evaluate', { expression: tryFetch(`https://127.0.0.1:${quic.port}/`), awaitPromise: true });
      await sleep(400);
      expect(quic.count()).toBe(0);
    } finally { raw.close(); await browser.close(); await proxy.close(); quic.close(); }
  });
  it('control: with no proxy, WebRTC and WebTransport do send UDP', async () => {
    const udp = await udpCounter();
    const pageSrv = await countingServer();
    const b = await pw.chromium.launch({ executablePath: CHROMIUM!, args: ['--no-sandbox', '--no-proxy-server'] });
    try {
      const p = await b.newPage();
      await p.goto(`http://127.0.0.1:${pageSrv.port}/`);
      await p.evaluate(`(async () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udp.port}' }] });
        pc.createDataChannel('x');
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((res) => setTimeout(res, 800));
        pc.close();
      })()`);
      const stun = udp.count();
      expect(stun).toBeGreaterThan(0);
      await p.evaluate(`(() => { try { const t = new WebTransport('https://127.0.0.1:${udp.port}/'); t.ready.catch(() => {}); t.closed.catch(() => {}); } catch {} })()`);
      await sleep(800);
      expect(udp.count()).toBeGreaterThan(stun);
    } finally { await b.close(); udp.close(); pageSrv.close(); }
  });
});

/**
 * An https server that advertises HTTP/3 on a UDP socket which only counts, with a
 * certificate from a CA trusted in a throwaway browser home. With a self-signed
 * certificate and --ignore-certificate-errors, Chromium 1243 sent nothing, so the
 * control couldn't have detected a leak. Needs openssl and certutil.
 */
function altSvcServer(udpPort: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-altsvc-'));
  const f = (n: string) => path.join(dir, n);
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'ignore', cwd: dir });
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  run('openssl', ['req', '-x509', ...ec, '-days', '1', '-subj', '/CN=Relay Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', 'ca.key', '-out', 'ca.pem']);
  run('openssl', ['req', ...ec, '-subj', '/CN=h3.test', '-keyout', 'k.pem', '-out', 'c.csr']);
  fs.writeFileSync(f('ext'), 'subjectAltName=DNS:h3.test\n');
  run('openssl', ['x509', '-req', '-in', 'c.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ext', '-out', 'c.pem']);
  const nss = path.join(dir, 'home', '.pki', 'nssdb');
  fs.mkdirSync(nss, { recursive: true });
  run('certutil', ['-d', `sql:${nss}`, '-N', '--empty-password']);
  run('certutil', ['-d', `sql:${nss}`, '-A', '-t', 'C,,', '-n', 'relay-test', '-i', 'ca.pem']);
  let hits = 0;
  const server = https.createServer({ key: fs.readFileSync(f('k.pem')), cert: fs.readFileSync(f('c.pem')) }, (_q, res) => {
    hits += 1;
    res.setHeader('alt-svc', `h3=":${udpPort}"; ma=3600`);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html>page');
  });
  const handle = {
    port: 0, hits: () => hits, env: { ...process.env, HOME: path.join(dir, 'home') },
    close() { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    ready: Promise.resolve(),
  };
  handle.ready = new Promise((r) => server.listen(0, '127.0.0.1', () => { handle.port = (server.address() as AddressInfo).port; r(); }));
  return handle;
}
const hasCertTools = (() => { try { execFileSync('certutil', ['-H'], { stdio: 'ignore' }); return true; } catch (e) { return (e as { code?: string }).code !== 'ENOENT'; } })();
if (CHROMIUM && !hasCertTools && process.env.CI) throw new Error('The Alt-Svc tests need certutil on CI (libnss3-tools).');

(hasCertTools ? suite : describe.skip)('P2: an Alt-Svc upgrade to HTTP/3', { timeout: 60_000 }, () => {
  const visit = async (p: PwPage, url: string) => {
    for (let i = 0; i < 5; i++) { await p.goto(url, { timeout: 3000 }).catch(() => {}); await sleep(300); }
  };
  it('control: with no proxy, the browser does try HTTP/3 after the header', async () => {
    const udp = await udpCounter();
    const srv = altSvcServer(udp.port);
    await srv.ready;
    const b = await pw.chromium.launch({ executablePath: CHROMIUM!, env: srv.env, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP h3.test 127.0.0.1'] });
    try {
      await visit(await b.newPage(), `https://h3.test:${srv.port}/`);
      expect(srv.hits()).toBeGreaterThan(0);
      expect(udp.count()).toBeGreaterThan(0);
    } finally { await b.close(); udp.close(); srv.close(); }
  });
  it('behind the proxy, the same header sends nothing to the UDP socket', async () => {
    const udp = await udpCounter();
    const srv = altSvcServer(udp.port);
    await srv.ready;
    const consent = makeConsent([`https://h3.test:${srv.port}`]);
    const proxy = await startEgressProxy({
      consent,
      network: { resolve: async () => ['203.0.113.30'], dial: () => net.connect(srv.port, '127.0.0.1') },
    });
    const browser = await launchForRelayTests({ chromiumPath: CHROMIUM!, proxy, env: srv.env });
    browser.openEgress();
    const pb = await pw.chromium.connectOverCDP(`http://127.0.0.1:${browser.port}`);
    try {
      await visit(pb.contexts()[0]!.pages()[0]!, `https://h3.test:${srv.port}/`);
      expect(srv.hits(), 'the page really loaded over the proxy').toBeGreaterThan(0);
      expect(udp.count()).toBe(0);
    } finally { await pb.close().catch(() => {}); await browser.close(); await proxy.close(); udp.close(); srv.close(); }
  });
});

suite('fail closed when the proxy is unavailable', { timeout: 60_000 }, () => {
  it('a browser whose traffic does not reach the proxy is never usable', async () => {
    const proxy = await startEgressProxy({ consent: makeConsent(['http://allowed.test']) });
    const fake = { ...proxy, canaryUrl: () => 'http://cascade-egress-canary.invalid/never-registered', canarySeen: () => false, port: proxy.port };
    await expect(launchBehindProxy({ chromiumPath: CHROMIUM!, proxy: fake, canaryTimeoutMs: 400 })).rejects.toThrow(/canary/);
    await proxy.close();
  });
  it('the proxy dying mid-lease revokes it, and nothing connects directly', async () => {
    const r = await startRig();
    const port = r.priv.port;
    await r.proxy.close();
    await sleep(100);
    expect(r.lease.state()).toBe('idle');
    await r.serving;
    expect(r.relay.refusals.join()).toContain('egress-proxy-down');
    const raw = await connectCdp(r.browser.tabWs);
    await raw.send('Runtime.evaluate', { expression: tryFetch(`http://127.0.0.1:${port}/after`), awaitPromise: true }).catch(() => {});
    raw.close();
    expect(r.priv.accepts).toBe(0);
  });
});

suite('no-leak markers: nothing forbidden reaches the agent', { timeout: 60_000 }, () => {
  it('blocked URLs, credentials, cookies and bodies stay out of every frame', async () => {
    const r = await startRig();
    const M = { path: 'MARKPATH', query: 'MARKQUERY', frag: 'MARKFRAG', user: 'MARKUSER', cookie: 'MARKCOOKIE', auth: 'MARKAUTH', body: 'MARKBODY' };
    const raw = await connectCdp(r.browser.tabWs);
    const rawFrames: string[] = [];
    raw.on((m) => rawFrames.push(JSON.stringify(m)));
    await raw.send('Network.enable');
    await raw.send('Page.enable');
    const blockedUrl = `http://offlist.test/${M.path}?q=${M.query}#${M.frag}`;
    const privUrl = `http://${M.user}:pw@127.0.0.1:${r.priv.port}/${M.path}?q=${M.query}`;
    const p = r.page;
    await p.goto(blockedUrl).catch(() => {});
    await p.goto('http://allowed.test/');
    await p.evaluate(`document.cookie = '${M.cookie}=1'`);
    await p.evaluate(`fetch('/echo', { method: 'POST', body: '${M.body}', headers: { Authorization: '${M.auth}', 'X-Marker': '${M.auth}' } })`);
    await p.evaluate(tryFetch(privUrl));
    await p.evaluate(((u: string) => { window.open(u); }) as never, blockedUrl);
    await p.evaluate(tryWs as never, `ws://127.0.0.1:${r.priv.port}/${M.path}`);
    await p.evaluate(((u: string) => { location.href = u; }) as never, blockedUrl).catch(() => {});
    await sleep(300);
    await p.goto('http://allowed.test/').catch(() => {});
    await p.evaluate(((u: string) => { const f = document.createElement('iframe'); f.src = u; document.body.append(f); }) as never, blockedUrl);
    await p.goto('http://allowed.test/redirect-marked').catch(() => {});
    await sleep(400);
    raw.close();
    const agent = r.agentFrames.filter((f) => !/"result":\{"(result|exceptionDetails)"/.test(f)).join('\n');
    // Control: these did cross the browser's own event stream, so the filter did the work.
    const seenRaw = rawFrames.join('\n');
    for (const m of [M.path, M.body, M.auth]) expect(seenRaw, `control ${m}`).toContain(m);
    for (const [name, m] of Object.entries(M)) expect(agent.includes(m), `${name} reached the agent`).toBe(false);
  });
});

suite('no-leak markers: page-controlled text, root and child sessions', { timeout: 60_000 }, () => {
  it('title, window.name and fragments never reach the agent, from the tab or a child', async () => {
    const consent = makeConsent(['http://allowed.test', 'http://other.test']);
    const r = await startRig({ consent });
    const raw = await connectCdp(r.browser.browserWs);
    const rawFrames: string[] = [];
    raw.on((m) => rawFrames.push(JSON.stringify(m)));
    await raw.send('Target.setDiscoverTargets', { discover: true });
    const p = r.page;
    await p.goto('http://allowed.test/');
    await p.evaluate("document.title = 'MARKTITLE'; window.name = 'MARKNAME'; history.replaceState(null, '', '#keep');");
    // Cross-site, so it's an out-of-process frame with its own session.
    await p.evaluate("(() => { const f = document.createElement('iframe'); f.name = 'MARKFRAMENAME'; f.src = 'http://other.test/child'; document.body.append(f); return new Promise((res) => { f.onload = res; }); })()");
    await sleep(300);
    await p.goto('http://allowed.test/page#MARKFRAGMENT');
    await sleep(200);
    raw.close();
    expect(rawFrames.join('\n'), 'control: the browser did emit the title').toContain('MARKTITLE');
    const stream = r.agentFrames.filter((f) => !/"result":\{"(result|exceptionDetails)"/.test(f));
    expect(stream.some((f) => /"sessionId":"(?!cascade-tab-1)/.test(f)), 'a child session really was served').toBe(true);
    const joined = stream.join('\n');
    for (const m of ['MARKTITLE', 'MARKNAME', 'MARKFRAMENAME']) expect(joined.includes(m), m).toBe(false);
    // A consented URL keeps its fragment by the URL rule; the separate field is gone.
    expect(joined).not.toContain('urlFragment');
    expect(joined).not.toContain('"title"');
  });
});

suite('dialogs', { timeout: 30_000 }, () => {
  it('the device dismisses them, and the agent sees no dialog', async () => {
    const r = await startRig();
    expect(await r.page.evaluate("[String(alert('x')), confirm('y'), prompt('z')]")).toEqual(['undefined', false, null]);
    expect(r.enforcer.dismissedDialogs).toEqual(['alert', 'confirm', 'prompt']);
    expect(r.agentFrames.join()).not.toContain('javascriptDialog');
  });
});

suite('R-A2: history over the relay', { timeout: 30_000 }, () => {
  it('back and forward commit, with the back-forward cache on', async () => {
    const r = await startRig();
    await r.page.goto('http://allowed.test/one');
    await r.page.goto('http://allowed.test/two');
    await navigateHistory(r.page, -1);
    expect(r.page.url()).toBe('http://allowed.test/one');
    await navigateHistory(r.page, 1);
    expect(r.page.url()).toBe('http://allowed.test/two');
  });
  it('a blocked navigation leaves no history entry', async () => {
    const r = await startRig({ raw: true });
    await r.command('Page.navigate', { url: 'http://allowed.test/one' });
    await sleep(150);
    const before = (await r.command('Page.getNavigationHistory')).result;
    await r.command('Page.navigate', { url: 'http://offlist.test/blocked' });
    await sleep(150);
    const after = (await r.command('Page.getNavigationHistory')).result as { currentIndex: number; entries: { url: string }[] };
    expect(after).toEqual(before);
    expect(after.entries[after.currentIndex]!.url).toBe('http://allowed.test/one');
    expect(r.offlist.accepts).toBe(0);
  });
  it('a history entry on a site without consent is hidden and refused', async () => {
    // Blocked navigations no longer leave entries, so this one comes from a network policy
    // wider than the relay's consent: the relay's own check is what's under test.
    const r = await startRig({ raw: true, consent: makeConsent(['http://allowed.test', 'http://offlist.test']), relayConsent: makeConsent(['http://allowed.test']) });
    await r.command('Page.navigate', { url: 'http://allowed.test/one' });
    await sleep(150);
    await r.command('Page.navigate', { url: 'http://offlist.test/elsewhere' });
    await sleep(150);
    await r.command('Page.navigate', { url: 'http://allowed.test/two' });
    await sleep(150);
    const h = (await r.command('Page.getNavigationHistory')).result as { entries: { id: number; url: string }[] };
    expect(JSON.stringify(h)).not.toContain('offlist.test');
    const hidden = h.entries.find((e) => e.url.includes('not-consented'));
    expect(hidden, 'the entry is there, hidden').toBeDefined();
    expect((await r.command('Page.navigateToHistoryEntry', { entryId: hidden!.id })).error?.message).toContain('not on a consented site');
  });
});

// The tab's past, as a user's tab or an earlier lease leaves it: a page on another site,
// held in the back-forward cache, then a consented page in front of it.
async function foreignHistoryRig(opts: { stayOnForeign?: boolean; wrap?: (e: RequestEnforcer) => RequestEnforcer } = {}) {
  const server = await countingServer();
  const wide = makeConsent(['http://allowed.test', 'http://offlist.test']);
  const consent = makeConsent(['http://allowed.test']);
  const proxy = await startEgressProxy({ consent: wide, network: { resolve: async () => [PUBLIC_ALLOWED], dial: () => net.connect(server.port, '127.0.0.1') } });
  const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
  browser.openEgress(); // This setup runs before any policy.
  const raw = await connectCdp(browser.tabWs);
  await raw.send('Page.enable');
  await raw.send('Page.navigate', { url: 'http://offlist.test/secret' });
  await sleep(400);
  await raw.send('Runtime.evaluate', { expression: "window.__secret = 'MARKSTATE'" });
  if (!opts.stayOnForeign) {
    await raw.send('Page.navigate', { url: 'http://allowed.test/front' });
    await sleep(400);
  }
  const started = await startRequestPolicy({ browser, consent });
  const enforcer = opts.wrap ? opts.wrap(started) : started;
  const lease = createTabLease();
  lease.promote(lease.reserve()!, { expiresAt: Date.now() + 600_000 });
  const relay = createDeviceRelay({ tabWs: browser.tabWs, consent, lease, enforcer, pageEnd: 'blank' });
  const http2 = http.createServer();
  const wss = new WebSocketServer({ server: http2 });
  let serving: Promise<void> = Promise.resolve();
  wss.on('connection', (ws) => { serving = relay.serve(ws); });
  await new Promise<void>((r) => http2.listen(0, '127.0.0.1', r));
  const agent = new WsClient(`ws://127.0.0.1:${(http2.address() as AddressInfo).port}/`);
  const frames: string[] = [];
  const replies = new Map<number, (m: Record<string, never>) => void>();
  agent.on('message', (d) => {
    frames.push(String(d));
    const m = JSON.parse(String(d)) as Record<string, never> & { id?: number };
    if (m.id !== undefined) replies.get(m.id)?.(m);
  });
  await new Promise((res) => agent.once('open', res));
  let id = 0;
  const command = (method: string, params: object = {}) => new Promise<{ result?: { result?: { value?: unknown } }; error?: { message: string } }>((resolve) => {
    id += 1;
    replies.set(id, resolve as never);
    agent.once('close', () => resolve({ error: { message: 'closed' } }));
    agent.send(JSON.stringify({ id, method, params, sessionId: 'cascade-tab-1' }));
  });
  return {
    server, raw, browser, lease, relay, frames, command, agent, get serving() { return serving; },
    async stop() {
      agent.close(); raw.close(); started.close();
      await browser.close(); await proxy.close();
      http2.closeAllConnections(); http2.close(); server.close();
    },
  };
}

suite('a page the back-forward cache could restore', { timeout: 60_000 }, () => {
  const READ = { expression: "location.href + ' ' + window.__secret", returnByValue: true };
  const keepHistory = (e: RequestEnforcer): RequestEnforcer => ({ ...e, clearForeignHistory: async () => true });

  it('control: with both guards off, script goes back and the agent reads the old page, with no request sent', async () => {
    const r = await foreignHistoryRig({ wrap: (e) => ({ ...keepHistory(e), onForeignDocument: () => {} }) });
    try {
      await r.command('Runtime.enable');
      const before = r.server.hits.length;
      await r.command('Runtime.evaluate', { expression: 'history.back(); 1' });
      await sleep(800);
      expect((await r.command('Runtime.evaluate', READ)).result?.result?.value).toBe('http://offlist.test/secret MARKSTATE');
      expect(r.server.hits.length).toBe(before);
    } finally { await r.stop(); }
  });

  it('the history is cleared first, so script going back goes nowhere', async () => {
    const r = await foreignHistoryRig();
    try {
      await r.command('Runtime.enable');
      await r.command('Runtime.evaluate', { expression: 'history.back(); 1' });
      await sleep(800);
      const read = await r.command('Runtime.evaluate', READ);
      expect(read.result?.result?.value).toBe('http://allowed.test/front undefined');
      expect(r.lease.state()).toBe('held');
      expect(r.frames.join()).not.toContain('MARKSTATE');
    } finally { await r.stop(); }
  });

  it('a page without consent showing anyway ends the lease and leaves it', async () => {
    const r = await foreignHistoryRig({ wrap: keepHistory });
    try {
      await r.command('Runtime.enable');
      await r.command('Runtime.evaluate', { expression: 'history.back(); 1' });
      await r.serving;
      expect(r.lease.state()).toBe('idle');
      expect(r.relay.refusals.join()).toContain('without consent');
      expect(r.frames.join()).not.toContain('MARKSTATE');
      await sleep(300);
      const info = await r.raw.send('Target.getTargetInfo') as { targetInfo: { url: string } };
      expect(info.targetInfo.url).toBe('about:blank');
    } finally { await r.stop(); }
  });

  it('a tab already on a page without consent is never served, whatever the caller checked', async () => {
    const r = await foreignHistoryRig({ stayOnForeign: true });
    try {
      const read = await r.command('Runtime.evaluate', READ);
      expect(read.result).toBeUndefined();
      await r.serving;
      expect(r.lease.state()).toBe('idle');
      expect(r.relay.refusals.join()).toContain('site without consent');
      expect(r.frames.join()).not.toContain('MARKSTATE');
    } finally { await r.stop(); }
  });
});

suite('beforeunload', { timeout: 30_000 }, () => {
  it('does not hold a page open through a revoke, and the revoke finishes in bounded time', async () => {
    const r = await startRig({ pageEnd: 'blank' });
    await r.page.goto('http://allowed.test/links');
    await r.page.evaluate("window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'x'; }); window.__t = setInterval(() => fetch('/beacon?unload-timer').catch(() => {}), 50);");
    // Chromium only shows this dialog after a user gesture.
    await r.page.click('#a', { noWaitAfter: true, trial: true });
    await r.page.mouse.click(300, 300);
    await sleep(100);
    const t0 = Date.now();
    r.lease.revoke('stop');
    await r.serving;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.enforcer.dismissedDialogs).toContain('beforeunload');
    await sleep(100);
    const hits = () => r.allowed.hits.filter((h) => h.includes('unload-timer')).length;
    const after = hits();
    await sleep(300);
    expect(hits()).toBe(after);
    const raw = await connectCdp(r.browser.tabWs);
    const info = await raw.send('Target.getTargetInfo') as { targetInfo: { url: string } };
    raw.close();
    expect(info.targetInfo.url).toBe('about:blank');
  });
});

suite('isolation from what the lease did not start', { timeout: 60_000 }, () => {
  // A browser where something started before the policy did, at a server that counts.
  const withEarlyWorker = async (start: string): Promise<{ browser: LaunchedBrowser; hits: () => number; consent: Consent; stop(): Promise<void> }> => {
    const site = await countingServer((path, res) => {
      if (path !== '/early-worker.js') return false;
      res.setHeader('content-type', 'text/javascript');
      res.end("setInterval(() => fetch('/beacon?early').catch(() => {}), 50);");
      return true;
    });
    const consent = makeConsent(['http://allowed.test']);
    const proxy = await startEgressProxy({ consent, network: { resolve: async () => [PUBLIC_ALLOWED], dial: () => net.connect(site.port, '127.0.0.1') } });
    const browser = await launchForRelayTests({ chromiumPath: CHROMIUM!, proxy, testArgs: ['--unsafely-treat-insecure-origin-as-secure=http://allowed.test'] });
    browser.openEgress(); // The worker has to start before any policy, as it could in a reused profile.
    const raw = await connectCdp(browser.tabWs);
    await raw.send('Page.enable');
    await raw.send('Page.navigate', { url: 'http://allowed.test/' });
    await sleep(200);
    await raw.send('Runtime.evaluate', { expression: start, awaitPromise: true });
    await sleep(500);
    raw.close();
    return { browser, consent, hits: () => site.hits.filter((h) => h.includes('early')).length, async stop() { await browser.close(); await proxy.close(); site.close(); } };
  };
  it.each([
    ['service worker', "navigator.serviceWorker.register('/early-worker.js').then(() => 1)"],
    ['shared worker', "window.__w = new SharedWorker('/early-worker.js'); 1"],
  ])('a %s already running means no policy, so no lease over it', async (_name, start) => {
    const e = await withEarlyWorker(start);
    try {
      expect(e.hits(), 'control: it is running and reaches its server').toBeGreaterThan(0);
      await expect(startRequestPolicy({ browser: e.browser, consent: e.consent })).rejects.toThrow(/dedicated browser/);
    } finally { await e.stop(); }
  });
  it('a browser this run did not launch, or one a lease already used, is refused', async () => {
    const consent = makeConsent(['http://allowed.test']);
    const proxy = await startEgressProxy({ consent });
    const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
    try {
      await expect(startRequestPolicy({ browser: { ...browser }, consent }), 'a look-alike').rejects.toThrow(/not freshly launched/);
      const first = await startRequestPolicy({ browser, consent });
      first.close();
      await expect(startRequestPolicy({ browser, consent })).rejects.toThrow(/not freshly launched/);
    } finally { await browser.close(); await proxy.close(); }
  });
  it('the launch has only the leased tab running, with its built-in extensions off', async () => {
    const consent = makeConsent(['http://allowed.test']);
    const proxy = await startEgressProxy({ consent });
    const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
    try {
      const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json() as { type: string; url: string }[];
      expect(list.filter((t) => !isBrowserOwnUi(t)).map((t) => t.type)).toEqual(['page']);
    } finally { await browser.close(); await proxy.close(); }
  });
  it('a switch added after the proxy\'s would go round it, so the launch takes none', async () => {
    const site = await countingServer();
    const proxy = await startEgressProxy({ consent: makeConsent(['http://allowed.test']) });
    proxy.open();
    // Control: the same proxy arguments, with one more after them. The server hears it and the proxy doesn't.
    const b = await pw.chromium.launch({ executablePath: CHROMIUM!, args: ['--no-sandbox', ...browserProxyArgs(proxy.port), '--no-proxy-server'] });
    try {
      const p = await b.newPage();
      await p.evaluate(tryFetch(`http://127.0.0.1:${site.port}/direct`)).catch(() => {});
      await p.goto(`http://127.0.0.1:${site.port}/direct`);
      expect(site.hits.join()).toContain('/direct');
      expect(proxy.decisions).toEqual([]);
    } finally { await b.close(); }
    await expect(launchBehindProxy({ chromiumPath: CHROMIUM!, proxy, extraArgs: ['--no-proxy-server'] } as never)).rejects.toThrow(/takes no extraArgs/);
    // The launch itself: the same request is the proxy's to refuse, and the server hears nothing more.
    const hitsBefore = site.hits.length;
    const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
    try {
      const raw = await connectCdp(browser.tabWs);
      await raw.send('Runtime.evaluate', { expression: tryFetch(`http://127.0.0.1:${site.port}/through-launch`), awaitPromise: true });
      raw.close();
      expect(proxy.decisions.some((d) => d.port === String(site.port) && !d.allowed)).toBe(true);
      expect(site.hits.length).toBe(hitsBefore);
    } finally { await browser.close(); await proxy.close(); site.close(); }
  });
  it('a controlling switch the launch did not ask for fails it, even added by a wrapper around the binary', async () => {
    const proxy = await startEgressProxy({ consent: makeConsent(['http://allowed.test']) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-relay-wrapper-'));
    const wrapper = path.join(dir, 'chromium');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(CHROMIUM!)} "$@" --remote-allow-origins=*\n`, { mode: 0o755 });
    try {
      await expect(launchBehindProxy({ chromiumPath: wrapper, proxy })).rejects.toThrow(/did not ask for: --remote-allow-origins/);
    } finally { await proxy.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('the running browser\'s own report must show the settings: a profile without them fails, the launch\'s passes', async () => {
    const consent = makeConsent(['http://allowed.test']);
    const proxy = await startEgressProxy({ consent });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-relay-bare-'));
    const bare = await launchForRelayTests({ chromiumPath: CHROMIUM!, proxy, bareProfileDir: dir });
    const good = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
    try {
      await expect(verifyLaunchedProfile(bare.browserWs, bare.tabTargetId, bare.switches)).rejects.toThrow(/network_prediction_options is not in force/);
      await expect(verifyLaunchedProfile(good.browserWs, good.tabTargetId, good.switches)).resolves.toBeUndefined();
    } finally { await bare.close(); await good.close(); await proxy.close(); }
  });
  it('the policy refuses a browser with another tab open', async () => {
    const consent = makeConsent(['http://allowed.test']);
    const proxy = await startEgressProxy({ consent });
    const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
    try {
      const made = await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' });
      expect(made.ok).toBe(true);
      await expect(startRequestPolicy({ browser, consent })).rejects.toThrow(/dedicated browser/);
    } finally { await browser.close(); await proxy.close(); }
  });
});

suite('speculative loads', { timeout: 30_000 }, () => {
  const load = async (r: Rig, at: string, ms = 1500): Promise<void> => { await r.page.goto(`http://allowed.test${at}`); await sleep(ms); };
  const speculated = (r: Rig): string[] => r.allowed.hits.filter((h) => /\/(pre|pf)-/.test(h));

  it('control: in a profile without the preference, a prerender of a site without consent goes round the policy', async () => {
    const r = await startRig({ bareProfile: true });
    await load(r, '/prerender-same-site');
    // Sent from the browser process, so Fetch interception never pauses it.
    expect(r.allowed.hits).toContain('GET /pre-same-site');
    expect(r.enforcer.decisions.filter((d) => d.url.includes('pre-same-site'))).toEqual([]);
    expect(r.lease.state()).toBe('held');
    await load(r, '/prerender-rules');
    expect(r.allowed.hits).toContain('GET /pre-same');
    expect(r.allowed.hits, 'the redirect ran').toContain('GET /pre-redirect');
    expect(r.offlist.hits).toEqual([]);
  });
  it('the launch\'s preference stops every speculative load', async () => {
    const r = await startRig();
    for (const p of ['/prerender-same-site', '/prerender-rules', '/prefetch-rules']) await load(r, p);
    expect(speculated(r)).toEqual([]);
    expect(r.offlist.hits).toEqual([]);
    expect(r.lease.state()).toBe('held');
  });
  it('a stray <link rel=prerender> to a site without consent is the policy\'s to stop', async () => {
    const r = await startRig();
    await r.page.goto('http://allowed.test/');
    await r.page.evaluate("document.head.insertAdjacentHTML('beforeend', '<link rel=prerender href=\"http://offlist.test/link-prerender\">')");
    await sleep(800);
    expect(r.offlist.hits).toEqual([]);
  });
  it('backstop: activating a prerender of a site without consent ends the lease and leaves the page', async () => {
    const r = await startRig({ bareProfile: true });
    await load(r, '/prerender-same-site');
    expect(r.allowed.hits, 'it was prerendered').toContain('GET /pre-same-site');
    const before = r.allowed.hits.filter((h) => h === 'GET /pre-same-site').length;
    await r.page.evaluate("location.href = 'http://sub.allowed.test/pre-same-site'").catch(() => {});
    await sleep(800);
    // Activation sends no second request, so only the main-frame check can notice this.
    expect(r.allowed.hits.filter((h) => h === 'GET /pre-same-site').length).toBe(before);
    expect(r.lease.state()).not.toBe('held');
    const list = await (await fetch(`http://127.0.0.1:${r.browser.port}/json/list`)).json() as { type: string; url: string }[];
    expect(list.filter((t) => t.type === 'page').map((t) => t.url)).toEqual(['about:blank']);
    expect(r.agentFrames.join()).not.toMatch(/PRERENDERTITLE|PRERENDERBODY/);
  });
  it('control: activating a prerender on the consented site keeps the lease, so the backstop isn\'t just firing on every activation', async () => {
    const r = await startRig({ bareProfile: true });
    await load(r, '/prerender-rules', 800);
    await r.page.evaluate("location.href = '/pre-same'").catch(() => {});
    await sleep(400);
    expect(r.lease.state()).toBe('held');
    expect(r.page.url()).toBe('http://allowed.test/pre-same');
  });
});

suite('titles and context names', { timeout: 30_000 }, () => {
  it('a real history reply carries no title, and back still works', async () => {
    const r = await startRig({ raw: true });
    await r.command('Page.enable');
    await r.command('Page.navigate', { url: 'http://allowed.test/one' });
    await sleep(200);
    await r.command('Runtime.evaluate', { expression: "document.title = 'MARKHISTORYTITLE'" });
    await r.command('Page.navigate', { url: 'http://allowed.test/two' });
    await sleep(200);
    const raw = await connectCdp(r.browser.tabWs);
    const direct = await raw.send('Page.getNavigationHistory');
    raw.close();
    expect(JSON.stringify(direct), 'control: the browser reports the title').toContain('MARKHISTORYTITLE');
    const h = (await r.command('Page.getNavigationHistory')).result as { currentIndex: number; entries: { id: number; url: string }[] };
    expect(JSON.stringify(h)).not.toContain('MARKHISTORYTITLE');
    const one = h.entries.find((e) => e.url === 'http://allowed.test/one');
    expect((await r.command('Page.navigateToHistoryEntry', { entryId: one!.id })).error).toBeUndefined();
    await sleep(200);
    const now = (await r.command('Page.getNavigationHistory')).result as { currentIndex: number; entries: { url: string }[] };
    expect(now.entries[now.currentIndex]!.url).toBe('http://allowed.test/one');
  });
  it('a page cannot put anything in a context name', async () => {
    const r = await startRig({ raw: true });
    await r.command('Runtime.enable');
    await r.command('Page.enable');
    await r.command('Page.navigate', { url: 'http://allowed.test/ctx' });
    await sleep(200);
    await r.command('Runtime.evaluate', { expression: "window.name = 'MARKCTX'; document.title = 'MARKCTX'; const f = document.createElement('iframe'); f.name = 'MARKCTX'; document.body.append(f);" });
    await sleep(200);
    const names = r.agentFrames.filter((f) => f.includes('executionContextCreated')).map((f) => (JSON.parse(f) as { params: { context: { name?: string } } }).params.context.name);
    expect(names.length).toBeGreaterThan(1);
    expect(names.every((n) => n === '')).toBe(true);
    expect(r.agentFrames.filter((f) => f.includes('MARKCTX') && !f.includes('"result"'))).toEqual([]);
  });
});

suite('what a revoke does in a real browser', { timeout: 60_000 }, () => {
  const setTimer = "window.__t = setInterval(() => fetch('/beacon?timer').catch(() => {}), 50)";
  const timerHits = (r: Rig) => r.allowed.hits.filter((h) => h.includes('beacon?timer')).length;

  it.each<[PageEndMode, number]>([['blank', 1], ['close', 0]])('pageEnd=%s: a timer stops, and %i tab(s) remain', async (pageEnd, tabs) => {
    const r = await startRig({ pageEnd });
    await r.page.evaluate(setTimer);
    await sleep(200);
    expect(timerHits(r)).toBeGreaterThan(0);
    r.lease.revoke('stop');
    await r.serving;
    await sleep(100); // A request already on the wire may still land.
    const after = timerHits(r);
    await sleep(400);
    expect(timerHits(r)).toBe(after);
    const list = await (await fetch(`http://127.0.0.1:${r.browser.port}/json/list`)).json() as { type: string }[];
    expect(list.filter((t) => t.type === 'page')).toHaveLength(tabs);
  });
  // Revoke must finish while the page spins, and whatever the spin was hiding must not
  // run when it ends. With a script still registered, leaving for about:blank would run
  // it again, so that case closes the tab even in blank mode.
  it.each<[PageEndMode, boolean, number]>([['blank', false, 1], ['blank', true, 0], ['close', true, 0], ['close', false, 0]])('a page spinning in a loop can\'t hold up a revoke (pageEnd=%s, injected script=%s, %i tab(s) remain)', async (pageEnd, injected, tabs) => {
    const r = await startRig({ pageEnd, raw: true });
    if (injected) await r.command('Page.addScriptToEvaluateOnNewDocument', { source: '0' });
    void r.command('Runtime.evaluate', { expression: "const end = Date.now() + 2000; while (Date.now() < end) {} setInterval(() => fetch('/beacon?after-spin').catch(() => {}), 50);" });
    await sleep(200);
    const t0 = Date.now();
    r.lease.revoke('stop');
    await r.serving;
    expect(Date.now() - t0).toBeLessThan(5000);
    await sleep(Math.max(0, 2600 - (Date.now() - t0)));
    const list = await (await fetch(`http://127.0.0.1:${r.browser.port}/json/list`)).json() as { type: string; url: string }[];
    const pages = list.filter((t) => t.type === 'page');
    expect(pages).toHaveLength(tabs);
    if (tabs) expect(pages[0]!.url).toBe('about:blank');
    expect(r.allowed.hits.filter((h) => h.includes('after-spin'))).toEqual([]);
    expect(r.relay.refusals).not.toContain('the browser did not confirm the page ended');
  });
  it.each<PageEndMode>(['blank', 'close'])('a page that never stops spinning can\'t hold up a revoke either (pageEnd=%s)', async (pageEnd) => {
    const r = await startRig({ pageEnd, raw: true });
    void r.command('Runtime.evaluate', { expression: 'while (true) {}' });
    await sleep(200);
    const t0 = Date.now();
    r.lease.revoke('stop');
    await r.serving;
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('control: detaching alone leaves the timer running', async () => {
    const pageSrv = await countingServer();
    const b = await pw.chromium.launch({ executablePath: CHROMIUM!, args: ['--no-sandbox', '--no-proxy-server'] });
    const p = await b.newPage();
    await p.goto(`http://127.0.0.1:${pageSrv.port}/`);
    const list = await (async () => p.evaluate(setTimer))();
    void list;
    await sleep(150);
    const n = pageSrv.hits.length;
    await sleep(300);
    expect(pageSrv.hits.length).toBeGreaterThan(n);
    await b.close(); pageSrv.close();
  });
  it('a service worker\'s timer stops too, since it outlives a navigation', async () => {
    const r = await startRig({ pageEnd: 'blank' });
    await r.page.evaluate("navigator.serviceWorker.register('/timer-worker.js')");
    await sleep(500);
    const workerHits = () => r.allowed.hits.filter((h) => h.includes('worker-timer')).length;
    expect(workerHits()).toBeGreaterThan(0);
    r.lease.revoke('stop');
    await r.serving;
    await sleep(100);
    const after = workerHits();
    await sleep(400);
    expect(workerHits()).toBe(after);
  });
  it('the agent\'s scripts for new documents don\'t survive the lease', async () => {
    const r = await startRig({ pageEnd: 'blank', raw: true });
    await r.command('Page.addScriptToEvaluateOnNewDocument', { source: "fetch('/beacon?injected').catch(() => {})" });
    await r.command('Page.enable');
    await r.command('Page.navigate', { url: 'http://allowed.test/x' });
    await sleep(200);
    expect(r.allowed.hits.some((h) => h.includes('injected'))).toBe(true);
    r.lease.revoke('stop');
    await r.serving;
    const before = r.allowed.hits.filter((h) => h.includes('injected')).length;
    const raw = await connectCdp(r.browser.tabWs);
    await raw.send('Page.navigate', { url: 'http://allowed.test/later' }).catch(() => {});
    await sleep(300);
    raw.close();
    expect(r.allowed.hits.filter((h) => h.includes('injected')).length).toBe(before);
  });
  it('the connection dropping revokes the lease, with no way back on it', async () => {
    const r = await startRig();
    r.agent.close();
    await r.serving;
    expect(r.lease.state()).toBe('idle');
    expect(r.relay.refusals.join()).toContain('connection');
  });
  it('a malformed frame ends the lease', async () => {
    const r = await startRig({ raw: true });
    r.agent.send('not json');
    await r.serving;
    expect(r.lease.state()).toBe('idle');
    expect(r.relay.refusals.join()).toContain('malformed frame');
  });
  it('a replayed frame id ends the lease', async () => {
    const r = await startRig({ raw: true });
    r.agent.send(JSON.stringify({ id: 1, method: 'Page.enable', sessionId: 'cascade-tab-1' }));
    await r.serving;
    expect(r.lease.state()).toBe('idle');
  });
  it('an in-flight navigation written before the revoke still happens: the stated limit', async () => {
    const r = await startRig({ raw: true });
    const before = r.allowed.hits.length;
    void r.command('Page.navigate', { url: 'http://allowed.test/in-flight' });
    await sleep(0);
    r.lease.revoke('stop');
    await r.serving;
    await sleep(200);
    // Allowed to land or not, depending on timing, but never after pageEnd's own step
    // leaves it on that page: the tab ends on about:blank.
    const raw = await connectCdp(r.browser.tabWs);
    const info = await raw.send('Target.getTargetInfo') as { targetInfo: { url: string } };
    raw.close();
    expect(info.targetInfo.url).toBe('about:blank');
    expect(r.allowed.hits.length).toBeGreaterThanOrEqual(before);
  });
});

suite('before a lease is served', { timeout: 30_000 }, () => {
  it('a tab on a site without consent is refused', async () => {
    const proxy = await startEgressProxy({ consent: makeConsent(['http://other.test']) });
    const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
    const consent = makeConsent(['http://other.test']);
    const pageSrv = await countingServer();
    try {
      const raw = await connectCdp(browser.tabWs);
      await raw.send('Page.enable');
      await raw.send('Page.navigate', { url: 'data:text/html,<title>held</title>' });
      await sleep(150);
      raw.close();
      const enforcer = await startRequestPolicy({ browser, consent });
      expect(await enforcer.checkTabBeforeLease()).toMatchObject({ ok: false });
      enforcer.close();
    } finally { await browser.close(); await proxy.close(); pageSrv.close(); }
  });
  it('a tab on about:blank is accepted', async () => {
    const consent = makeConsent(['http://other.test']);
    const proxy = await startEgressProxy({ consent });
    const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
    try {
      const enforcer = await startRequestPolicy({ browser, consent });
      expect(await enforcer.checkTabBeforeLease()).toEqual({ ok: true });
      enforcer.close();
    } finally { await browser.close(); await proxy.close(); }
  });
});


suite('what the browser sends that no agent asked for', { timeout: 60_000 }, () => {
  const IDLE_MS = 15_000;
  const idleNames = async (launch: (proxy: EgressProxy) => Promise<() => Promise<void>>): Promise<string[]> => {
    const names: string[] = [];
    const proxy = await startEgressProxy({
      consent: makeConsent(['http://allowed.test']),
      network: { resolve: async (name) => { names.push(name); throw new Error('ENOTFOUND'); }, dial: () => { throw new Error('no dial'); } },
    });
    const stop = await launch(proxy);
    await sleep(IDLE_MS);
    await stop();
    await proxy.close();
    return names;
  };

  it('control: an idle browser behind the proxy, with only its proxy arguments, does ask for names', async () => {
    const names = await idleNames(async (proxy) => {
      proxy.open();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-relay-idle-'));
      const proc = spawn(CHROMIUM!, ['--headless=new', '--no-sandbox', `--user-data-dir=${dir}`, ...browserProxyArgs(proxy.port), 'about:blank'], { stdio: 'ignore' });
      return async () => { proc.kill('SIGKILL'); await sleep(150); fs.rmSync(dir, { recursive: true, force: true }); };
    });
    expect(names.length).toBeGreaterThan(0);
  });
  it('the launched browser asks for no names at all while idle', async () => {
    const names = await idleNames(async (proxy) => {
      const b = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
      return () => b.close();
    });
    expect(names).toEqual([]);
  });

  it('after the policy opens the proxy, an idle browser still asks for nothing', async () => {
    const names = await idleNames(async (proxy) => {
      const consent = makeConsent(['http://allowed.test']);
      const b = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
      const enforcer = await startRequestPolicy({ browser: b, consent });
      return async () => { enforcer.close(); await b.close(); };
    });
    expect(names).toEqual([]);
  });

  // Each of these is a public subresource under plan §4.3, so it's allowed. What matters is
  // that it reaches the policy: none of them go round it the way a prerender did.
  it.each([
    ['favicon', "document.head.insertAdjacentHTML('beforeend', '<link rel=icon href=\"http://offlist.test/probe-icon\">')", 'probe-icon'],
    ['manifest', "document.head.insertAdjacentHTML('beforeend', '<link rel=manifest href=\"http://offlist.test/probe-manifest\">')", 'probe-manifest'],
    ['link prefetch', "document.head.insertAdjacentHTML('beforeend', '<link rel=prefetch href=\"http://offlist.test/probe-prefetch\">')", 'probe-prefetch'],
    ['beacon', "navigator.sendBeacon('http://offlist.test/probe-beacon')", 'probe-beacon'],
    ['keepalive fetch', "fetch('http://offlist.test/probe-keepalive', { mode: 'no-cors', keepalive: true }).catch(() => {}), 1", 'probe-keepalive'],
    ['link ping', "document.body.insertAdjacentHTML('beforeend', '<a id=pg href=\"/two\" ping=\"http://offlist.test/probe-ping\">x</a>'); document.getElementById('pg').click(); 1", 'probe-ping'],
  ])('%s: reaches the server only through the policy', async (_name, script, marker) => {
    const r = await startRig();
    await r.page.evaluate(script);
    await sleep(1200);
    expect(r.offlist.hits.join()).toContain(marker);
    expect(r.enforcer.decisions.some((d) => d.url.includes(marker) && d.allowed)).toBe(true);
    expect(r.lease.state()).toBe('held');
  });
  it('a CSP report reaches the server only through the policy', async () => {
    const r = await startRig();
    await r.page.goto('http://allowed.test/csp');
    await sleep(1200);
    expect(r.offlist.hits).toContain('POST /csp-report');
    expect(r.enforcer.decisions.filter((d) => d.url.includes('csp-report')).every((d) => d.allowed)).toBe(true);
    expect(r.enforcer.decisions.some((d) => d.url.includes('csp-report'))).toBe(true);
  });
  it('a download from a site without consent is blocked, and sends nothing', async () => {
    const r = await startRig();
    await r.page.evaluate("document.body.insertAdjacentHTML('beforeend', '<a id=dl download href=\"http://offlist.test/probe-download\">x</a>'); document.getElementById('dl').click(); 1");
    await sleep(1000);
    expect(r.offlist.hits).toEqual([]);
    expect(r.enforcer.decisions.some((d) => d.url.includes('probe-download') && !d.allowed)).toBe(true);
  });
  it('preconnect and dns-prefetch ask the proxy for nothing, under the launch\'s preference', async () => {
    const r = await startRig();
    await r.page.evaluate("document.head.insertAdjacentHTML('beforeend', '<link rel=preconnect href=\"http://probe-preconnect.test/\"><link rel=dns-prefetch href=\"http://probe-dns.test/\">')");
    await sleep(1000);
    expect(r.resolved.filter((n) => n.startsWith('probe-'))).toEqual([]);
  });
  it('the stated limit: a service worker\'s update check goes round the policy, and the proxy still holds', async () => {
    const r = await startRig();
    await r.page.evaluate("navigator.serviceWorker.register('/sw-import.js').then(() => new Promise((res) => setTimeout(res, 600)))");
    expect(r.offlist.hits, 'installed, through the policy').toContain('GET /imported.js');
    const updateWas = r.allowed.hits.filter((h) => h === 'GET /sw-import.js').length;
    const logged = r.enforcer.decisions.length;
    const importsWere = r.offlist.hits.length;
    const update = "navigator.serviceWorker.getRegistration().then((x) => x.update()).then(() => 1, () => 0)";
    await r.page.evaluate(update);
    await sleep(600);
    // Sent from the browser process, like a prerender: at both servers, in the policy's log nowhere.
    expect(r.allowed.hits.filter((h) => h === 'GET /sw-import.js').length).toBeGreaterThan(updateWas);
    expect(r.offlist.hits.length).toBeGreaterThan(importsWere);
    expect(r.enforcer.decisions.slice(logged).filter((d) => /sw-import|imported/.test(d.url))).toEqual([]);
    // The name now answers with a private address. The update check tries it, and the proxy refuses.
    const asked = r.resolved.filter((n) => n === 'flip.test').length;
    r.setFlip('127.0.0.1');
    await r.page.evaluate(update);
    await sleep(600);
    expect(r.resolved.filter((n) => n === 'flip.test').length, 'it did try').toBeGreaterThan(asked);
    expect(r.dials.filter((d) => d.address === '127.0.0.1')).toEqual([]);
  });

  // CASCADE_RELAY_IDLE_MS runs this longer, for a measurement. CI uses the default.
  const LEASE_IDLE_MS = Number(process.env.CASCADE_RELAY_IDLE_MS ?? 30_000);
  /** Connections the proxy let out for a host and port no request in the policy's log names. */
  const browserOnly = (r: Rig): string[] => {
    const known = new Set(r.enforcer.decisions.flatMap((d) => {
      try { const u = new URL(d.url); return [`${u.hostname}:${u.port || (/^(https|wss):/.test(u.protocol) ? '443' : '80')}`]; } catch { return []; }
    }));
    return r.proxy.decisions.filter((d) => d.allowed && !known.has(`${d.host}:${d.port}`)).map((d) => `${d.host}:${d.port}`);
  };
  it('during a lease, with a service worker registered, the proxy lets out nothing the policy did not log', { timeout: LEASE_IDLE_MS + 30_000 }, async () => {
    const r = await startRig();
    await r.page.evaluate("navigator.serviceWorker.register('/sw-import.js').then(() => new Promise((res) => setTimeout(res, 600)))");
    await sleep(LEASE_IDLE_MS);
    expect(r.lease.state()).toBe('held');
    expect(browserOnly(r)).toEqual([]);
    // The check can see such a connection, and the proxy lets it out: the limit in plan section 9.
    const s = net.connect(r.proxy.port, '127.0.0.1');
    s.write('CONNECT other.test:80 HTTP/1.1\r\nHost: other.test\r\n\r\n');
    await sleep(300);
    s.destroy();
    expect(browserOnly(r)).toEqual(['other.test:80']);
  });
});

suite('what reaches the network after a revoke', { timeout: 30_000 }, () => {
  it('plain http still in flight at a revoke: the destination\'s connections go, and the upload stops short', async () => {
    Object.assign(held, { open: 0, uploaded: 0, slow: true });
    const r = await startRig({ pageEnd: 'blank' });
    await r.page.goto('http://allowed.test/links');
    const SIZE = 32 * 1024 * 1024;
    await r.page.evaluate(`void fetch('/hold').catch(() => {}); void fetch('/hold', { method: 'POST', body: new Blob([new Uint8Array(${SIZE})]) }).catch(() => {}); void 0`);
    // Chromium takes a few seconds to start sending a body this size under interception.
    for (let i = 0; i < 150 && !(held.open === 2 && held.uploaded > 0); i++) await sleep(100);
    expect(held.open, 'control: both are in flight').toBe(2);
    expect(held.uploaded, 'control: the upload is arriving').toBeGreaterThan(0);

    r.lease.revoke('test');
    await r.serving;
    const dials = r.dials.length;
    // Whatever the destination's own buffers still hold, it can now read to the end of.
    held.slow = false;
    await sleep(1000);
    expect(held.open).toBe(0);
    expect(held.uploaded).toBeLessThan(SIZE);
    expect(r.dials.length).toBe(dials);
  });

  it.each([['blank' as const], ['close' as const]])('%s: a surviving service worker registration reaches nothing, however late its update', async (mode) => {
    const r = await startRig({ pageEnd: mode });
    await r.page.goto('http://allowed.test/cached');
    await r.page.evaluate("navigator.serviceWorker.register('/sw-import.js').then(() => new Promise((res) => setTimeout(res, 600)))");
    const update = "navigator.serviceWorker.getRegistration().then((x) => x.update()).then(() => 'updated', () => 'failed')";
    const wereScript = r.allowed.hits.filter((h) => h === 'GET /sw-import.js').length;
    expect(await r.page.evaluate(update), 'control').toBe('updated');
    expect(r.allowed.hits.filter((h) => h === 'GET /sw-import.js').length, 'control: an update reaches the server').toBeGreaterThan(wereScript);

    r.lease.revoke('test');
    await r.serving;
    const allowedHits = r.allowed.hits.length;
    const offlistHits = r.offlist.hits.length;
    const dials = r.dials.length;
    await sleep(1000);
    if (mode === 'blank') {
      // Something still in the browser gets back into the registration's scope: this page
      // needs no network, from the cache, so it can ask for an update, some time later.
      const tab = await connectCdp(r.browser.tabWs);
      await tab.send('Page.enable');
      await tab.send('Page.navigate', { url: 'http://allowed.test/cached' });
      await sleep(800);
      const late = await tab.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }) as { result: { value?: string } };
      expect(late.result.value, 'it is back in scope').toContain('from the cache');
      const got = await tab.send('Runtime.evaluate', { expression: update, awaitPromise: true, returnByValue: true }) as { result: { value?: string } };
      expect(got.result.value, 'the update was tried, and failed').toBe('failed');
      tab.close();
      expect(r.proxy.decisions.at(-1)?.reason).toBe('the lease is over');
    }
    await sleep(1000);
    expect(r.allowed.hits.length).toBe(allowedHits);
    expect(r.offlist.hits.length).toBe(offlistHits);
    expect(r.dials.length).toBe(dials);
  });
});
