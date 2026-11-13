// ─────────────────────────────────────────────
//  Cascade AI — `cascade relay`: this machine's browser, for your cloud runs
// ─────────────────────────────────────────────
//
//  A run on Cascade Cloud can use a browser on your own machine instead of one the
//  server hosts. This command makes the machine one of your devices and serves it:
//
//    cascade relay pair     register this machine (a key made here; only its public half is sent)
//    cascade relay serve    stay connected, and ask here before any run gets a browser
//    cascade relay devices  your registered devices, and which are online
//    cascade relay forget   remove this machine, on the server and here
//
//  Nothing runs without a yes in this terminal, and only on the sites typed in that
//  answer. Each run gets a fresh browser with its own empty profile, closed afterwards:
//  never the browser you use yourself, and nothing you are signed in to.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import { CloudClient, type RelayServerInfo } from '../../cloud/client.js';
import { globalDir } from '../../cloud/session-store.js';
import { generateStoredKey, identityFromPrivateKey, publicKeyFromText } from '../../browser/relay/capability.js';
import { connectDeviceClient, type DeviceClient, type DeviceClientOptions, type UserConsent } from '../../browser/relay/device.js';
import { startDedicatedBrowser } from '../../browser/relay/dedicated-browser.js';
import { bareHost, isPrivateHost } from '../../browser/relay/egress-rules.js';

export const RELAY_DEVICE_FILE = 'relay-device.json';

/** This machine as a device of one server. The private key never leaves this file. */
export interface StoredRelayDevice {
  serverUrl: string;
  deviceId: string;
  name: string;
  privateKeyPem: string;
  /** The server's identity, pinned when the device was registered. */
  serverId: string;
  serverKey: string;
}

export function relayDevicePath(dir: string = globalDir()): string {
  return path.join(dir, RELAY_DEVICE_FILE);
}

/** The device registered with this server, or null. A device of another server is not this one's. */
export function loadRelayDevice(serverUrl: string, dir?: string): StoredRelayDevice | null {
  try {
    const d = JSON.parse(fs.readFileSync(relayDevicePath(dir), 'utf-8')) as StoredRelayDevice;
    if (!d?.deviceId || !d.privateKeyPem || !d.serverKey || d.serverUrl !== serverUrl) return null;
    return d;
  } catch {
    return null;
  }
}

export function saveRelayDevice(device: StoredRelayDevice, dir: string = globalDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = relayDevicePath(dir);
  fs.writeFileSync(file, JSON.stringify(device, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on platforms without chmod */ }
}

export function clearRelayDevice(dir?: string): void {
  try { fs.rmSync(relayDevicePath(dir)); } catch { /* already gone */ }
}

/** Where the device connects: the server's own address, as a WebSocket. */
export function relayEndpoints(serverUrl: string, info: Pick<RelayServerInfo, 'controlPath' | 'runPath'>): { controlUrl: string; runUrl: string } {
  const base = new URL(serverUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const at = (p: string): string => new URL(p, base).toString();
  return { controlUrl: at(info.controlPath), runUrl: at(info.runPath) };
}

/**
 * The user's answer, as the sites a run may use. Empty is a no.
 *
 * Each site is an origin: `example.com` means https://example.com, and a path is
 * dropped. A site on a private network (localhost, a LAN address) is allowed only
 * because it was typed here, and is marked so: the proxy refuses those otherwise.
 */
export function parseSites(answer: string): { consent: UserConsent } | { error: string } | null {
  const words = answer.split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
  if (words.length === 0) return null;
  const allowedOrigins: string[] = [];
  const privateOrigins: string[] = [];
  for (const w of words) {
    let u: URL;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(w) ? w : `https://${w}`); } catch { return { error: `"${w}" is not a site.` }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `"${w}" is not an http or https site.` };
    if (u.username || u.password) return { error: `"${w}" has a password in it: give the site alone.` };
    const list = isPrivateHost(bareHost(u.hostname)) ? privateOrigins : allowedOrigins;
    if (!list.includes(u.origin)) list.push(u.origin);
  }
  return { consent: { allowedOrigins, privateOrigins } };
}

/** Registers this machine with the signed-in account, pinning the server it registered with. */
export async function pairDevice(client: CloudClient, name: string, dir?: string): Promise<StoredRelayDevice> {
  const info = await client.relayServer();
  if (!publicKeyFromText(info.serverKey)) throw new Error('The server sent a key that is not one.');
  const key = generateStoredKey();
  const reg = await client.registerRelayDevice({ name, kind: 'cli', publicKey: key.publicKey });
  // The same server answered both: what's pinned is what registered the device.
  if (reg.serverId !== info.serverId || reg.serverKey !== info.serverKey) throw new Error('The server changed its identity while pairing. Nothing was saved.');
  const stored: StoredRelayDevice = {
    serverUrl: client.server, deviceId: reg.device.id, name: reg.device.name,
    privateKeyPem: key.privateKeyPem, serverId: info.serverId, serverKey: info.serverKey,
  };
  saveRelayDevice(stored, dir);
  return stored;
}

export interface ServeOptions {
  stored: StoredRelayDevice;
  endpoints: { controlUrl: string; runUrl: string };
  askUser: DeviceClientOptions['askUser'];
  startBrowser: DeviceClientOptions['startBrowser'];
  log: (line: string) => void;
  /** Ends serving: the connection closes, and any run on it ends. */
  signal: AbortSignal;
  connect?: (opts: DeviceClientOptions) => DeviceClient;
  sleep?: (ms: number) => Promise<void>;
  /** Connections in a row the server closes before accepting the device, before giving up. */
  maxRefusals?: number;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Stays connected until the signal, reconnecting with backoff when the connection
 * drops. Gives up when the server keeps refusing the device: it was removed, or the
 * server is not the one this device registered with.
 */
export async function serveDevice(opts: ServeOptions): Promise<'stopped' | 'refused'> {
  const connect = opts.connect ?? connectDeviceClient;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const serverKey = publicKeyFromText(opts.stored.serverKey);
  if (!serverKey) throw new Error('The saved server key is not readable. Pair this machine again.');
  const device = identityFromPrivateKey(opts.stored.deviceId, opts.stored.privateKeyPem);
  let backoff = BACKOFF_START_MS;
  let refusals = 0;
  while (!opts.signal.aborted) {
    const client = connect({
      ...opts.endpoints, device, serverId: opts.stored.serverId, serverKey,
      askUser: opts.askUser, startBrowser: opts.startBrowser, log: opts.log,
    });
    const stop = (): void => { void client.close(); };
    opts.signal.addEventListener('abort', stop, { once: true });
    let welcomed = false;
    try {
      await client.ready;
      welcomed = true;
      refusals = 0;
      backoff = BACKOFF_START_MS;
      opts.log('connected: runs can ask for this machine\'s browser');
    } catch { /* closed before the server accepted it: counted below */ }
    const why = await client.closed;
    opts.signal.removeEventListener('abort', stop);
    if (opts.signal.aborted) return 'stopped';
    if (!welcomed && ++refusals >= (opts.maxRefusals ?? 3)) return 'refused';
    opts.log(`disconnected (${why}); trying again in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
  return 'stopped';
}

// ── The commands ─────────────────────────────

function signedIn(): CloudClient | null {
  const client = CloudClient.fromSession();
  if (!client) {
    console.log(chalk.dim('\n  Not signed in. Run `cascade login` first.\n'));
    process.exitCode = 1;
  }
  return client;
}

function fail(err: unknown): void {
  console.log(chalk.red(`\n  ${err instanceof Error ? err.message : String(err)}\n`));
  process.exitCode = 1;
}

/** Playwright's own Chromium, the version the relay is tested with. */
function defaultChromium(): string | null {
  try {
    // Built both ways: the CJS bundle has __filename, the ESM one import.meta.url.
    const from = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
    const p = (createRequire(from)('playwright') as { chromium: { executablePath(): string } }).chromium.executablePath();
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Asks in this terminal. The question is taken down if the run stops asking. */
function terminalAsk(): DeviceClientOptions['askUser'] {
  let queue = Promise.resolve();
  return (run) => {
    // One question at a time: two runs asking at once are answered in turn.
    const answer = queue.then(() => new Promise<UserConsent | null>((resolve) => {
      if (run.signal.aborted) { resolve(null); return; }
      const mins = Math.max(1, Math.round((run.expiresAt - Date.now()) / 60_000));
      console.log(chalk.magenta('\n  ◈ A cloud run wants a browser on this machine'));
      console.log(chalk.dim(`  run ${run.runId} · this question lapses in about ${mins} min`));
      console.log(chalk.dim('  It gets a fresh browser with an empty profile, closed when the run ends.'));
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (): void => {
        rl.question('  Sites it may use (e.g. example.com docs.example.com), or Enter to say no: ', (text) => {
          const parsed = parseSites(text);
          if (parsed && 'error' in parsed) { console.log(chalk.yellow(`  ${parsed.error}`)); ask(); return; }
          rl.close();
          if (!parsed) console.log(chalk.dim('  Declined.'));
          else console.log(chalk.green(`  Allowed: ${[...parsed.consent.allowedOrigins, ...parsed.consent.privateOrigins].join(' ')}`));
          resolve(parsed ? parsed.consent : null);
        });
      };
      run.signal.addEventListener('abort', () => { console.log(chalk.dim('\n  The run stopped asking.')); rl.close(); resolve(null); }, { once: true });
      ask();
    }));
    queue = answer.then(() => {}, () => {});
    return answer;
  };
}

export async function relayPairCommand(opts: { name?: string } = {}): Promise<void> {
  const client = signedIn();
  if (!client) return;
  try {
    const existing = loadRelayDevice(client.server);
    if (existing) {
      console.log(chalk.dim(`\n  This machine is already paired as "${existing.name}". \`cascade relay forget\` first to pair it again.\n`));
      return;
    }
    const stored = await pairDevice(client, (opts.name ?? os.hostname()).slice(0, 80) || 'This computer');
    console.log(chalk.green(`\n  ✓ Paired as "${stored.name}".`));
    console.log(chalk.dim('  Run `cascade relay serve` to let your cloud runs ask for its browser.\n'));
  } catch (err) { fail(err); }
}

export async function relayServeCommand(opts: { chromium?: string } = {}): Promise<void> {
  const client = signedIn();
  if (!client) return;
  const stored = loadRelayDevice(client.server);
  if (!stored) { console.log(chalk.dim('\n  This machine is not paired yet. Run `cascade relay pair` first.\n')); process.exitCode = 1; return; }
  const chromiumPath = opts.chromium ?? process.env['CASCADE_RELAY_CHROMIUM'] ?? defaultChromium();
  if (!chromiumPath) {
    console.log(chalk.red('\n  No Chromium to run. Install Playwright\'s (`npx playwright install chromium`) or pass --chromium <path>.\n'));
    process.exitCode = 1;
    return;
  }
  let endpoints: { controlUrl: string; runUrl: string };
  try { endpoints = relayEndpoints(stored.serverUrl, await client.relayServer()); } catch (err) { fail(err); return; }
  const stopping = new AbortController();
  const onSignal = (): void => stopping.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  console.log(chalk.magenta(`\n  ◈ Serving "${stored.name}" to ${stored.serverUrl}`));
  console.log(chalk.dim('  Ctrl-C to stop. Any run using this machine\'s browser ends with it.\n'));
  try {
    const outcome = await serveDevice({
      stored, endpoints, signal: stopping.signal,
      askUser: terminalAsk(),
      startBrowser: (consent) => startDedicatedBrowser({ consent, chromiumPath }),
      log: (line) => console.log(chalk.dim(`  ${line}`)),
    });
    if (outcome === 'refused') {
      console.log(chalk.red('\n  The server does not accept this device any more. It may have been removed: `cascade relay forget`, then pair again.\n'));
      process.exitCode = 1;
    } else console.log(chalk.dim('\n  Stopped.\n'));
  } catch (err) { fail(err); } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export async function relayDevicesCommand(): Promise<void> {
  const client = signedIn();
  if (!client) return;
  try {
    const devices = await client.listRelayDevices();
    const mine = loadRelayDevice(client.server)?.deviceId;
    if (devices.length === 0) { console.log(chalk.dim('\n  No devices yet. `cascade relay pair` adds this machine.\n')); return; }
    console.log(chalk.magenta('\n  ◈ Your devices\n'));
    for (const d of devices) {
      const state = d.online ? chalk.green('online ') : chalk.dim('offline');
      console.log(`  ${state}  ${d.name}${chalk.dim(`  · ${d.kind}${d.id === mine ? ' · this machine' : ''}`)}`);
    }
    console.log('');
  } catch (err) { fail(err); }
}

export async function relayForgetCommand(): Promise<void> {
  const client = signedIn();
  if (!client) return;
  const stored = loadRelayDevice(client.server);
  if (!stored) { console.log(chalk.dim('\n  This machine is not paired.\n')); return; }
  try {
    await client.removeRelayDevice(stored.deviceId).catch((err: unknown) => {
      // Already gone on the server is fine: the local key still goes.
      if (!/\(404\)/.test(String(err))) throw err;
    });
    clearRelayDevice();
    console.log(chalk.green(`\n  ✓ "${stored.name}" removed. Its key is deleted from this machine.\n`));
  } catch (err) { fail(err); }
}
