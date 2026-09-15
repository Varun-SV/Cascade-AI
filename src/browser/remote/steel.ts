// ─────────────────────────────────────────────
//  Cascade AI — Steel as a browser provider
// ─────────────────────────────────────────────
//
//  Steel is the branded adapter because it exercises the parts of the seam a
//  bare CDP URL does not: a real session lifecycle (create, release) and a
//  separate live-view URL. If the seam is wrong, it is wrong here first.
//
//  Everything below is verified against the API source (steel-dev/steel-browser
//  at 2b41124), not from docs — `docs.steel.dev` is unreachable from this
//  environment:
//
//    POST /v1/sessions              -> SessionDetails
//    POST /v1/sessions/:id/release
//
//    SessionDetails (sessions.schema.ts:94-111)
//      id            uuid
//      websocketUrl  the CDP endpoint to drive
//      debugUrl      "URL for viewing the live browser instance"
//
//  THE SESSION TIMEOUT IS THE PROVIDER'S, NOT OURS. `POST /v1/sessions` accepts
//  no timeout field — verified against the same source, whose create-session
//  body takes sessionId, proxyUrl, userAgent, sessionContext, isSelenium,
//  blockAds, optimizeBandwidth, skipFingerprintInjection, deviceConfig,
//  fullscreen, logSinkUrl, extensions, persist, userDataDir, timezone,
//  dimensions, userPreferences, extra, credentials and headless, and nothing
//  else. `timeout` exists only on SessionDetails, the RESPONSE, in ms.
//
//  So the ceiling cannot be set here, only read; an env var feeding a field the
//  API ignores would let an operator believe they had bounded their spend while
//  nothing had changed, which is worse than the ceiling simply being the
//  provider's. It is read and carried on the session so a leak is explicable:
//  a session nobody released dies at exactly that number, and two field
//  sessions ended at precisely 0:05:00 with nothing recording the limit.
//
//  ONE THING IS NOT VERIFIED: the header the HOSTED service expects for an API
//  key. The open-source API has no authentication at all — there is no key
//  handling anywhere in it — and npm is blocked from here, so the hosted SDK
//  could not be read either. `steel-api-key` below is the documented
//  convention, not something confirmed; if hosted Steel rejects it, this is the
//  single line to change.
//
//  That the self-hosted API has no auth is a DEPLOYMENT fact worth stating:
//  anything that can reach it can drive it. It belongs on its own network, not
//  beside the app it serves — putting it on the same private network hands back
//  the SSRF reach that using a remote browser was meant to remove.

import type { RemoteBrowserProvider, RemoteBrowserSession } from './provider.js';

const DEFAULT_BASE = 'https://api.steel.dev';

/**
 * Whether this configuration will end up talking to Steel's hosted API.
 *
 * Lives HERE, next to the default it has to agree with, rather than in the
 * caller that needs the answer. The hosted endpoint requires a credential and a
 * self-hosted one usually does not, so something has to decide which a given
 * config is — and a server-side copy of that decision is a second definition of
 * "hosted" free to drift from the one that actually picks the URL.
 *
 * Several configs reach the hosted API and they do not look alike: no url at
 * all, an empty one (`opts.url || DEFAULT_BASE` takes the default for both),
 * the hosted host typed out in full, and the fully-qualified spelling with a
 * terminal dot. Asking about the RESOLVED destination answers all of them at
 * once, which asking about the presence of `url` cannot.
 *
 * Compared by host key, so a trailing slash, a port, a path, a different scheme,
 * a different case or a root dot cannot disguise it. A URL this cannot parse is
 * not the hosted API — and is refused earlier anyway, for being unparseable.
 */
export function isHostedSteel(url?: string): boolean {
  if (!url) return true;
  try {
    return hostKey(new URL(url).hostname) === hostKey(new URL(DEFAULT_BASE).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether this can serve as the API base — judged by what is DONE with it.
 *
 * `call()` builds every request as `${this.base}${path}`, so the base has to be
 * something a path can be appended to. A query or a fragment is not: for
 * `https://steel.internal?tenant=a`, appending `/v1/sessions` yields a POST to
 * `/` with `?tenant=a/v1/sessions` — the endpoint swallowed into the query
 * string. It parses, it looks like a URL, and it cannot reach a session.
 *
 * Refused rather than silently stripped. An operator who wrote `?tenant=a`
 * meant it, and quietly dropping it would send their requests somewhere they
 * did not ask for; saying so lets them fix it.
 *
 * Lives here for the same reason `isHostedSteel` does — beside the
 * concatenation it constrains. A caller that validates a URL against its own
 * idea of how this class uses it is a rule in two places, free to drift the
 * moment `call()` changes.
 */
export function isUsableSteelBase(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // `search`/`hash` are empty strings when absent, so this is "has one".
    return u.search === '' && u.hash === '';
  } catch {
    return false;
  }
}

/**
 * A hostname reduced to the thing DNS will actually resolve.
 *
 * `api.steel.dev.` — the fully-qualified spelling, with the root label written
 * out — is a valid URL that reaches the same service, and `URL.hostname` keeps
 * the terminal dot. Compared literally it looked like somebody else's host, so
 * the one spelling that says "resolve this exactly" was the one that slipped
 * past the check and bought an unauthenticated hosted provider.
 *
 * Stripped in a loop rather than with `/\.+$/`: the parser accepts more than
 * one trailing dot, and a greedy `+` anchored at the end is the pattern CodeQL
 * flagged on this file's slash-stripping for polynomial backtracking. A loop is
 * linear and needs no argument about who can reach it.
 */
function hostKey(hostname: string): string {
  let host = hostname.toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/** How long to wait for the provider to hand back a session. */
const CREATE_TIMEOUT_MS = 60_000;

interface SteelSessionDetails {
  id?: string;
  websocketUrl?: string;
  debugUrl?: string;
  /** The provider's own ceiling for this session, in ms. Response-only. */
  timeout?: number;
}

export class SteelProvider implements RemoteBrowserProvider {
  readonly name = 'Steel';
  // POST /v1/sessions allocates a browser per call, so concurrent runs are
  // genuinely separate.
  readonly isolatesSessions = true;

  private base: string;
  private apiKey: string | undefined;

  constructor(opts: { url?: string; apiKey?: string } = {}) {
    // Trailing slashes stripped so `${base}/v1/sessions` cannot become a double
    // slash — some gateways 404 on that, which reads as "wrong endpoint".
    //
    // Done with a loop rather than /\/+$/, which CodeQL flagged and was right
    // to: a greedy `+` anchored at the end backtracks polynomially, so a URL of
    // many slashes turns a config read into a stall. The input is
    // operator-supplied rather than attacker-supplied, which makes it unlikely
    // — not safe. A loop is linear and needs no argument about who can reach it.
    let base = opts.url || DEFAULT_BASE;
    while (base.endsWith('/')) base = base.slice(0, -1);
    this.base = base;
    this.apiKey = opts.apiKey;
  }

  async createSession(signal?: AbortSignal): Promise<RemoteBrowserSession> {
    const details = await this.call<SteelSessionDetails>('POST', '/v1/sessions', signal, {});

    // Checked rather than assumed: without a websocketUrl there is nothing to
    // drive, and failing here names the problem instead of letting Playwright
    // fail later on `connectOverCDP(undefined)`.
    if (!details.id || !details.websocketUrl) {
      throw new Error('Steel returned a session with no id or websocket URL.');
    }
    return {
      id: details.id,
      cdpUrl: details.websocketUrl,
      ...(details.debugUrl ? { liveViewUrl: details.debugUrl } : {}),
      // Carried through because it explains an otherwise mysterious death. A
      // session nobody released dies at exactly this number, and without it a
      // leak looks identical to an orderly shutdown.
      ...(typeof details.timeout === 'number' ? { expiresInMs: details.timeout } : {}),
    };
  }

  async endSession(id: string): Promise<void> {
    // Swallowed on purpose. Release is cleanup, usually running while a run is
    // already ending or being torn down; a provider that is briefly unreachable
    // must not turn "the run finished" into "the run failed". The session's own
    // idle timeout collects it on the provider side.
    // Rethrown rather than swallowed here. Both callers — `disposeRun` and
    // `openReserved`'s rollback — already catch, so this cannot turn "the run
    // finished" into "the run failed"; all the empty catch ever did was make a
    // failed release indistinguishable from a successful one. It is not: a
    // release that did not happen leaves a BILLED browser running until the
    // provider's own timeout collects it, and nothing anywhere said so.
    await this.call('POST', `/v1/sessions/${encodeURIComponent(id)}/release`, undefined, {});
  }

  private async call<T>(method: string, path: string, signal: AbortSignal | undefined, body: unknown): Promise<T> {
    // Bounded, and raced against the caller's signal: a provider that accepts
    // the connection and never answers would otherwise hold a worker open for
    // as long as the run lasts.
    const timeout = AbortSignal.timeout(CREATE_TIMEOUT_MS);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        // Sent only when configured — the self-hosted API takes no key, and an
        // empty header is worse than none.
        ...(this.apiKey ? { 'steel-api-key': this.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: composed,
    });

    if (!res.ok) {
      // The body often carries the real reason (quota, bad key, region), and
      // without it every failure reads as an unexplained number. Bounded,
      // because an error page can be a megabyte of HTML.
      const detail = await res.text().then((t) => t.slice(0, 300)).catch(() => '');
      throw new Error(`Steel ${method} ${path} failed: ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    return await res.json() as T;
  }
}
