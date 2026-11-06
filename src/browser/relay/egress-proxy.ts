// ─────────────────────────────────────────────
//  Cascade AI — The device-side egress proxy
// ─────────────────────────────────────────────
//
//  Chromium's Fetch domain never pauses a WebSocket handshake, and a name that
//  resolves to a private address looks public to anything that only sees the name.
//  So the browser runs behind this proxy, loopback included. For every plain http
//  request and every CONNECT, before any upstream byte:
//
//    1. Resolve the host once. An IP literal is its own address.
//    2. Refuse if the host, or ANY address it resolved to, is private, unless the
//       exact origin was confirmed as private AND names a private host itself.
//    3. Dial exactly a checked address. There is no second lookup.
//
//  TLS passes through as CONNECT host:port: this proxy doesn't terminate it, installs
//  no certificate and never sees content. See docs/design/stage-1-plan.md section 3.

import { randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { type Consent, bareHost, isPrivateHost } from './egress-rules.js';

export interface ProxyNetwork {
  /** Every address of a name. */
  resolve(name: string): Promise<string[]>;
  /** A connection to exactly this address. */
  dial(address: string, port: number): Socket;
}

export const systemNetwork: ProxyNetwork = {
  resolve: async (name) => (await dns.lookup(name, { all: true })).map((a) => a.address),
  dial: (address, port) => net.connect(port, address),
};

export interface ProxyDecision {
  kind: 'http' | 'connect';
  host: string;
  port: string;
  allowed: boolean;
  addresses: string[];
  dialed: string | null;
  reason: string;
}

export interface EgressProxy {
  readonly port: number;
  readonly decisions: readonly ProxyDecision[];
  /** A URL only this proxy answers, for checking traffic really goes through it. */
  canaryUrl(): string;
  canarySeen(url: string): boolean;
  /**
   * Lets traffic through. Until then everything but the canary is refused, before any
   * name is looked up: a browser asks for update and suggestion hosts as it starts, and
   * nothing should leave before the policy is on.
   */
  open(): void;
  /**
   * Stops traffic for good: everything is refused again, and connections already through
   * are cut. The browser outlives the lease, with anything it still has registered.
   */
  shut(): void;
  /** Called once when the proxy stops, for any reason. Revoke the lease here. */
  onClose(fn: () => void): void;
  close(): Promise<void>;
}

const CANARY_HOST = 'cascade-egress-canary.invalid';
const HOP_BY_HOP = /^(proxy-connection|proxy-authorization|proxy-authenticate|keep-alive|te|trailer|transfer-encoding|upgrade)$/i;
const defaultPort = (proto: string): string => (proto === 'https:' || proto === 'wss:' ? '443' : '80');

export async function startEgressProxy(opts: { consent: Consent; network?: ProxyNetwork }): Promise<EgressProxy> {
  const network = opts.network ?? systemNetwork;
  const decisions: ProxyDecision[] = [];
  const canaries = new Set<string>();
  const seenCanaries = new Set<string>();
  const closers: (() => void)[] = [];
  const sockets = new Set<Socket>();
  const confirmedPrivate = new Set([...opts.consent.privateOrigins].map((o) => {
    const u = new URL(o);
    return `${bareHost(u.hostname)}:${u.port || defaultPort(u.protocol)}`;
  }));

  let phase: 'closed' | 'open' | 'shut' = 'closed';
  const decide = async (kind: ProxyDecision['kind'], host: string, port: string): Promise<{ address: string; port: number } | null> => {
    const bare = bareHost(host);
    const record: ProxyDecision = { kind, host, port, allowed: false, addresses: [], dialed: null, reason: '' };
    decisions.push(record);
    if (phase === 'closed') { record.reason = 'no policy is on yet'; return null; }
    if (phase === 'shut') { record.reason = 'the lease is over'; return null; }
    try { record.addresses = net.isIP(bare) ? [bare] : await network.resolve(bare); } catch { record.addresses = []; }
    // The lookup takes time, and the lease may have ended during it.
    if ((phase as string) === 'shut') { record.reason = 'the lease is over'; return null; }
    if (!record.addresses.length) { record.reason = 'name does not resolve'; return null; }
    const privateAddresses = record.addresses.filter((a) => isPrivateHost(a));
    const nameIsPrivate = isPrivateHost(bare);
    // Consent covers the origin the user saw, not whatever a DNS answer points at.
    const covered = nameIsPrivate && confirmedPrivate.has(`${bare}:${port}`);
    if ((nameIsPrivate || privateAddresses.length) && !covered) {
      record.reason = nameIsPrivate ? 'private-network destination' : 'resolves to a private-network address';
      return null;
    }
    record.allowed = true;
    record.dialed = record.addresses[0]!;
    return { address: record.dialed, port: Number(port) };
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      let u: URL;
      try { u = new URL(req.url ?? ''); } catch { res.statusCode = 400; res.end(); return; }
      if (u.hostname === CANARY_HOST) {
        const token = u.pathname.slice(1);
        if (canaries.has(token)) seenCanaries.add(token);
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end();
        return;
      }
      const to = await decide('http', u.hostname, u.port || defaultPort(u.protocol));
      if (!to) { res.statusCode = 403; res.end(); return; }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.test(k)));
      const out = http.request({
        createConnection: () => network.dial(to.address, to.port),
        method: req.method, path: `${u.pathname}${u.search}`, headers,
      }, (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      });
      out.on('error', () => { if (!res.headersSent) res.statusCode = 502; res.end(); });
      req.pipe(out);
    })();
  });

  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  server.on('connect', (req, socket: Socket, head) => {
    socket.on('error', () => {});
    void (async () => {
      const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
      const to = m ? await decide('connect', m[1]!, m[2]!) : null;
      if (!to) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const out = network.dial(to.address, to.port);
      sockets.add(out);
      out.on('close', () => sockets.delete(out));
      out.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) out.write(head);
        out.pipe(socket);
        socket.pipe(out);
      });
      out.on('error', () => socket.destroy());
      socket.on('close', () => out.destroy());
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let closing: Promise<void> | null = null;
  server.on('close', () => { for (const fn of closers) fn(); });

  return {
    port: (server.address() as AddressInfo).port,
    decisions,
    open() { if (phase === 'closed') phase = 'open'; },
    shut() {
      phase = 'shut';
      for (const s of sockets) s.destroy();
    },
    canaryUrl() {
      const token = randomBytes(12).toString('hex');
      canaries.add(token);
      return `http://${CANARY_HOST}/${token}`;
    },
    canarySeen: (url) => seenCanaries.has(url.slice(url.lastIndexOf('/') + 1)),
    onClose(fn) { closers.push(fn); },
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
      return closing;
    },
  };
}

/** The arguments that put a browser behind the proxy. Stage-1-plan section 3. */
export function browserProxyArgs(port: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${port}`,
    // Chromium bypasses a proxy for loopback unless told not to.
    '--proxy-bypass-list=<-loopback>',
    // WebRTC otherwise sends UDP straight past the proxy. The similar-looking
    // --force-webrtc-ip-handling-policy had no effect on Chromium 1243.
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
  ];
}

/**
 * The same WebRTC rule as a second layer, and the one switch that stops speculative
 * loads. Speculation rules prefetch and prerender from the browser process, so request
 * interception never sees them: a page could load a same-site document without consent,
 * with its cookies. Chromium 1243 has no flag that stops this (`--disable-features=Prerender2`
 * and `--disable-blink-features=SpeculationRules` don't, nor does `Page.setPrerenderingAllowed`).
 */
export const PROFILE_PREFERENCES = {
  net: { network_prediction_options: 2 },
  webrtc: { ip_handling_policy: 'disable_non_proxied_udp' },
} as const;
