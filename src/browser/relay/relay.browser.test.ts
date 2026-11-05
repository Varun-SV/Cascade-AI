// The relay against a real Chromium. Every "blocked" here is asserted where the
// traffic would arrive: servers and sockets that only count. Each family has a control
// with no policy that must reach them, or the test couldn't have detected a leak.
//
// Set CHROMIUM to a browser. On CI these fail rather than skip when none is found.

import { execFileSync } from 'node:child_process';
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
import { type EgressProxy, type ProxyNetwork, startEgressProxy } from './egress-proxy.js';
import { type Consent, makeConsent } from './egress-rules.js';
import { navigateHistory } from './history.js';
import { type LaunchedBrowser, launchBehindProxy } from './launch.js';
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
function countingServer(handle: (path: string, res: http.ServerResponse, req: http.IncomingMessage) => boolean = () => false): Promise<Counting> {
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
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

const PUBLIC_ALLOWED = '203.0.113.10';
const PUBLIC_OFFLIST = '203.0.113.20';
const WORKER_JS = "fetch(self.location.origin + '/beacon?ran').catch(() => {});";

interface Rig {
  allowed: Counting; offlist: Counting; priv: Counting;
  proxy: EgressProxy; browser: LaunchedBrowser; enforcer: RequestEnforcer; lease: TabLease; relay: DeviceRelay; consent: Consent;
  dials: { address: string; port: number }[];
  setFlip(a: string): void;
  agentFrames: string[];
  page: PwPage; pwBrowser: PwBrowser; agent: { close(): void; send(raw: string): void };
  /** A direct command on the tab's session, as an agent not using Playwright would send it. */
  command(method: string, params?: object): Promise<{ result?: Record<string, unknown>; error?: { message: string } }>;
  serving: Promise<void>;
  stop(): Promise<void>;
}
const rigs: Rig[] = [];

async function startRig(opts: { pageEnd?: PageEndMode; consent?: Consent; raw?: boolean } = {}): Promise<Rig> {
  const script = (res: http.ServerResponse, extra = ''): boolean => { res.setHeader('content-type', 'text/javascript'); res.end(WORKER_JS + extra); return true; };
  const redirect = (res: http.ServerResponse, to: string): boolean => { res.statusCode = 302; res.setHeader('location', to); res.end(); return true; };
  const allowed = await countingServer((path, res, req) => {
    switch (path) {
      case '/sw-private.js': return script(res, `fetch(${JSON.stringify(decodeURIComponent((req.url ?? '').split('u=')[1] ?? ''))}, { mode: 'no-cors' }).catch(() => {});`);
      case '/worker.js': case '/sw.js': return script(res);
      case '/timer-worker.js': return script(res, "setInterval(() => fetch('/beacon?worker-timer').catch(() => {}), 50);");
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
    if (path !== '/lib.js') return false;
    res.setHeader('content-type', 'text/javascript');
    res.end('window.__lib = 1;');
    return true;
  });
  const privPortRef = { port: 0 };
  const priv = await countingServer();
  privPortRef.port = priv.port;
  let flip = PUBLIC_OFFLIST;
  const dns = new Map<string, string[]>([
    ['allowed.test', [PUBLIC_ALLOWED]], ['other.test', [PUBLIC_ALLOWED]], ['offlist.test', [PUBLIC_OFFLIST]],
    ['alias.test', ['127.0.0.1']], ['alias6.test', ['::1']], ['mixed.test', [PUBLIC_OFFLIST, '127.0.0.1']],
  ]);
  const routes = new Map([[PUBLIC_ALLOWED, allowed.port], [PUBLIC_OFFLIST, offlist.port]]);
  const dials: { address: string; port: number }[] = [];
  const network: ProxyNetwork = {
    resolve: async (name) => {
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
  const browser = await launchBehindProxy({
    chromiumPath: CHROMIUM!, proxy,
    extraArgs: ['--unsafely-treat-insecure-origin-as-secure=http://allowed.test'],
  });
  const enforcer = await startRequestPolicy({ browserWs: browser.browserWs, tabWs: browser.tabWs, tabTargetId: browser.tabTargetId, consent });
  const lease = createTabLease();
  proxy.onClose(() => lease.revoke('egress-proxy-down'));
  lease.promote(lease.reserve()!, { expiresAt: Date.now() + 600_000 });
  const relay = createDeviceRelay({ tabWs: browser.tabWs, consent, lease, enforcer, pageEnd: opts.pageEnd ?? 'blank' });
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
    allowed, offlist, priv, proxy, browser, enforcer, lease, relay, consent, dials, agentFrames, page, pwBrowser,
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
    const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy, extraArgs: ['--enable-quic', `--origin-to-force-quic-on=127.0.0.1:${quic.port}`] });
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
    const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy, env: srv.env });
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
  it('a history entry on a site without consent is hidden and refused', async () => {
    const r = await startRig({ raw: true });
    await r.command('Page.navigate', { url: 'http://allowed.test/one' });
    await sleep(150);
    await r.command('Page.navigate', { url: 'http://offlist.test/blocked' });
    await sleep(150);
    const h = (await r.command('Page.getNavigationHistory')).result as { entries: { id: number; url: string }[] };
    expect(JSON.stringify(h)).not.toContain('offlist.test');
    // A blocked navigation leaves an entry only on some Chromium versions, so the check
    // that matters needs one: this entry is forced, by id, against the real history.
    const hidden = h.entries.find((e) => e.url.includes('not-consented'));
    expect(hidden, 'the blocked navigation left a hidden entry').toBeDefined();
    expect((await r.command('Page.navigateToHistoryEntry', { entryId: hidden!.id })).error?.message).toContain('not on a consented site');
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
      const enforcer = await startRequestPolicy({ browserWs: browser.browserWs, tabWs: browser.tabWs, tabTargetId: browser.tabTargetId, consent });
      expect(await enforcer.checkTabBeforeLease()).toMatchObject({ ok: false });
      enforcer.close();
    } finally { await browser.close(); await proxy.close(); pageSrv.close(); }
  });
  it('a tab on about:blank is accepted', async () => {
    const consent = makeConsent(['http://other.test']);
    const proxy = await startEgressProxy({ consent });
    const browser = await launchBehindProxy({ chromiumPath: CHROMIUM!, proxy });
    try {
      const enforcer = await startRequestPolicy({ browserWs: browser.browserWs, tabWs: browser.tabWs, tabTargetId: browser.tabTargetId, consent });
      expect(await enforcer.checkTabBeforeLease()).toEqual({ ok: true });
      enforcer.close();
    } finally { await browser.close(); await proxy.close(); }
  });
});

