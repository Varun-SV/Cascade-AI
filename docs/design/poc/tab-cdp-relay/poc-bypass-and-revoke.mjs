// ─────────────────────────────────────────────────────────────────────────────
//  PoC 5: QUIC, WebTransport and TURN around the proxy; dialogs; revoke effects
// ─────────────────────────────────────────────────────────────────────────────
//
//  Evidence for the stage 1 plan (docs/design/stage-1-plan.md). Each case is
//  asserted where traffic would arrive: a UDP socket and a TCP server that only
//  count. A WebTransport or QUIC client sends its first packet whether or not a
//  server answers, so a counting socket is enough to show a leak. Each case has
//  a no-proxy control that must reach them.
//
//  Run from the repo root:
//    CHROMIUM=/path/to/chrome node docs/design/poc/tab-cdp-relay/poc-bypass-and-revoke.mjs

import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { WebSocket } = require('ws');

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function udpCounter() {
  const state = { packets: 0 };
  const sock = dgram.createSocket('udp4');
  sock.on('message', () => { state.packets += 1; });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve({ state, port: sock.address().port, close: () => sock.close() })));
}
function tcpCounter() {
  const state = { accepts: 0 };
  const server = net.createServer((s) => { state.accepts += 1; s.on('error', () => {}); s.destroy(); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, port: server.address().port, close: () => server.close() })));
}
// The consented page, and the script a service worker needs a URL for.
function pageServer(udpPort) {
  const hits = { beacon: 0 };
  // The beacon shows the worker really ran, so 0 packets isn't a worker that never started.
  const attempt = `fetch('/beacon?ran').catch(() => {}); try { const t = new WebTransport('https://127.0.0.1:${udpPort}/'); t.ready.catch(() => {}); t.closed.catch(() => {}); } catch {}`;
  const server = http.createServer((q, res) => {
    if (q.url.includes('/beacon')) { hits.beacon += 1; res.setHeader('Access-Control-Allow-Origin', '*'); return res.end('ok'); }
    if (q.url.endsWith('/sw.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end(attempt); }
    if (q.url.endsWith('/w.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end(attempt); }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>page</title><body>page</body>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ hits, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } })));
}
// Forwards every request to the page server, as a consented destination.
function tinyProxy(pagePort) {
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const up = net.connect(pagePort, '127.0.0.1');
    up.on('error', () => {});
    client.pipe(up); up.pipe(client);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() })));
}
async function launch(flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-poc5-'));
  const proc = spawn(process.env.CHROMIUM || chromium.executablePath(), ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, ...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//); if (m) resolve(Number(m[1])); });
    proc.on('exit', (c) => reject(new Error(`chromium exited ${c}`)));
  });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  return { port, context, page: context.pages()[0], close: async () => { await browser.close().catch(() => {}); proc.kill('SIGKILL'); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const proxyArgs = (p) => [`--proxy-server=http://127.0.0.1:${p}`, '--proxy-bypass-list=<-loopback>'];

// Starts WebTransport from each context, then gives it time to send.
async function webTransportFrom(page, where, udpPort) {
  const attempt = `try { const t = new WebTransport('https://127.0.0.1:${udpPort}/'); t.ready.catch(() => {}); t.closed.catch(() => {}); } catch {}`;
  if (where === 'page') await page.evaluate(attempt);
  if (where === 'iframe') await page.evaluate(`(() => { const f = document.createElement('iframe'); document.body.append(f); f.contentWindow.eval(${JSON.stringify(attempt)}); })()`);
  if (where === 'dedicated worker') await page.evaluate(() => { window.__w = new Worker('/w.js'); });
  if (where === 'shared worker') await page.evaluate(() => { window.__s = new SharedWorker('/w.js'); });
  if (where === 'service worker') await page.evaluate(() => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  await sleep(1200);
}
const CONTEXTS = ['page', 'iframe', 'dedicated worker', 'shared worker', 'service worker'];

async function webTransportRun(label, flagsFor, expectLeak) {
  for (const where of CONTEXTS) {
    const udp = await udpCounter();
    const pages = await pageServer(udp.port);
    const proxy = await tinyProxy(pages.port);
    const b = await launch(flagsFor(proxy.port));
    await b.page.goto(`http://127.0.0.1:${pages.port}/`);
    await webTransportFrom(b.page, where, udp.port);
    const n = udp.state.packets;
    const ran = where.includes('worker') ? pages.hits.beacon > 0 : true;
    check(`${label}: WebTransport from ${where} ${expectLeak ? 'reaches' : 'does not reach'} the UDP socket`, ran && (expectLeak ? n > 0 : n === 0), `${n} packets${where.includes('worker') ? `, worker ran: ${ran}` : ''}`);
    await b.close(); udp.close(); pages.close(); proxy.close();
  }
}

// A raw CDP client, so Playwright's own dialog handling stays out of the way.
async function rawTab(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pending = new Map(); const handlers = new Set();
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else handlers.forEach((h) => h(msg));
  });
  return {
    send: (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }),
    on: (h) => handlers.add(h),
    close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
  };
}
async function rawBrowser(flags, url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-poc5-'));
  const proc = spawn(process.env.CHROMIUM || chromium.executablePath(), ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, ...flags, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((resolve) => { let b = ''; proc.stderr.on('data', (d) => { b += d; const m = b.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)\//); if (m) resolve(Number(m[1])); }); });
  await sleep(500);
  return { port, close: async () => { proc.kill('SIGKILL'); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// 1. Control: no proxy.
await webTransportRun('control, no proxy', () => [], true);
// 2. Proxy flags alone, with QUIC also disabled, as the plan launches it.
await webTransportRun('proxy + --disable-quic', (p) => [...proxyArgs(p), '--disable-quic'], false);

// 3. QUIC forced for an origin.
for (const [label, flags, leak] of [['control, no proxy', () => [], true], ['proxy only', (p) => proxyArgs(p), false], ['proxy + --disable-quic', (p) => [...proxyArgs(p), '--disable-quic'], false]]) {
  const udp = await udpCounter(); const pages = await pageServer(udp.port); const proxy = await tinyProxy(pages.port);
  const b = await launch([...flags(proxy.port), `--origin-to-force-quic-on=127.0.0.1:${udp.port}`, '--enable-quic']);
  await b.page.goto(`http://127.0.0.1:${pages.port}/`);
  await b.page.evaluate((u) => fetch(`https://127.0.0.1:${u}/`, { mode: 'no-cors' }).catch(() => {}), udp.port);
  await sleep(800);
  const n = udp.state.packets;
  check(`${label}: forced QUIC ${leak ? 'reaches' : 'does not reach'} the UDP socket`, leak ? n > 0 : n === 0, `${n} packets`);
  await b.close(); udp.close(); pages.close(); proxy.close();
}

// 4. TURN, over UDP and over TCP. The proxy is down, so anything arriving went around it.
const WEBRTC_OFF = '--webrtc-ip-handling-policy=disable_non_proxied_udp';
const turn = (page, url) => page.evaluate(async (u) => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: u, username: 'u', credential: 'c' }], iceTransportPolicy: 'relay' });
  pc.createDataChannel('x');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 1500));
  pc.close();
}, url);
const closed = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
for (const [label, flags, leak] of [['control, no proxy', [], true], ['proxy down + WebRTC policy', [...proxyArgs(closed), WEBRTC_OFF], false]]) {
  const udp = await udpCounter(); const tcp = await tcpCounter();
  const b = await launch(flags);
  await turn(b.page, `turn:127.0.0.1:${udp.port}?transport=udp`);
  await turn(b.page, `turn:127.0.0.1:${tcp.port}?transport=tcp`);
  check(`${label}: TURN over UDP ${leak ? 'reaches' : 'does not reach'} the socket`, leak ? udp.state.packets > 0 : udp.state.packets === 0, `${udp.state.packets} packets`);
  check(`${label}: TURN over TCP ${leak ? 'reaches' : 'does not reach'} the server`, leak ? tcp.state.accepts > 0 : tcp.state.accepts === 0, `${tcp.state.accepts} accepts`);
  await b.close(); udp.close(); tcp.close();
}

// 5. Dialogs. Unanswered, one blocks the agent's command; the device can dismiss it itself.
{
  const pages = await pageServer(9);
  const ctl = await rawBrowser([], `http://127.0.0.1:${pages.port}/`);
  const stuck = await rawTab(ctl.port);
  const blocked = await Promise.race([stuck.send('Runtime.evaluate', { expression: "alert('x')" }).then(() => 'returned'), sleep(1000).then(() => 'blocked')]);
  check('control, no handler: alert() blocks the command', blocked === 'blocked');
  await ctl.close();

  const b = await rawBrowser([], `http://127.0.0.1:${pages.port}/`);
  const device = await rawTab(b.port);
  const seen = [];
  device.on((m) => { if (m.method === 'Page.javascriptDialogOpening') { seen.push(m.params.type); device.send('Page.handleJavaScriptDialog', { accept: false }); } });
  await device.send('Page.enable');
  const agent = await rawTab(b.port);
  for (const [expr, want] of [['alert("x")', undefined], ['confirm("x")', false], ['prompt("x")', null]]) {
    const r = await Promise.race([agent.send('Runtime.evaluate', { expression: expr, returnByValue: true }), sleep(2000).then(() => ({ timedOut: true }))]);
    check(`device dismisses: ${expr} returns ${want} to the agent`, !r.timedOut && r.result?.result?.value === want, JSON.stringify(r.result?.result?.value));
  }
  check('device dismisses: it saw alert, confirm and prompt', seen.join() === 'alert,confirm,prompt', seen.join());
  await b.close(); pages.close();
}

// 6. What survives a revoke: commands already sent, and script already running.
{
  const pages = await pageServer(9);
  const consented = `http://127.0.0.1:${pages.port}/`;
  const b = await rawBrowser([], consented);
  const list = async () => (await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json()).filter((t) => t.type === 'page');
  const [{ id: targetId }] = await list();

  // A navigation written to the socket just before the agent's session ends.
  const agent = await rawTab(b.port);
  await agent.send('Page.enable');
  const before = pages.hits.beacon;
  agent.send('Page.navigate', { url: `${consented}beacon?inflight` });
  await agent.close();
  await sleep(500);
  check('in-flight Page.navigate still takes effect after detach (the stated limit)', pages.hits.beacon > before, `${pages.hits.beacon - before} requests`);

  // A timer the agent left behind.
  const load = await rawTab(b.port);
  await load.send('Page.navigate', { url: consented });
  await sleep(300);
  await load.send('Runtime.evaluate', { expression: "window.__t = setInterval(() => fetch('/beacon?timer').catch(() => {}), 50)" });
  await load.close();
  const n0 = pages.hits.beacon; await sleep(500);
  check('detach alone: a timer the agent set keeps sending', pages.hits.beacon > n0, `${pages.hits.beacon - n0} requests after detach`);

  // Option A: leave the page. The tab stays open, its page does not.
  const leave = await rawTab(b.port);
  await leave.send('Page.navigate', { url: 'about:blank' });
  await sleep(200); await leave.close();
  const n1 = pages.hits.beacon; await sleep(500);
  check('navigate to about:blank: the timer stops, the tab stays open', pages.hits.beacon === n1 && (await list()).length === 1, `${pages.hits.beacon - n1} requests`);

  // Option B: close the target.
  const again = await rawTab(b.port);
  await again.send('Page.navigate', { url: consented });
  await sleep(300);
  await again.send('Runtime.evaluate', { expression: "setInterval(() => fetch('/beacon?timer2').catch(() => {}), 50)" });
  await again.close();
  await fetch(`http://127.0.0.1:${b.port}/json/close/${targetId}`);
  await sleep(200);
  const n2 = pages.hits.beacon; await sleep(500);
  check('close the target: the timer stops', pages.hits.beacon === n2, `${pages.hits.beacon - n2} requests`);
  await b.close(); pages.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
