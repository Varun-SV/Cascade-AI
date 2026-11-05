// ─────────────────────────────────────────────
//  Cascade AI — Launching the browser behind the proxy
// ─────────────────────────────────────────────
//
//  On this path the relay launches the browser itself and never attaches to one it
//  didn't launch. A dedicated profile, so nothing of the user's is in reach. Nothing
//  is usable until a request from the tab has been seen at the proxy.

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectCdp } from './cdp-client.js';
import { type EgressProxy, PROFILE_PREFERENCES, browserProxyArgs } from './egress-proxy.js';

export interface LaunchedBrowser {
  readonly process: ChildProcess;
  readonly port: number;
  readonly browserWs: string;
  readonly tabWs: string;
  readonly tabTargetId: string;
  close(): Promise<void>;
}

export async function launchBehindProxy(opts: {
  chromiumPath: string; proxy: EgressProxy; extraArgs?: string[]; canaryTimeoutMs?: number;
}): Promise<LaunchedBrowser> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-relay-'));
  fs.mkdirSync(path.join(dir, 'Default'));
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify(PROFILE_PREFERENCES));
  const proc = spawn(opts.chromiumPath, [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${dir}`, ...browserProxyArgs(opts.proxy.port), ...(opts.extraArgs ?? []), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
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
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
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
    return { process: proc, port, browserWs: version.webSocketDebuggerUrl, tabWs: tab.webSocketDebuggerUrl, tabTargetId: tab.id, close: cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
