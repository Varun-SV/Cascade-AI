// ─────────────────────────────────────────────
//  Cascade AI — local network helpers
// ─────────────────────────────────────────────
import dns from 'node:dns';

// Node resolves `localhost` to IPv6 `::1` first, but local model servers
// (llama.cpp, Ollama, vLLM, LM Studio) bind IPv4 `127.0.0.1` by default. Browsers
// fall back to IPv4 via Happy-Eyeballs; Node's fetch/undici does not — so a
// `localhost` endpoint reads as "unreachable" from the app even when the browser
// and curl reach it fine. Prefer IPv4 resolution process-wide (also helps real
// hostnames that publish both AAAA and A records).
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older Node — ignore */ }

/**
 * Rewrite a literal `localhost` host to `127.0.0.1` so the connection is forced
 * onto IPv4 regardless of the resolver. Leaves all other hosts (IPs, real
 * hostnames) untouched. Belt-and-suspenders alongside the ipv4first order above.
 */
export function preferIpv4Host(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1');
}
