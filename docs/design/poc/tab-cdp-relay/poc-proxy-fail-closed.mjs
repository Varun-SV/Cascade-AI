// ─────────────────────────────────────────────────────────────────────────────
//  PoC 4: does the egress proxy fail closed, and what goes around it?
// ─────────────────────────────────────────────────────────────────────────────
//
//  Evidence for the stage 1 plan (docs/design/stage-1-plan.md, section 2).
//  Every check is asserted where traffic would arrive: a counting TCP server
//  and a counting UDP socket. Each case has a control with no proxy, which
//  must reach them, or the case could not have detected a leak.
//
//  Run from the repo root:
//    CHROMIUM=/path/to/chrome node docs/design/poc/tab-cdp-relay/poc-proxy-fail-closed.mjs

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

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The destination: counts TCP connections, whatever they turn out to carry.
function countingTcp() {
  const state = { accepts: 0 };
  const server = http.createServer((_q, res) => res.end('ok'));
  server.on('connection', () => { state.accepts += 1; });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ state, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } });
  }));
}
function countingUdp() {
  const state = { packets: 0 };
  const sock = dgram.createSocket('udp4');
  sock.on('message', () => { state.packets += 1; });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => {
    resolve({ state, port: sock.address().port, close: () => sock.close() });
  }));
}
// A minimal forward proxy, enough to serve one consented page and then die.
function tinyProxy(pagePort) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('error', () => {});
    client.once('data', () => {
      const up = net.connect(pagePort, '127.0.0.1');
      sockets.add(up);
      up.on('error', () => {});
      up.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      up.pipe(client);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({
      port: server.address().port,
      kill: () => new Promise((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
    });
  }));
}
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
async function launch(flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-poc4-'));
  const proc = spawn(process.env.CHROMIUM || chromium.executablePath(), [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, ...flags, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//); if (m) resolve(Number(m[1])); });
    proc.on('exit', (c) => reject(new Error(`chromium exited ${c}`)));
  });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  return { page, close: async () => { await browser.close().catch(() => {}); proc.kill('SIGKILL'); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const proxied = (port) => [`--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>'];

// What the page tries: plain fetch, navigation in a frame, WebSocket.
const attempt = (page, port) => page.evaluate(async (p) => {
  await fetch(`http://127.0.0.1:${p}/f`, { mode: 'no-cors' }).catch(() => {});
  await new Promise((r) => { const w = new WebSocket(`ws://127.0.0.1:${p}/w`); w.onerror = r; w.onclose = r; w.onopen = r; setTimeout(r, 1500); });
  const f = document.createElement('iframe'); f.src = `http://127.0.0.1:${p}/i`; document.body?.append(f);
  await new Promise((r) => setTimeout(r, 500));
}, port);
const stun = (page, port) => page.evaluate(async (p) => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${p}` }] });
  pc.createDataChannel('x');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 2500));
  const sdp = pc.localDescription?.sdp ?? '';
  pc.close();
  return sdp.split('\n').filter((l) => l.startsWith('a=candidate')).length;
}, port);

// The working switch. --force-webrtc-ip-handling-policy, the similar name, had
// no effect in Chromium 1243: STUN still went out.
const WEBRTC_OFF = '--webrtc-ip-handling-policy=disable_non_proxied_udp';

// 1. Control: no proxy, so everything arrives.
{
  const tcp = await countingTcp(); const udp = await countingUdp();
  const b = await launch([]);
  await b.page.goto('about:blank');
  await attempt(b.page, tcp.port);
  check('control, no proxy: the private TCP server is reached', tcp.state.accepts > 0, `${tcp.state.accepts} accepts`);
  await stun(b.page, udp.port);
  check('control, no proxy: WebRTC STUN reaches the private UDP socket', udp.state.packets > 0, `${udp.state.packets} packets`);
  await b.close(); tcp.close(); udp.close();
}

// 2. Proxy unavailable from the start.
{
  const tcp = await countingTcp();
  const b = await launch(proxied(await closedPort()));
  await attempt(b.page, tcp.port);
  check('proxy never up: 0 TCP accepts (no direct-connect fallback)', tcp.state.accepts === 0, `${tcp.state.accepts} accepts`);
  const nav = await b.page.goto(`http://127.0.0.1:${tcp.port}/`).then(() => 'loaded', (e) => e.message.split('\n')[0]);
  check('proxy never up: navigation fails with a proxy error, 0 TCP accepts', /PROXY/.test(nav) && tcp.state.accepts === 0, nav);
  await b.close(); tcp.close();
}

// 3. Proxy dies mid-session, on a page it served.
{
  const pageSrv = await countingTcp();
  const tcp = await countingTcp();
  const proxy = await tinyProxy(pageSrv.port);
  const b = await launch(proxied(proxy.port));
  await b.page.goto('http://consented.test/');
  check('proxy mid-session: the page loads through the proxy', pageSrv.state.accepts > 0);
  await proxy.kill();
  await attempt(b.page, tcp.port);
  check('proxy killed mid-session: 0 TCP accepts', tcp.state.accepts === 0, `${tcp.state.accepts} accepts`);
  await b.close(); tcp.close(); pageSrv.close();
}

// 4. WebRTC does not use the proxy unless told to.
{
  const udp = await countingUdp();
  const b = await launch(proxied(await closedPort()));
  await stun(b.page, udp.port);
  check('proxy flags alone do not stop WebRTC: STUN goes past the proxy', udp.state.packets > 0, `${udp.state.packets} packets`);
  await b.close(); udp.close();
  const udp2 = await countingUdp();
  const b2 = await launch([...proxied(await closedPort()), WEBRTC_OFF]);
  await stun(b2.page, udp2.port);
  check('proxy + disable_non_proxied_udp: 0 UDP packets', udp2.state.packets === 0, `${udp2.state.packets} packets`);
  await b2.close(); udp2.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
