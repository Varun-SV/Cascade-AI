// ─────────────────────────────────────────────
//  Cascade AI — Which requests a leased tab may send
// ─────────────────────────────────────────────
//
//  Pure rules, with no I/O. Design §4.3 is the contract. Hostnames are not
//  resolved here: the egress proxy resolves each name and passes the addresses
//  through `isPrivateHost`, so a public-looking name that resolves to a private
//  address is its job, not this file's.

import net from 'node:net';

/** What the user approved for one run. Both lists hold exact origins. */
export interface Consent {
  /** Origins the run may navigate and frame. */
  readonly origins: ReadonlySet<string>;
  /**
   * Origins on the user's private network, each separately confirmed. Always a
   * subset of `origins`, and meaningful only if the origin names a private host.
   */
  readonly privateOrigins: ReadonlySet<string>;
}

export function makeConsent(origins: Iterable<string>, privateOrigins: Iterable<string> = []): Consent {
  const norm = (o: string): string => new URL(o).origin;
  const priv = new Set([...privateOrigins].map(norm));
  return { origins: new Set([...[...origins].map(norm), ...priv]), privateOrigins: priv };
}

function isPrivateV4(host: string): boolean {
  const [a, b] = host.split('.').map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

/** An IPv6 literal as eight 16-bit groups, with a trailing dotted IPv4 expanded. */
function ipv6Groups(host: string): number[] {
  let s = host;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split('.').map(Number) as [number, number, number, number];
    s = `${s.slice(0, -v4[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') as [string, string] : [s, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g || '0', 16));
}

const v4From = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** A host with brackets, zone and any root dot removed, lowercased. */
export function bareHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0]!.replace(/\.+$/, '');
}

/** Whether a name or address is on a private network, judged from its text alone. */
export function isPrivateHost(host: string): boolean {
  const h = bareHost(host);
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (net.isIPv4(h)) return isPrivateV4(h);
  if (net.isIPv6(h)) {
    const g = ipv6Groups(h);
    const zeros = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
    // IPv4 inside IPv6 is judged as the IPv4 it reaches.
    if (zeros(5) && g[5] === 0xffff) return isPrivateV4(v4From(g[6]!, g[7]!));
    if (zeros(6)) return g[6] === 0 && g[7]! <= 1 ? true : isPrivateV4(v4From(g[6]!, g[7]!));
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(v4From(g[6]!, g[7]!));
    if (g[0] === 0x2002) return isPrivateV4(v4From(g[1]!, g[2]!));
    return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00;
  }
  return false;
}

export type Verdict = { allow: true } | { allow: false; reason: string };
const ALLOW: Verdict = { allow: true };
const deny = (reason: string): Verdict => ({ allow: false, reason });

/** An origin as consent stores it: a WebSocket is judged as its http(s) origin. */
function httpOrigin(url: URL): string {
  return url.origin.replace(/^ws/, 'http');
}

/** A private destination needs its own confirmation; ordinary site consent isn't enough. */
function privateAllowed(url: URL, consent: Consent): boolean {
  return consent.privateOrigins.has(httpOrigin(url)) && isPrivateHost(url.hostname);
}

/** The verdict on one request, before it is sent. `resourceType` is CDP's. */
export function requestVerdict(rawUrl: string, resourceType: string, consent: Consent): Verdict {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return deny('unparseable URL'); }
  const web = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
  if (!web) {
    if (resourceType === 'Document') return deny(`${url.protocol} document`);
    if (url.protocol === 'file:') return deny('file: request');
    return ALLOW;
  }
  const isPrivate = isPrivateHost(url.hostname);
  if (isPrivate && !privateAllowed(url, consent)) return deny('private-network destination');
  if (resourceType === 'Document' && !consent.origins.has(httpOrigin(url))) return deny('navigation to an origin without consent');
  return ALLOW;
}

/** Whether a tab or frame showing this URL is on a site the run may show. */
export function onConsentedSite(rawUrl: string, consent: Consent): boolean {
  if (rawUrl === '' || rawUrl === 'about:blank' || rawUrl === 'about:srcdoc') return true;
  try {
    const u = new URL(rawUrl);
    // A blob: URL's origin is its creator's.
    const web = u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'blob:';
    if (!web || !consent.origins.has(u.origin)) return false;
    return !isPrivateHost(u.hostname) || consent.privateOrigins.has(u.origin);
  } catch { return false; }
}
