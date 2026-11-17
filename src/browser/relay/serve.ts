// ─────────────────────────────────────────────
//  Cascade AI — Serving a device: staying connected, and where to connect
// ─────────────────────────────────────────────
//
//  Shared by every device that runs on Node: the CLI (`cascade relay serve`) and the
//  desktop app. The extension runs the same loop in its service worker.

import { type DeviceClient, type DeviceClientOptions, connectDeviceClient } from './device.js';
import { identityFromPrivateKey, publicKeyFromText } from './capability.js';

/** What a device keeps once paired: its key, and the server it pinned. */
export interface PairedDeviceKey {
  deviceId: string;
  privateKeyPem: string;
  serverId: string;
  serverKey: string;
}

/** Where the device connects: the server's own address, as a WebSocket. */
export function relayEndpoints(serverUrl: string, info: { controlPath: string; runPath: string }): { controlUrl: string; runUrl: string } {
  const base = new URL(serverUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const at = (p: string): string => new URL(p, base).toString();
  return { controlUrl: at(info.controlPath), runUrl: at(info.runPath) };
}

export interface ServeOptions {
  stored: PairedDeviceKey;
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
  /** The connection in use, and null when it closes: for a takeover, which acts on its lease. */
  onClient?: (client: DeviceClient | null) => void;
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
    opts.onClient?.(client);
    let welcomed = false;
    try {
      await client.ready;
      welcomed = true;
      refusals = 0;
      backoff = BACKOFF_START_MS;
      opts.log('connected: runs can ask for this machine\'s browser');
    } catch { /* closed before the server accepted it: counted below */ }
    const why = await client.closed;
    opts.onClient?.(null);
    opts.signal.removeEventListener('abort', stop);
    if (opts.signal.aborted) return 'stopped';
    // Only the server turning the device away counts: a restart or an outage fails
    // before the server can say anything, and backing off waits it out.
    if (!welcomed && client.rejected() && ++refusals >= (opts.maxRefusals ?? 3)) return 'refused';
    opts.log(`disconnected (${why}); trying again in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
  return 'stopped';
}
