// ─────────────────────────────────────────────
//  Cascade AI — Launching the browser behind the proxy
// ─────────────────────────────────────────────
//
//  On this path the relay launches the browser itself and never attaches to one it
//  didn't launch. A dedicated profile, so nothing of the user's is in reach. Nothing
//  is usable until a request from the tab has been seen at the proxy, and the browser
//  has shown it is a version we tested, with the settings and switches we asked for in
//  force. The caller chooses no switches: one later on the line would win over ours.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type CdpClient, connectCdp } from './cdp-client.js';
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

/**
 * Switches that choose where traffic goes, what can drive the browser or what runs in
 * it. Not every switch: a wrapper around the binary and the browser itself add others
 * (the development sandbox's adds several), so the rest are allowed through.
 */
const CONTROLLING_SWITCH = /^--?(no-proxy-server|proxy-|winhttp-proxy|host-resolver-rules|host-rules|ip-address-space-overrides|remote-debugging|remote-allow-origins|user-data-dir|profile-directory|load-extension|disable-extensions-except|enable-features|enable-blink-features|enable-quic|origin-to-force-quic-on|disable-web-security|ignore-certificate-errors|test-type|gaia-url|gcm-checkin-url|component-updater|webrtc-|force-webrtc-|net-log|log-net-log|ssl-key-log-file)/;
const switchName = (s: string): string => s.split('=')[0]!.replace(/^-+/, '');

/**
 * Why the running browser's own command line doesn't carry what the launch asked for,
 * or null. Everything asked for must be there, and a controlling switch must be one of
 * them, because something around the binary could add one that a request through the
 * proxy would never show. A switch given twice is refused too: the last one wins.
 */
export function commandLineProblem(reported: string, expected: readonly string[]): string | null {
  if (!reported.trim()) return 'browser command line unreadable';
  let rest = ` ${reported.replace(/\s+/g, ' ').trim()} `;
  for (const arg of expected) {
    const found = rest.indexOf(` ${arg} `);
    if (found < 0) return `missing switch: ${arg}`;
    rest = `${rest.slice(0, found)} ${rest.slice(found + arg.length + 2)}`;
  }
  const ours = new Set(expected.map(switchName));
  const extra = rest.split(' ').filter((t) => t.startsWith('-') && (CONTROLLING_SWITCH.test(t) || ours.has(switchName(t))));
  return extra.length ? `switches the launch did not ask for: ${extra.join(' ')}` : null;
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

/** A chrome:// page's text, once `whole` accepts it, or whatever it last showed. Bounded. */
async function readBrowserPage(browser: CdpClient, url: string, expression: string, whole: (text: string) => boolean): Promise<string> {
  const { targetId } = await browser.send('Target.createTarget', { url }) as { targetId: string };
  let text = '';
  try {
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    for (let i = 0; i < 100 && !whole(text); i++) {
      if (i) await new Promise((r) => setTimeout(r, 50));
      const got = await browser.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId) as { result?: { value?: unknown } };
      text = typeof got.result?.value === 'string' ? got.result.value : '';
    }
  } finally {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  }
  return text;
}

/**
 * Asks the running browser, rather than trusting what was written before it started:
 * a preference it ignored or rewrote, or a switch something else added, would otherwise
 * pass unnoticed. Also requires the leased tab to be the only target. Throws on anything else.
 */
export async function verifyLaunchedProfile(browserWs: string, tabTargetId: string, switches: readonly string[]): Promise<void> {
  const browser = await connectCdp(browserWs);
  try {
    const report = await readBrowserPage(browser, 'chrome://prefs-internals/', 'document.body ? document.body.innerText : ""', (t) => preferencesProblem(t) !== UNREADABLE);
    const problem = preferencesProblem(report);
    if (problem) throw new Error(problem);
    const line = await readBrowserPage(browser, 'chrome://version/', 'document.getElementById("command_line")?.textContent ?? ""', (t) => t.trim() !== '');
    const lineProblem = commandLineProblem(line, switches);
    if (lineProblem) throw new Error(lineProblem);
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
  /** Exactly what it was started with, which the running browser has to report back. */
  readonly switches: readonly string[];
  /** Opens the proxy. The policy calls this once it's on; nothing else should in production. */
  openEgress(): void;
  /** Shuts the proxy for good, and whatever is going through it. The policy calls this when the lease's page has ended. */
  shutEgress(): void;
  close(): Promise<void>;
}

/** Everything a production launch may choose. Nothing here reaches the command line. */
export interface LaunchOptions { chromiumPath: string; proxy: EgressProxy; canaryTimeoutMs?: number }
const LAUNCH_OPTION_NAMES: readonly string[] = ['chromiumPath', 'proxy', 'canaryTimeoutMs'];

/**
 * The launch every real path uses. An option it doesn't know is refused rather than
 * ignored, so code still passing switches or an environment finds out at once.
 */
export function launchBehindProxy(opts: LaunchOptions): Promise<LaunchedBrowser> {
  const unknown = Object.keys(opts).filter((k) => !LAUNCH_OPTION_NAMES.includes(k));
  if (unknown.length) return Promise.reject(new Error(`the launch takes no ${unknown.join(', ')}`));
  return launch(opts);
}

/** The only switches a test may add, each needed to reach something a test measures. None chooses where traffic goes. */
const TEST_SWITCHES = ['--unsafely-treat-insecure-origin-as-secure', '--enable-quic', '--origin-to-force-quic-on'];

export function testArgProblem(arg: string): string | null {
  return TEST_SWITCHES.includes(arg.split('=')[0]!) ? null : `not a test switch: ${arg}`;
}

/**
 * Tests only, and a test fails if anything else in src/ names this. Adds a listed
 * switch or an environment, or a control profile with none of the settings, unverified.
 */
export function launchForRelayTests(opts: LaunchOptions & { testArgs?: string[]; env?: NodeJS.ProcessEnv; bareProfileDir?: string }): Promise<LaunchedBrowser> {
  const problem = (opts.testArgs ?? []).map(testArgProblem).find(Boolean);
  return problem ? Promise.reject(new Error(problem)) : launch(opts);
}

async function launch(opts: LaunchOptions & { testArgs?: string[]; env?: NodeJS.ProcessEnv; bareProfileDir?: string }): Promise<LaunchedBrowser> {
  const dir = opts.bareProfileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-relay-'));
  if (!opts.bareProfileDir) {
    fs.mkdirSync(path.join(dir, 'Default'));
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify(PROFILE_PREFERENCES));
  }
  // Ours last: on a repeated switch, the last one wins.
  const switches = [
    ...(opts.testArgs ?? []),
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${dir}`, ...LAUNCH_ARGS, ...browserProxyArgs(opts.proxy.port),
  ];
  const proc = spawn(opts.chromiumPath, [...switches, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], ...(opts.env ? { env: opts.env } : {}) });
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
    if (!opts.bareProfileDir) await verifyLaunchedProfile(version.webSocketDebuggerUrl, tab.id, switches);
    const launched: LaunchedBrowser = { process: proc, port, browserWs: version.webSocketDebuggerUrl, tabWs: tab.webSocketDebuggerUrl, tabTargetId: tab.id, switches, openEgress: () => opts.proxy.open(), shutEgress: () => opts.proxy.shut(), close: cleanup };
    fresh.add(launched);
    return launched;
  } catch (e) {
    await cleanup();
    throw e;
  }
}
