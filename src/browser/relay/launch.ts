// ─────────────────────────────────────────────
//  Cascade AI — Launching the browser behind the proxy
// ─────────────────────────────────────────────
//
//  On this path the relay launches the browser itself and never attaches to one it
//  didn't launch. A dedicated profile, so nothing of the user's is in reach. Nothing
//  is usable until a request from the tab has been seen at the proxy, and the browser
//  has shown it is a version we tested, with the settings we asked for in force.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectCdp } from './cdp-client.js';
import { type EgressProxy, PROFILE_PREFERENCES, browserProxyArgs } from './egress-proxy.js';

/**
 * The Chromium major version the browser tests ran on. Speculative loads go round
 * request interception and only a profile setting stops them, which a new version
 * could change without notice. So another version is refused: moving this number is a
 * reviewed change that the speculative-load tests have to pass.
 */
// 156 is what Playwright pins and CI runs; 153 is what the development sandbox has.
export const TESTED_CHROMIUM_MAJORS: readonly number[] = [153, 156];

/**
 * The browser's own traffic, which no page asked for and the proxy would let out to
 * public addresses. The extensions Chromium builds in also run service workers from
 * the start, which aren't a run's and which the policy would refuse. The disable flags
 * alone left sign-in, push and update checks going, so those three point nowhere.
 * Tested by counting every name the browser asks the proxy for while idle.
 */
const LAUNCH_ARGS = [
  '--disable-extensions', '--disable-component-extensions-with-background-pages',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-domain-reliability',
  '--disable-client-side-phishing-detection', '--disable-default-apps', '--no-service-autorun',
  '--no-first-run', '--no-default-browser-check',
  '--gaia-url=http://0.0.0.0:9', '--gcm-checkin-url=http://0.0.0.0:9', '--component-updater=url-source=http://0.0.0.0:9',
];

/** Browsers this module launched and verified, until a policy takes one. */
const fresh = new WeakSet<object>();

/**
 * Takes a browser for one lease's policy: true only for one this module launched, and
 * only once, so a browser another run has used can't be used again.
 */
export function claimFreshBrowser(browser: object): boolean {
  return fresh.delete(browser);
}

/** Why this browser version isn't acceptable, or null. */
export function versionProblem(browser: string): string | null {
  const major = /^(?:HeadlessChrome|Chrome)\/(\d+)\./.exec(browser)?.[1];
  return TESTED_CHROMIUM_MAJORS.includes(Number(major)) ? null : `untested browser version: ${browser || 'unknown'}`;
}

const UNREADABLE = 'browser settings unreadable';

/** Why the browser's own report of its settings isn't acceptable, or null. Anything unreadable is a problem. */
export function preferencesProblem(report: string): string | null {
  let prefs: unknown;
  try { prefs = JSON.parse(report); } catch { return UNREADABLE; }
  for (const [section, values] of Object.entries(PROFILE_PREFERENCES)) {
    for (const [name, want] of Object.entries(values)) {
      const found = (prefs as Record<string, Record<string, { value?: unknown } | undefined> | undefined> | null)?.[section]?.[name];
      if (found?.value !== want) return `${section}.${name} is not in force`;
    }
  }
  return null;
}

/**
 * The browser's own interface, such as its omnibox popup, which may appear at any moment.
 * It's chrome:// only, so nothing from a page or an earlier run can be running in it.
 */
export function isBrowserOwnUi(t: { type: string; url: string }): boolean {
  return t.type === 'browser_ui' && t.url.startsWith('chrome://');
}

/**
 * Asks the running browser, rather than trusting the file written before it started:
 * a preference the browser ignored or rewrote would otherwise pass unnoticed. Also
 * requires the leased tab to be the only target. Throws on anything else.
 */
export async function verifyLaunchedProfile(browserWs: string, tabTargetId: string): Promise<void> {
  const browser = await connectCdp(browserWs);
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'chrome://prefs-internals/' }) as { targetId: string };
    let report = '';
    try {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
      // The page may still be loading, so it counts once it's whole. Bounded: otherwise this fails below.
      for (let i = 0; i < 100 && preferencesProblem(report) === UNREADABLE; i++) {
        if (i) await new Promise((r) => setTimeout(r, 50));
        const got = await browser.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, sessionId) as { result?: { value?: unknown } };
        report = typeof got.result?.value === 'string' ? got.result.value : '';
      }
    } finally {
      await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    }
    const problem = preferencesProblem(report);
    if (problem) throw new Error(problem);
    let others = ['(not checked)'];
    for (let i = 0; i < 40 && others.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 25));
      const { targetInfos } = await browser.send('Target.getTargets') as { targetInfos: { targetId: string; type: string; url: string }[] };
      others = targetInfos.filter((t) => t.targetId !== tabTargetId && !isBrowserOwnUi(t)).map((t) => `${t.type} ${t.url}`);
    }
    if (others.length) throw new Error(`the new browser is already running something else: ${others.join(', ')}`);
  } finally { browser.close(); }
}

export interface LaunchedBrowser {
  readonly process: ChildProcess;
  readonly port: number;
  readonly browserWs: string;
  readonly tabWs: string;
  readonly tabTargetId: string;
  /** Opens the proxy. The policy calls this once it's on; nothing else should in production. */
  openEgress(): void;
  close(): Promise<void>;
}

export async function launchBehindProxy(opts: {
  chromiumPath: string; proxy: EgressProxy; extraArgs?: string[]; canaryTimeoutMs?: number; env?: NodeJS.ProcessEnv;
  /** Control tests only, to show what the settings prevent: a profile with none of them, unverified. */
  testOnlyBareProfileDir?: string;
}): Promise<LaunchedBrowser> {
  // A later --user-data-dir would win, and the run would get a profile that isn't fresh.
  if (opts.extraArgs?.some((a) => a.startsWith('--user-data-dir'))) throw new Error('the launch chooses the profile');
  const dir = opts.testOnlyBareProfileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-relay-'));
  if (!opts.testOnlyBareProfileDir) {
    fs.mkdirSync(path.join(dir, 'Default'));
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify(PROFILE_PREFERENCES));
  }
  const proc = spawn(opts.chromiumPath, [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${dir}`, ...LAUNCH_ARGS, ...browserProxyArgs(opts.proxy.port), ...(opts.extraArgs ?? []), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], ...(opts.env ? { env: opts.env } : {}) });
  const cleanup = async (): Promise<void> => {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let buf = '';
      proc.stderr?.on('data', (d: Buffer) => {
        buf += String(d);
        const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buf);
        if (m) resolve(Number(m[1]));
      });
      proc.once('exit', (code) => reject(new Error(`the browser exited (${code})`)));
      proc.once('error', reject);
    });
    // The tab can appear a moment after the debugger starts listening.
    let list: { id: string; type: string; webSocketDebuggerUrl: string }[] = [];
    for (let i = 0; i < 50 && !list.some((t) => t.type === 'page'); i++) {
      if (i) await new Promise((r) => setTimeout(r, 50));
      list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as typeof list;
    }
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string; Browser?: string };
    const wrongVersion = versionProblem(version.Browser ?? '');
    if (wrongVersion) throw new Error(wrongVersion);
    const tab = list.find((t) => t.type === 'page');
    if (!tab) throw new Error('the browser opened no tab');

    // Fail closed: traffic must be seen at the proxy before anything is served.
    const canary = opts.proxy.canaryUrl();
    const cdp = await connectCdp(tab.webSocketDebuggerUrl);
    try {
      await cdp.send('Runtime.evaluate', {
        expression: `fetch(${JSON.stringify(canary)}, { mode: 'no-cors' }).catch(() => {})`, awaitPromise: true,
      });
    } finally { cdp.close(); }
    const deadline = Date.now() + (opts.canaryTimeoutMs ?? 3000);
    while (!opts.proxy.canarySeen(canary)) {
      if (Date.now() > deadline) throw new Error('egress canary did not reach the proxy');
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!opts.testOnlyBareProfileDir) await verifyLaunchedProfile(version.webSocketDebuggerUrl, tab.id);
    const launched: LaunchedBrowser = { process: proc, port, browserWs: version.webSocketDebuggerUrl, tabWs: tab.webSocketDebuggerUrl, tabTargetId: tab.id, openEgress: () => opts.proxy.open(), close: cleanup };
    fresh.add(launched);
    return launched;
  } catch (e) {
    await cleanup();
    throw e;
  }
}
