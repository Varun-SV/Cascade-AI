// ─────────────────────────────────────────────
//  Cascade Cloud — a user's own CDP endpoint (source C)
// ─────────────────────────────────────────────
//
//  A user can give their runs a browser they run themselves: Steel, Browserless or a
//  Chrome, by its WebSocket connect URL (a token in it is theirs). The server opens a
//  connection to that address, so the address is the one thing to be careful with: a
//  URL typed by any signed-in user must never become a way to reach the server's own
//  network.
//
//  - Only wss:, with no name or password in it, and at most 2 KB. ws: only where the
//    operator allows private endpoints (a self-hosted server on its own network).
//  - The browser driver never resolves the user's host itself. It connects to a bridge
//    on loopback, and the bridge resolves the host once, refuses if the name or ANY of
//    its addresses is private, and dials exactly the address it checked. A DNS answer
//    that changes between the check and the dial has nothing left to change.
//  - The URL is stored encrypted, shown back only as its host, and never logged.
//
//  What the run does in that browser is the user's: it browses like the hosted browser
//  did, with the same approvals (decided by Varun, 17 Nov).

import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { isPrivateNetworkHost, type RemoteBrowserProvider, type RemoteBrowserSession } from '#cascade-ai';

export const MAX_ENDPOINT_URL = 2048;
/** CDP frames can be large (a page's text, a file chooser's bytes); past this the bridge closes. */
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
/** What may wait in either direction for a slow side before the bridge gives up. */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

export type EndpointCheck = { ok: true; url: URL } | { ok: false; error: string };

/** Whether a URL may be stored as a user's endpoint. Says why not, in words fit to show. */
export function checkEndpointUrl(raw: unknown, opts: { allowPrivate: boolean }): EndpointCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'Give the endpoint\'s WebSocket address.' };
  const text = raw.trim();
  if (text.length > MAX_ENDPOINT_URL) return { ok: false, error: 'That address is too long.' };
  let url: URL;
  try { url = new URL(text); } catch { return { ok: false, error: 'That is not an address.' }; }
  if (url.protocol !== 'wss:' && !(opts.allowPrivate && url.protocol === 'ws:')) {
    return { ok: false, error: opts.allowPrivate ? 'The address has to start with wss:// or ws://.' : 'The address has to start with wss://.' };
  }
  if (url.username || url.password) return { ok: false, error: 'Put a token in the address\'s query, not a name and password before the host.' };
  if (url.hash) url.hash = '';
  if (!opts.allowPrivate && isPrivateNetworkHost(url.hostname)) {
    return { ok: false, error: 'That address is on a private network, which this server doesn\'t connect to.' };
  }
  return { ok: true, url };
}

/** What Settings shows of a stored endpoint: never the path or query, where a token lives. */
export function endpointLabel(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/**
 * A DNS lookup that answers only with an address it checked: every address the name
 * resolves to must be public (unless private ones are allowed), and the first of them is
 * the one used. Shaped as Node's `lookup`, so the socket dials what was checked.
 */
export function pinnedLookup(opts: { allowPrivate: boolean; resolve?: (host: string) => Promise<string[]> }): LookupFunction {
  const resolve = opts.resolve ?? (async (host: string) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address));
  return ((hostname: string, options: unknown, callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
    const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    const refuse = (why: string): void => {
      const err = Object.assign(new Error(why), { code: 'EREFUSED' }) as NodeJS.ErrnoException;
      callback(err, wantsAll ? [] : '', 0);
    };
    const literal = net.isIP(hostname.replace(/^\[|\]$/g, '')) ? [hostname.replace(/^\[|\]$/g, '')] : null;
    void (literal ? Promise.resolve(literal) : resolve(hostname)).then((addresses) => {
      if (addresses.length === 0) { refuse(`${hostname} did not resolve`); return; }
      if (!opts.allowPrivate && (isPrivateNetworkHost(hostname) || addresses.some((a) => isPrivateNetworkHost(a)))) {
        refuse(`${hostname} resolves to a private address`);
        return;
      }
      const address = addresses[0]!;
      const family = net.isIPv6(address) ? 6 : 4;
      if (wantsAll) callback(null, [{ address, family }]);
      else callback(null, address, family);
    }, () => refuse(`${hostname} did not resolve`));
  }) as LookupFunction;
}

export interface Bridge {
  /** Where the browser driver connects: loopback, with a path no one else knows. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * A loopback WebSocket that, for each connection, opens one to the user's endpoint
 * through the pinned lookup and pipes frames both ways. Either side closing closes the
 * other. Only one path answers, and only on 127.0.0.1.
 */
export async function openBridge(target: string, opts: { allowPrivate: boolean; resolve?: (host: string) => Promise<string[]> }): Promise<Bridge> {
  const secret = randomBytes(24).toString('base64url');
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  const sockets = new Set<WebSocket>();
  wss.on('connection', (local, req) => {
    if (req.url !== `/${secret}`) { local.close(1008, 'unknown path'); return; }
    const upstream = new WebSocket(target, { lookup: pinnedLookup(opts), perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES, handshakeTimeout: 15_000 });
    // A socket leaves the set only once it has closed: a graceful close waits on the
    // other end, and the bridge ending meanwhile must still be able to cut it.
    for (const s of [local, upstream]) { sockets.add(s); s.once('close', () => sockets.delete(s)); }
    const early: Array<{ data: unknown; binary: boolean }> = [];
    let earlyBytes = 0;
    const shut = (code = 1000, why = ''): void => {
      for (const s of [local, upstream]) {
        try { s.close(code === 1005 || code === 1006 ? 1000 : code, why.slice(0, 120)); } catch { s.terminate(); }
      }
    };
    const pipe = (from: WebSocket, to: WebSocket): void => {
      from.on('message', (data, binary) => {
        if (to.readyState !== WebSocket.OPEN) {
          // The driver can speak before the endpoint has answered: hold, bounded.
          if (to === upstream && upstream.readyState === WebSocket.CONNECTING) {
            const size = Buffer.isBuffer(data) ? data.length : 0;
            if ((earlyBytes += size) > MAX_BUFFERED_BYTES) { shut(1009, 'too much before the endpoint answered'); return; }
            early.push({ data, binary });
          }
          return;
        }
        if (to.bufferedAmount > MAX_BUFFERED_BYTES) { shut(1013, 'the other side is not reading'); return; }
        to.send(data as Buffer, { binary });
      });
    };
    pipe(local, upstream);
    pipe(upstream, local);
    upstream.on('open', () => { for (const m of early.splice(0)) upstream.send(m.data as Buffer, { binary: m.binary }); });
    local.on('close', (code, reason) => shut(code, String(reason)));
    upstream.on('close', (code, reason) => shut(code, String(reason)));
    // Words fit to show; the address isn't in them, as it may carry a token.
    upstream.on('error', (e) => shut(1011, e.message.includes('private address') ? 'the endpoint resolves to a private address'
      : e.message.includes('did not resolve') ? 'the endpoint\'s host did not resolve' : 'could not reach the endpoint'));
    local.on('error', () => shut(1011));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/${secret}`,
    async close() {
      // Every socket still open or closing, and any the server holds (one turned away included).
      for (const s of [...sockets, ...wss.clients]) { try { s.terminate(); } catch { /* gone */ } }
      sockets.clear();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * The user's endpoint as a provider: each session is a bridge of its own, ended with
 * it. Nothing is allocated here or billed by Cascade; the endpoint's own provider may
 * bill its owner, which is their arrangement.
 */
export class UserEndpointProvider implements RemoteBrowserProvider {
  readonly name = 'your CDP endpoint';
  // A standing browser, as the operator's CDP endpoint was: runs on it share it.
  readonly isolatesSessions = false;
  readonly allocatesSessions = false;
  private readonly bridges = new Map<string, Bridge>();
  private next = 1;

  constructor(private readonly target: string, private readonly opts: { allowPrivate: boolean; resolve?: (host: string) => Promise<string[]> }) {}

  async createSession(signal?: AbortSignal): Promise<RemoteBrowserSession> {
    if (signal?.aborted) throw new Error('The run was stopped before its browser was opened.');
    const bridge = await openBridge(this.target, this.opts);
    const id = `endpoint-${this.next++}`;
    this.bridges.set(id, bridge);
    return { id, cdpUrl: bridge.url };
  }

  async endSession(id: string): Promise<void> {
    const b = this.bridges.get(id);
    this.bridges.delete(id);
    await b?.close();
  }

  /** Every bridge this run opened, closed. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.bridges.keys()].map((id) => this.endSession(id)));
  }
}
