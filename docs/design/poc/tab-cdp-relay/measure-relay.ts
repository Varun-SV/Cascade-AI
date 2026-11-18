// Measures the relay's overhead: the same browser and local site, with and without the
// proxy and policy. Reports only what it measured, and makes no claim about a real site.
//   CHROMIUM=/path/to/chrome npx tsx docs/design/poc/tab-cdp-relay/measure-relay.ts [rounds]

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectCdp, type CdpClient } from '../../../../src/browser/relay/cdp-client.js';
import { startEgressProxy } from '../../../../src/browser/relay/egress-proxy.js';
import { makeConsent } from '../../../../src/browser/relay/egress-rules.js';
import { launchBehindProxy } from '../../../../src/browser/relay/launch.js';
import { startRequestPolicy } from '../../../../src/browser/relay/request-enforcer.js';

const CHROMIUM = process.env.CHROMIUM;
if (!CHROMIUM) throw new Error('Set CHROMIUM.');
const ROUNDS = Number(process.argv[2] ?? 60);
const FETCHES = 200;

const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const ms = (n: number): string => n.toFixed(2);

const site = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('cache-control', 'no-store');
  res.end(req.url?.startsWith('/f') ? 'ok' : '<!doctype html><title>t</title><body>page</body>');
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const sitePort = (site.address() as AddressInfo).port;

async function navAndFetch(tab: CdpClient, base: string): Promise<{ nav: number[]; fetchMs: number[] }> {
  await tab.send('Page.enable');
  const nav: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const loaded = new Promise<void>((resolve) => {
      const off = (m: { method?: string }): void => { if (m.method === 'Page.loadEventFired' && !done) { done = true; resolve(); } };
      let done = false;
      tab.on(off);
    });
    const t = performance.now();
    await tab.send('Page.navigate', { url: `${base}/p${i}` });
    await loaded;
    nav.push(performance.now() - t);
  }
  const r = await tab.send('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `(async () => { const out = []; for (let i = 0; i < ${FETCHES}; i++) { const t = performance.now(); await fetch('/f' + i); out.push(performance.now() - t); } return out; })()`,
  }) as { result: { value: number[] } };
  return { nav, fetchMs: r.result.value };
}

async function baseline(): Promise<{ nav: number[]; fetchMs: number[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
  const proc = spawn(CHROMIUM!, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise<number>((resolve) => { let b = ''; proc.stderr.on('data', (d: Buffer) => { b += String(d); const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(b); if (m) resolve(Number(m[1])); }); });
  await new Promise((r) => setTimeout(r, 300));
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
  const tab = await connectCdp(list.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
  const out = await navAndFetch(tab, `http://127.0.0.1:${sitePort}`);
  tab.close(); proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 150));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const base = await baseline();

const consent = makeConsent(['http://site.test']);
const proxy = await startEgressProxy({ consent, network: { resolve: async () => ['203.0.113.40'], dial: () => net.connect(sitePort, '127.0.0.1') } });
const browser = await launchBehindProxy({ chromiumPath: CHROMIUM, proxy });
const enforcer = await startRequestPolicy({ browserWs: browser.browserWs, tabWs: browser.tabWs, tabTargetId: browser.tabTargetId, consent });
const tab = await connectCdp(browser.tabWs);
const cpu0 = process.cpuUsage();
const rss0 = process.memoryUsage().rss;
const started = performance.now();
const enforced = await navAndFetch(tab, 'http://site.test');
const elapsed = performance.now() - started;
const cpu = process.cpuUsage(cpu0);
const rss1 = process.memoryUsage().rss;

// Recovery: how long the proxy going away takes to be noticed.
let closedAt = 0;
proxy.onClose(() => { closedAt = performance.now(); });
const t0 = performance.now();
await proxy.close();
const proxyDownMs = closedAt - t0;
const t1 = performance.now();
await enforcer.endPageActivity('blank');
const endPageMs = performance.now() - t1;
const t2 = performance.now();
const fresh = await startEgressProxy({ consent });
const relaunched = await launchBehindProxy({ chromiumPath: CHROMIUM, proxy: fresh });
const relaunchMs = performance.now() - t2;
await relaunched.close(); await fresh.close();

const row = (name: string, b: number[], e: number[]): string => `| ${name} | ${ms(pct(b, 0.5))} | ${ms(pct(b, 0.95))} | ${ms(pct(e, 0.5))} | ${ms(pct(e, 0.95))} |`;
console.log(`Chromium: ${path.basename(path.dirname(path.dirname(CHROMIUM)))}, ${ROUNDS} navigations, ${FETCHES} fetches, local site\n`);
console.log('| Measure (ms) | Baseline median | Baseline p95 | Enforced median | Enforced p95 |\n|---|---|---|---|---|');
console.log(row('Navigation', base.nav, enforced.nav));
console.log(row('Fetch', base.fetchMs, enforced.fetchMs));
console.log(`\nDevice process during the enforced run (proxy and policy, plus this script's own CDP client):`);
console.log(`- CPU: ${((cpu.user + cpu.system) / 1000 / elapsed * 100).toFixed(1)}% of one core over ${ms(elapsed)} ms`);
console.log(`- RSS: ${(rss0 / 1e6).toFixed(1)} MB before, ${(rss1 / 1e6).toFixed(1)} MB after`);
console.log(`- Proxy decisions (one per plain-http request or CONNECT): ${proxy.decisions.length}; policy decisions: ${enforcer.decisions.length}`);
console.log(`\nFailure and recovery:`);
console.log(`- Proxy close to close notification: ${ms(proxyDownMs)} ms`);
console.log(`- Ending page activity (blank): ${ms(endPageMs)} ms`);
console.log(`- A new proxy and browser, through the canary: ${ms(relaunchMs)} ms`);
tab.close(); enforcer.close(); await browser.close(); site.close();
process.exit(0);
