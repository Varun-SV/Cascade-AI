// `node:net`'s address tests, the only part the egress rules use.

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(s: string): boolean { return V4.test(s); }

export function isIPv6(s: string): boolean {
  if (!s.includes(':')) return false;
  // The URL parser is the browser's own IPv6 reader: it accepts exactly the literals a
  // URL can hold, compressed or with a trailing IPv4, and rejects the rest.
  try { return new URL(`http://[${s}]/`).hostname.length > 2; } catch { return false; }
}

export function isIP(s: string): 0 | 4 | 6 { return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0; }

export default { isIP, isIPv4, isIPv6 };
