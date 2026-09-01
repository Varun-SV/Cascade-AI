// ─────────────────────────────────────────────
//  Cascade AI — SSRF-safe fetch helper
// ─────────────────────────────────────────────
//
//  Agent-controlled URLs (web_fetch, runtime-generated tools) must not be
//  allowed to reach the loopback interface, link-local cloud metadata
//  endpoints, or private RFC-1918 networks. A prompt-injected page could
//  otherwise instruct the agent to fetch http://169.254.169.254/ and exfiltrate
//  cloud credentials, or pivot to internal services that trust the host.
//
//  This helper validates the scheme, resolves the hostname, rejects any
//  non-public address, and follows redirects MANUALLY so each hop is
//  re-validated (a public URL cannot 302 you to an internal one).
//
//  It ALSO re-checks the address at connect time (see ssrfAgent). Resolving up
//  front and then letting fetch resolve again leaves a gap: an attacker who
//  controls the name's DNS answers publicly for the check and privately for the
//  connection, and no amount of strictness in a pre-flight lookup can see that.
//
//  Set CASCADE_ALLOW_LOCAL_FETCH=1 to opt out (e.g. fetching local dev docs).

import dns from 'node:dns/promises';
import dnsCallback from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_REDIRECTS = 5;

function allowLocal(): boolean {
  return process.env['CASCADE_ALLOW_LOCAL_FETCH'] === '1';
}

/** True for loopback, link-local, private, and other non-routable ranges. */
export function isPrivateAddress(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateIPv4(ip);
  if (type === 6) return isPrivateIPv6(ip);
  // Not a literal IP — caller resolves DNS first, so treat unknown as unsafe.
  return true;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;                       // 0.0.0.0/8
  if (a === 10) return true;                      // 10.0.0.0/8 private
  if (a === 127) return true;                     // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                       // multicast / reserved
  return false;
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or null if it is not
 * one. Comparing IPv6 as TEXT does not work, which is the whole reason this
 * exists: one address has many spellings, and `new URL()` picks its own.
 */
export function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '');

  // Drop a zone index (fe80::1%eth0) — it is not part of the address.
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);

  // A trailing dotted quad (::ffff:127.0.0.1) is two groups written in
  // decimal. Fold it to hex so the rest of this function sees one format.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const o = [dotted[2], dotted[3], dotted[4], dotted[5]].map((p) => Number(p));
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;              // '::' may appear once
  const split = (part: string) => (part ? part.split(':') : []);
  const head = split(halves[0] ?? '');
  const tail = halves.length === 2 ? split(halves[1] ?? '') : [];
  const zeros = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (zeros < 0) return null;

  const groups = [...head, ...Array<string>(zeros).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/**
 * The IPv4 address an IPv6 address carries inside it, if any.
 *
 * Several IPv6 forms are just an IPv4 address in a costume, and each is a way
 * to write `127.0.0.1` or `169.254.169.254` that no amount of IPv6 prefix
 * matching will catch. Judge them by the address they actually reach.
 */
function embeddedIPv4(g: number[]): string | null {
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const leadingZero = (n: number) => g.slice(0, n).every((x) => x === 0);

  // ::ffff:a.b.c.d — IPv4-mapped, the form a dual-stack socket connects with.
  if (leadingZero(5) && g[5] === 0xffff) return quad(g[6]!, g[7]!);
  // ::a.b.c.d — IPv4-compatible. Deprecated, still accepted by some stacks.
  if (leadingZero(6)) return quad(g[6]!, g[7]!);
  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64 translation prefixes.
  if (g[0] === 0x64 && g[1] === 0xff9b) return quad(g[6]!, g[7]!);
  // 2002::/16 — 6to4, which carries the v4 address in the next two groups.
  if (g[0] === 0x2002) return quad(g[1]!, g[2]!);
  return null;
}

function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  // Not parseable as IPv6 — the caller already decided it is an IP, so
  // anything we cannot read is treated as unsafe.
  if (!g) return true;

  // An address carrying an IPv4 address is exactly as private as that address.
  // Checked BEFORE the prefix rules below, because `::ffff:7f00:1` matches no
  // IPv6 prefix at all — it is loopback only once you read the last 32 bits.
  const v4 = embeddedIPv4(g);
  if (v4) return isPrivateIPv4(v4);

  if (g.every((x) => x === 0)) return true;                 // :: unspecified
  if (leading7Zero(g) && g[7] === 1) return true;           // ::1 loopback
  if ((g[0]! & 0xffc0) === 0xfe80) return true;             // fe80::/10 link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true;             // fc00::/7 unique-local
  if ((g[0]! & 0xff00) === 0xff00) return true;             // ff00::/8 multicast
  return false;
}

function leading7Zero(g: number[]): boolean {
  return g.slice(0, 7).every((x) => x === 0);
}

/**
 * Validate that `rawUrl` is an http(s) URL whose host resolves only to public
 * addresses. Throws SsrfBlockedError otherwise. Returns the parsed URL.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError(`Blocked URL scheme "${url.protocol}" — only http and https are allowed.`);
  }

  if (allowLocal()) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // Literal IP in the URL — check directly, no DNS.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new SsrfBlockedError(`Blocked request to non-public address ${host}.`);
    }
    return url;
  }

  // Obvious local hostnames.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new SsrfBlockedError(`Blocked request to local hostname "${host}".`);
  }

  // Resolve and reject if ANY resolved address is private.
  let addresses: string[];
  try {
    const records = await dns.lookup(host, { all: true });
    addresses = records.map((r) => r.address);
  } catch {
    throw new SsrfBlockedError(`Could not resolve host "${host}".`);
  }
  if (addresses.length === 0 || addresses.some((addr) => isPrivateAddress(addr))) {
    throw new SsrfBlockedError(`Blocked request to "${host}" — resolves to a non-public address.`);
  }

  return url;
}

/**
 * The address that gets CONNECTED to, checked at the moment of connecting.
 *
 * `assertPublicUrl` resolves the hostname to decide whether to proceed, and
 * then `fetch` resolves it AGAIN to open the socket. Those are two separate
 * lookups, so a hostname whose DNS the attacker controls can answer publicly
 * for the first and with 127.0.0.1 or 169.254.169.254 for the second — a
 * check-then-resolve-again gap that a pre-flight lookup cannot close no matter
 * how strict it is. This closes it by validating inside the resolution the
 * connection itself uses: the address that passes here is the address the
 * socket goes to, with no second lookup in between.
 *
 * `assertPublicUrl` is still worth running first. It validates the scheme,
 * re-checks every redirect hop, and produces a precise message naming the host
 * — where a rejection here surfaces as a connect error. Defence in depth: the
 * pre-flight check explains, this one enforces.
 */
const ssrfAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      if (allowLocal()) {
        dnsCallback.lookup(hostname, options, callback as never);
        return;
      }
      dnsCallback.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 0);
        const list = Array.isArray(addresses) ? addresses : [addresses];
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) {
          return callback(
            new SsrfBlockedError(`Blocked connection to "${hostname}" — resolved to non-public address ${bad.address}.`),
            '',
            0,
          );
        }
        // Answer in the shape the caller asked for: undici passes `all` through
        // from its own connect options, and handing back the wrong arity here
        // fails in the socket layer rather than anywhere legible.
        if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        const first = list[0]!;
        return callback(null, first.address, first.family);
      });
    },
  },
});

/**
 * SSRF-safe fetch. Validates the initial URL and every redirect hop against
 * {@link assertPublicUrl}, and pins the connection itself to a re-validated
 * address (see {@link ssrfAgent}). Drop-in for `fetch` for agent-supplied URLs.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  let currentUrl = (await assertPublicUrl(rawUrl)).toString();

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // `dispatcher` is undici's, which is what Node's global fetch is built on;
    // it is absent from the DOM RequestInit type, hence the cast. Nothing in
    // this repo installs a global dispatcher, so scoping one here overrides no
    // proxy or pool configured elsewhere.
    const resp = await fetch(currentUrl, { ...init, redirect: 'manual', dispatcher: ssrfAgent } as RequestInit);

    // Not a redirect — return as-is.
    if (resp.status < 300 || resp.status >= 400) return resp;

    const location = resp.headers.get('location');
    if (!location) return resp;

    const next = new URL(location, currentUrl);
    await assertPublicUrl(next.toString()); // re-validate each hop
    currentUrl = next.toString();
  }

  throw new SsrfBlockedError(`Too many redirects (>${MAX_REDIRECTS}).`);
}
