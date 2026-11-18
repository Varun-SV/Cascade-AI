// ─────────────────────────────────────────────
//  Cascade AI — The sites a user types, as a run's consent
// ─────────────────────────────────────────────
//
//  One reading for every device: the CLI's terminal and the extension's prompt parse an
//  answer the same way.

import type { UserConsent } from './device.js';
import { bareHost, isPrivateHost } from './egress-rules.js';

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
