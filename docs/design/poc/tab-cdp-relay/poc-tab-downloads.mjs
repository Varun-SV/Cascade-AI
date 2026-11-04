// Tab-scoped download prevention: can a download be tied to the leased tab,
// and cancelled, without touching a download the user starts in another tab?
//
// Outcome (design §4.1): no. URL matching also cancelled a user download of
// the same URL in another tab, and a real DownloadItem has no tab id, so the
// extension does NOT cancel downloads. It ends the lease when the leased
// tab's own session reports Page.downloadWillBegin (which this run shows is
// tab-specific). Kept as the evidence for that decision.
//
// Stand-ins (this is CDP, not the real extension):
// - The leased tab's own debugger session (what chrome.debugger gives the
//   extension) enables Page events and reports `Page.downloadWillBegin`.
// - A browser-level session stands in for `chrome.downloads`: it sees every
//   download (`Browser.downloadWillBegin`, like `downloads.onCreated`) and can
//   cancel one (`Browser.cancelDownload`, like `downloads.cancel`).
// A download is cancelled only when the leased tab announced its exact URL.
// Anything else is left alone, so ownership is never guessed.
//
// Also measures whether `Page.setDownloadBehavior` on one tab's session is
// really tab-scoped (it is the obvious alternative).
//
// Run: CHROMIUM=<path to chrome> node docs/design/poc/tab-cdp-relay/poc-tab-downloads.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { WebSocket } = require('ws');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const routes = new Map(Object.entries({
  '/file': (req, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', 'attachment; filename="report.bin"');
    res.end('secret bytes');
  },
  // Sends its bytes over ~1.5 s, so a cancel decided on the first event lands
  // before the file is complete (the stand-in has no way to hold a download).
  '/slow': (req, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', 'attachment; filename="slow.bin"');
    let n = 0;
    const t = setInterval(() => { res.write('x'.repeat(1024)); if (++n === 15) { clearInterval(t); res.end(); } }, 100);
    req.on('close', () => clearInterval(t));
  },
  '/dl': (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>downloads</title>
      <a id="attach" href="/file">attachment</a>
      <a id="slow" href="/slow">slow attachment</a>
      <a id="blob" download="note.txt" href="#">blob</a>
      <script>document.querySelector('#blob').href = URL.createObjectURL(new Blob(['local note ' + Math.random()]));</script>`);
  },
}));
const server = http.createServer((req, res) => {
  const route = routes.get(req.url.split('?')[0]);
  if (typeof route !== 'function') { res.statusCode = 404; return res.end(); }
  route(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

function cdpClient(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let id = 1;
  const pending = new Map();
  const listeners = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (typeof msg.method === 'string') {
      for (const fn of listeners) fn(msg);
    }
  });
  return {
    ready: new Promise((r) => ws.on('open', r)),
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const i = id++; pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    listen: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-dl-'));
const proc = spawn(process.env.CHROMIUM || chromium.executablePath(), [
  '--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const port = await new Promise((resolve) => {
  proc.stderr.on('data', (d) => { const m = /DevTools listening on ws:\/\/[^:]+:(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
});
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();

const browser = cdpClient(version.webSocketDebuggerUrl);
await browser.ready;

async function openTab(url) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Page.navigate', { url }, sessionId);
  await sleep(500);
  return { targetId, sessionId };
}
const click = (tab, selector) => browser.send('Runtime.evaluate', {
  expression: `document.querySelector(${JSON.stringify(selector)}).click()`,
}, tab.sessionId);
const scriptDownload = (tab) => browser.send('Runtime.evaluate', {
  expression: `(() => { const a = document.createElement('a'); a.href = '/file?s=' + Math.random(); a.download = 'x.bin'; document.body.append(a); a.click(); })()`,
}, tab.sessionId);

const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-dl-out-'));
const files = () => fs.readdirSync(dlDir).filter((f) => !f.endsWith('.crdownload'));
const waitFiles = async (n) => { for (let i = 0; i < 40 && files().length < n; i++) await sleep(100); return files().length; };
const settle = () => sleep(1500);

// ── 1. Is Page.setDownloadBehavior on one tab tab-scoped? ───────────────────
{
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  const leased = await openTab(`${ORIGIN}/dl`);
  const other = await openTab(`${ORIGIN}/dl`);
  let pageLevel = 'refused';
  try {
    await browser.send('Page.setDownloadBehavior', { behavior: 'deny' }, leased.sessionId);
    pageLevel = 'accepted';
  } catch (e) { pageLevel = `refused: ${e.message}`; }
  const before = files().length;
  await click(other, '#attach');
  await settle();
  const otherWrote = files().length - before;
  check(
    'Page.setDownloadBehavior is NOT tab-scoped: denying it on the leased tab also blocks the other tab',
    pageLevel === 'accepted' && otherWrote === 0,
    `call ${pageLevel}; other tab wrote ${otherWrote} file(s)`,
  );
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
  await browser.send('Target.closeTarget', { targetId: leased.targetId });
  await browser.send('Target.closeTarget', { targetId: other.targetId });
}

// ── 2. Tab-scoped prevention by announced URL ───────────────────────────────
{
  for (const f of fs.readdirSync(dlDir)) fs.rmSync(path.join(dlDir, f), { force: true });
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dlDir, eventsEnabled: true });
  const leased = await openTab(`${ORIGIN}/dl`);
  const other = await openTab(`${ORIGIN}/dl`);

  // What the leased tab's own session announces (the extension's chrome.debugger view).
  const announced = new Set();
  const decisions = [];
  browser.listen((msg) => {
    if (msg.method === 'Page.downloadWillBegin' && msg.sessionId === leased.sessionId) announced.add(msg.params.url);
  });
  // What chrome.downloads sees: every download in the profile. Cancel only owned ones.
  browser.listen(async (msg) => {
    if (msg.method !== 'Browser.downloadWillBegin') return;
    await sleep(0); // let a same-tick Page event land first
    const owned = announced.has(msg.params.url);
    decisions.push({ url: msg.params.url.slice(0, 40), owned });
    if (owned) await browser.send('Browser.cancelDownload', { guid: msg.params.guid }).catch(() => {});
  });

  const progress = [];
  browser.listen((msg) => { if (msg.method === 'Browser.downloadProgress' && msg.params.state !== 'inProgress') progress.push(msg.params.state); });
  // Control: the user's own tab downloads while the lease is held.
  await click(other, '#attach');
  await click(other, '#blob');
  const userFiles = await waitFiles(2);
  check('user tab during the lease: attachment and blob downloads both complete', userFiles === 2, `${userFiles} file(s): ${fs.readdirSync(dlDir).join(', ')} progress=${JSON.stringify(progress)}`);

  // The leased tab: a (slow) attachment, a blob link and a script-made link.
  const before = files().length;
  await click(leased, '#slow');
  await click(leased, '#blob');
  await scriptDownload(leased);
  await sleep(2500);
  const ownedCount = decisions.filter((d) => d.owned).length;
  check('attribution: all 3 downloads from the leased tab were tied to it', ownedCount === 3, JSON.stringify(decisions));
  check('attribution: neither download from the user tab was tied to the leased tab', decisions.filter((d) => !d.owned).length === 2);
  const slowDone = fs.readdirSync(dlDir).some((f) => fs.statSync(path.join(dlDir, f)).size === 15 * 1024);
  check('cancel by attribution: the leased tab\'s attachment never completes', !slowDone, `${files().length - before} new file(s) incl. fast blob/script ones the stand-in cannot hold`);

  // Stated limit, measured rather than assumed: the user downloads the SAME
  // http URL the leased tab announced. URL matching cannot tell them apart.
  const progressBefore = progress.length;
  await click(other, '#slow');
  await sleep(2500);
  const userSlow = progress.slice(progressBefore);
  check(
    'known limit: a user download of the exact http URL the leased tab announced is cancelled too',
    !userSlow.includes('completed'),
    `states ${JSON.stringify(userSlow)}; blob: URLs are unique per object, http(s) URLs are not`,
  );
}

browser.close();
proc.kill();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
