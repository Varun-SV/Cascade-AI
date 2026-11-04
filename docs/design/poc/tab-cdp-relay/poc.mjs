// ─────────────────────────────────────────────────────────────────────────────
//  PoC: drive ONE tab-scoped CDP connection with Playwright's connectOverCDP
// ─────────────────────────────────────────────────────────────────────────────
//
//  Question (council #315 / PR #316): Electron's `webContents.debugger` and an
//  MV3 extension's `chrome.debugger` only give CDP for one tab, but
//  Playwright's `connectOverCDP` expects a browser-level endpoint with the
//  Target domain. How much has a relay to fake, and what breaks?
//
//  What this does:
//    1. Launches Chromium with remote debugging and connects to ONE page
//       target's WebSocket. That connection stands in for chrome.debugger /
//       webContents.debugger: commands and events for that tab only.
//    2. Runs a relay that presents a browser-level endpoint to Playwright,
//       answers the browser-level methods itself, and forwards everything
//       else to the tab under one synthetic session id.
//    3. Applies a command policy (the proposed security contract) and logs
//       every browser-level method Playwright sends.
//    4. Drives the tab through the operations Cascade's browser tool uses,
//       then tests the failure and stop paths.
//
//  Not covered: Electron's and Chrome's own debugger APIs. Each refuses some
//  domains this page connection allows, so the real adapters still need
//  their own smoke tests (see the design doc, §3).
//
//  Run from the repo root:  node docs/design/poc/tab-cdp-relay/poc.mjs
//  Chromium: CHROMIUM=/path/to/chrome, else Playwright's bundled browser.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { WebSocket, WebSocketServer } = require('ws');

const TAB_SESSION = 'cascade-tab-1';
const results = [];
const browserLevelCalls = new Map();
const denied = [];
const tabMethods = new Set();
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. A browser and one tab-scoped connection ──────────────────────────────

function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  return chromium.executablePath();
}

async function launchChromium() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-poc-'));
  const proc = spawn(chromiumPath(), [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) resolve(Number(m[1]));
    });
    proc.on('exit', (code) => reject(new Error(`chromium exited ${code}: ${buf.slice(-400)}`)));
  });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = list.find((t) => t.type === 'page');
  return { proc, tab };
}

// ── 2. The relay ────────────────────────────────────────────────────────────

// Proposed command contract (design §4.2). Deny-listed methods never reach
// the tab, whatever asks for them.
const DENY = new Set([
  'Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies',
  'Network.deleteCookies', 'Network.clearBrowserCookies',
  'Storage.getCookies', 'Storage.setCookies', 'Storage.clearCookies', 'Storage.clearDataForOrigin',
  'Page.setDownloadBehavior',
  'Target.createTarget', 'Target.closeTarget', 'Target.attachToTarget', 'Target.createBrowserContext',
  'SystemInfo.getInfo', 'SystemInfo.getProcessInfo',
  'Fetch.enable', 'Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.getResponseBody', 'Network.setRequestInterception',
]);

function startRelay(tabWsUrl) {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version' || req.url === '/json/version/') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        Browser: 'Cascade-Relay/0', 'Protocol-Version': '1.3',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/relay`,
      }));
      return;
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server });
  const state = { client: null, tab: null, targetInfo: null };

  wss.on('connection', (client) => {
    state.client = client;
    const tab = new WebSocket(tabWsUrl, { perMessageDeflate: false });
    state.tab = tab;
    let nextId = 1;
    const pending = new Map(); // relayId -> { clientId, sessionId }
    const queue = [];
    const sendTab = (msg) => (tab.readyState === WebSocket.OPEN ? tab.send(JSON.stringify(msg)) : queue.push(msg));
    tab.on('open', () => { while (queue.length) tab.send(JSON.stringify(queue.shift())); });
    const reply = (id, sessionId, body) => client.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), ...body }));
    const emit = (method, params, sessionId) => client.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));

    tab.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        reply(p.clientId, p.sessionId, msg.error ? { error: msg.error } : { result: msg.result });
      } else {
        // Events: a nested session (iframe/worker) keeps its own id; the tab's
        // own events are re-labelled with the synthetic tab session.
        emit(msg.method, msg.params, msg.sessionId ?? TAB_SESSION);
      }
    });
    // Fail closed: losing the tab drops Playwright's connection.
    tab.on('close', () => client.close(1011, 'tab gone'));
    client.on('close', () => tab.close());

    client.on('message', async (raw) => {
      const msg = JSON.parse(raw);
      const { id, method, params = {}, sessionId } = msg;

      if (DENY.has(method)) {
        denied.push(method);
        return reply(id, sessionId, { error: { code: -32000, message: `Denied by Cascade relay policy: ${method}` } });
      }

      if (!sessionId) {
        browserLevelCalls.set(method, (browserLevelCalls.get(method) ?? 0) + 1);
        switch (method) {
          case 'Browser.getVersion':
            return reply(id, null, { result: { protocolVersion: '1.3', product: 'Chrome/Cascade-Relay', revision: '', userAgent: 'Cascade-Relay', jsVersion: '' } });
          case 'Target.setAutoAttach': {
            reply(id, null, { result: {} });
            const info = await new Promise((resolve) => {
              const rid = nextId++;
              const onMsg = (r) => { const m = JSON.parse(r); if (m.id === rid) { tab.off('message', onMsg); resolve(m.result.targetInfo); } };
              tab.on('message', onMsg);
              sendTab({ id: rid, method: 'Target.getTargetInfo' });
            });
            state.targetInfo = { ...info, attached: true, browserContextId: 'cascade-default' };
            return emit('Target.attachedToTarget', { sessionId: TAB_SESSION, targetInfo: state.targetInfo, waitingForDebugger: false });
          }
          case 'Target.getTargetInfo':
            return reply(id, null, { result: { targetInfo: state.targetInfo ?? { targetId: 'browser', type: 'browser', title: '', url: '', attached: true } } });
          case 'Browser.setDownloadBehavior':
            // Playwright sends this on connect. Answered here and NOT applied:
            // the agent never gets to redirect the user's downloads.
            return reply(id, null, { result: {} });
          case 'Target.getBrowserContexts':
            return reply(id, null, { result: { browserContextIds: [] } });
          case 'Browser.getWindowForTarget':
            return reply(id, null, { result: { windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } } });
          default:
            return reply(id, null, { error: { code: -32601, message: `Relay: browser-level ${method} not supported for a single tab` } });
        }
      }

      tabMethods.add(method);
      const rid = nextId++;
      pending.set(rid, { clientId: id, sessionId });
      // The synthetic tab session is stripped; nested sessions pass through.
      sendTab(sessionId === TAB_SESSION ? { id: rid, method, params } : { id: rid, method, params, sessionId });
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, wss, state, port: server.address().port })));
}

// ── 3. A test site ──────────────────────────────────────────────────────────

function startSite() {
  const pages = {
    '/': `<!doctype html><title>PoC home</title>
      <h1>Cascade relay PoC</h1>
      <form onsubmit="event.preventDefault(); document.querySelector('#out').textContent = 'Hello ' + this.name.value; console.log('submitted', this.name.value);">
        <label>Name <input name="name"></label>
        <select name="plan"><option>Free</option><option>Pro</option></select>
        <button>Send</button>
      </form>
      <p id="out"></p>
      <a href="/two">Next page</a>
      <iframe src="/frame" title="child"></iframe>
      <script>document.cookie = 'visible=1; path=/';</script>`,
    '/two': '<!doctype html><title>Page two</title><p id="two">Second page</p>',
    '/frame': '<!doctype html><p id="inframe">Inside the frame</p>',
  };
  const server = http.createServer((req, res) => {
    const body = pages[req.url.split('?')[0]];
    if (!body) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') res.setHeader('set-cookie', 'session=secret-http-only; HttpOnly; Path=/');
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// ── 4. Drive it ─────────────────────────────────────────────────────────────

const site = await startSite();
const { proc, tab } = await launchChromium();
const relay = await startRelay(tab.webSocketDebuggerUrl);
console.log(`Playwright ${require('playwright-core/package.json').version}; relay on :${relay.port}\n`);

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${relay.port}`);
  const context = browser.contexts()[0];
  // The tab is announced just after setAutoAttach returns, so it may arrive
  // a moment after connectOverCDP resolves.
  const page = context?.pages()[0] ?? await context?.waitForEvent('page', { timeout: 5000 });
  check('connectOverCDP sees exactly one context and one page', !!page && browser.contexts().length === 1 && context.pages().length === 1);

  await page.goto(site.url);
  check('navigate', (await page.title()) === 'PoC home');

  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.fill('input[name=name]', 'Varun');
  await page.selectOption('select[name=plan]', 'Pro');
  await page.click('button');
  await page.waitForFunction(() => document.querySelector('#out').textContent.length > 0);
  check('fill, select, click', (await page.textContent('#out')) === 'Hello Varun');
  check('console events arrive', logs.some((l) => l.includes('submitted Varun')), logs.join(' | '));

  check('evaluate', (await page.evaluate(() => 6 * 7)) === 42);

  const frame = page.frames().find((f) => f.url().endsWith('/frame'));
  check('same-origin iframe content', !!frame && (await frame.textContent('#inframe')) === 'Inside the frame');

  const snapshot = await page.locator('body').ariaSnapshot();
  check('accessibility snapshot (page views)', snapshot.includes('heading "Cascade relay PoC"'));

  const shot = await page.screenshot();
  check('screenshot', shot.length > 1000, `${shot.length} bytes`);

  await Promise.all([page.waitForURL('**/two'), page.click('a')]);
  check('navigation by link + waitForURL', (await page.textContent('#two')) === 'Second page');
  // In a browser Playwright did not launch, back/forward can restore from the
  // back-forward cache and never fire "load", so waiting for load hangs. That
  // happens over a direct connectOverCDP too (no relay), so wait for commit.
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => document.title === 'PoC home');
  check('history back (waitUntil: commit; bfcache)', (await page.title()) === 'PoC home');

  let newPageError = '';
  try { await context.newPage(); } catch (e) { newPageError = e.message.split('\n')[0]; }
  check('new tab is refused (single-tab lease)', newPageError.length > 0, newPageError);

  let cookieError = '';
  try { await context.cookies(); } catch (e) { cookieError = e.message.split('\n')[0]; }
  check('cookie APIs are denied by policy', cookieError.includes('Denied'), cookieError);

  const jsCookie = await page.evaluate(() => document.cookie);
  check('LIMIT: page script still reads non-HttpOnly cookies', jsCookie.includes('visible=1'), `document.cookie = "${jsCookie}"`);
  check('HttpOnly cookie is not readable from page script', !jsCookie.includes('secret-http-only'));

  // Stop: the relay drops the tab connection while a command is in flight.
  const inFlight = page.waitForFunction(() => false, null, { timeout: 10_000 }).then(() => 'resolved', (e) => e.message.split('\n')[0]);
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  relay.state.tab.close();
  const outcome = await inFlight;
  const ms = Date.now() - t0;
  check('Stop fails closed: in-flight command rejects', outcome !== 'resolved', `${outcome} (${ms} ms)`);
  check('Stop takes effect within 1 s', ms < 1000, `${ms} ms`);
  check('browser reports disconnected after Stop', !browser.isConnected());

  const list = await (await fetch(`http://127.0.0.1:${new URL(tab.webSocketDebuggerUrl).port}/json/list`)).json();
  check('the user\'s tab survives the agent disconnecting', list.some((t) => t.id === tab.id));
} catch (e) {
  check('unexpected error', false, e.stack?.split('\n').slice(0, 3).join(' / '));
} finally {
  await browser?.close().catch(() => {});
  relay.server.close();
  site.server.close();
  proc.kill();
}

console.log('\nBrowser-level methods Playwright sent (no session id):');
for (const [m, n] of browserLevelCalls) console.log(`  ${m} ×${n}`);
console.log(`Tab-level methods Playwright used (${tabMethods.size}): ${[...tabMethods].sort().join(', ')}`);
console.log(`Denied by policy: ${[...new Set(denied)].join(', ') || 'none'}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
