// ─────────────────────────────────────────────
//  Cascade extension — pairing this browser with a Cascade server
// ─────────────────────────────────────────────
//
//  The same sign-in `cascade login` uses: the server shows a code page, the user
//  approves it there, signed in. With the short-lived token that gives, the extension
//  registers the public half of a key it made, then revokes the token. What stays is
//  the device key alone: it proves this browser to the server, and holds no session.
//
//  The server's address is the user's to type, and Chrome asks them to allow that
//  site by name before anything is sent: a web page can't pair itself.

import { generateStoredKey, publicKeyFromText } from '../../src/browser/relay/capability.js';

export interface PairedDevice {
  serverUrl: string;
  deviceId: string;
  name: string;
  privateKeyPem: string;
  serverId: string;
  serverKey: string;
  controlPath: string;
  runPath: string;
}

/**
 * The server as an origin. https only; plain http just for this machine's own
 * addresses, where a development server runs.
 */
export function serverOrigin(input: string): string {
  const raw = input.trim();
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw new Error(`"${input}" is not a server address.`); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The server address has to start with https://.');
  if (u.username || u.password) throw new Error('Give the server address without a name or password in it.');
  return u.origin;
}

export interface DeviceCode { userCode: string; verificationUri: string }

export interface PairOptions {
  server: string;
  name: string;
  /** Shows the user where to approve, and the code to check there. */
  onCode(code: DeviceCode): void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed (${res.status}).`);
  return (await res.json()) as T;
}

export async function pairWithServer(opts: PairOptions): Promise<PairedDevice> {
  const f = opts.fetch ?? fetch.bind(globalThis);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const origin = serverOrigin(opts.server);
  const at = (p: string): string => `${origin}${p}`;

  // First: does this server offer the relay at all? Asked before the user signs in.
  const infoRes = await f(at('/api/browser-relay/server'));
  if (infoRes.status === 404) throw new Error('This server does not offer your own browser to runs.');
  const info = await json<{ serverId: string; serverKey: string; controlPath: string; runPath: string }>(infoRes, 'Reaching the browser relay');
  if (!publicKeyFromText(info.serverKey)) throw new Error('The server sent a key that is not one.');

  const start = await json<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>(
    await f(at('/api/native/device'), { method: 'POST' }), 'Starting sign-in');
  opts.onCode({ userCode: start.user_code, verificationUri: start.verification_uri });

  let interval = Math.max(1, start.interval) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  let tokens: { access_token: string; refresh_token: string } | null = null;
  while (!tokens) {
    if (opts.signal?.aborted) throw new Error('Pairing was cancelled.');
    if (Date.now() > deadline) throw new Error('The code expired. Start pairing again.');
    await sleep(interval);
    const res = await f(at('/api/native/device/token'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: start.device_code }),
    });
    if (res.status === 428) continue;
    if (res.status === 429) { interval += 5000; continue; }
    tokens = await json(res, 'Signing in');
  }

  try {
    const key = generateStoredKey();
    const reg = await json<{ device: { id: string; name: string }; serverId: string; serverKey: string }>(
      await f(at('/api/browser-relay/devices'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}` },
        body: JSON.stringify({ name: opts.name, kind: 'extension', publicKey: key.publicKey }),
      }), 'Registering this browser');
    if (reg.serverId !== info.serverId || reg.serverKey !== info.serverKey) throw new Error('The server changed its identity while pairing. Nothing was saved.');
    return {
      serverUrl: origin, deviceId: reg.device.id, name: reg.device.name, privateKeyPem: key.privateKeyPem,
      serverId: info.serverId, serverKey: info.serverKey, controlPath: info.controlPath, runPath: info.runPath,
    };
  } finally {
    // The sign-in was only for this. Its refresh token goes now, success or not.
    await f(at('/api/native/logout'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    }).catch(() => {});
  }
}

/** Where the device connects, from the paired server. */
export function endpointsOf(d: Pick<PairedDevice, 'serverUrl' | 'controlPath' | 'runPath'>): { controlUrl: string; runUrl: string } {
  const base = new URL(d.serverUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return { controlUrl: new URL(d.controlPath, base).toString(), runUrl: new URL(d.runPath, base).toString() };
}
