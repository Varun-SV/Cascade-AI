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
 * Whether this can serve as the API base — asked of the URL ACTUALLY BUILT.
 *
 * Six rounds of review found six ways a base could look fine and not work:
 * a wrong host, a terminal dot, a query string, userinfo, a path prefix on the
 * hosted service, doubled trailing slashes. Each was answered by inspecting one
 * more component, and a seventh arrived that no component exposes — a bare `?`
 * or `#` leaves `search` and `hash` EMPTY while `href` keeps the delimiter, so
 * `${base}/v1/sessions` becomes `...?/v1/sessions` and the POST lands on `/`.
 *
 * So this stopped adding conditions and started asking the only question that
 * was ever the real one: build the request `call()` will build, and see whether
 * it addresses the endpoint. A spelling nobody has thought of yet fails this by
 * construction rather than by being enumerated.
 */
export function isUsableSteelBase(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // Checked separately — this and the port below — because `fetch` refuses
    // both before sending, so neither is a URL-shape problem the built request
    // would reveal: the request is well-formed and throws anyway.
    if (u.username !== '' || u.password !== '') return false;

    // THE request, assembled exactly as `call()` assembles it.
    const built = new URL(withoutTrailingSlashes(url) + PROBE_PATH);
    // The second member of the userinfo category, and the reason that comment
    // now says "checked separately" in the plural: `fetch` refuses a blocked
    // port before it opens a connection, so the built request is perfectly
    // well-formed and throws anyway. Nothing about the URL's shape reveals it.
    if (FETCH_BLOCKED_PORTS.has(built.port)) return false;
    // Anything that swallowed the path into a query or fragment shows up here,
    // whatever the base looked like component by component.
    if (built.search !== '' || built.hash !== '') return false;
    if (!built.pathname.endsWith(PROBE_PATH)) return false;
    // A path prefix is legitimate for a self-hosted gateway and impossible for
    // the hosted service, whose endpoints are at the root — so the same prefix
    // is correct for one base and broken for another.
    if (isHostedSteel(url) && built.pathname !== PROBE_PATH) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The ports `fetch` will not open, as strings, to compare with `URL.port`.
 *
 * Verbatim from WHATWG Fetch's "bad port" list, which is what Node implements:
 * `http://host:6000/v1/sessions` is a valid URL that builds and addresses the
 * endpoint correctly, and every request to it dies as `TypeError: fetch failed`
 * with `cause: bad port` before a packet leaves. A self-hosted Steel on 6000
 * (X11) or 587 (submission) is an unremarkable thing for an operator to do, so
 * without this the Browser control is offered for a deployment that cannot make
 * a single call.
 *
 * A literal list rather than a probe: the set is fixed by the spec, and the
 * alternative — sending a request to find out — is a network call inside what
 * has to stay a synchronous config check.
 *
 * `URL.port` is empty for a scheme's default port, which is never on this list,
 * so the ordinary 80/443 case compares against `''` and passes.
 */
const FETCH_BLOCKED_PORTS: ReadonlySet<string> = new Set([
  '1', '7', '9', '11', '13', '15', '17', '19', '20', '21', '22', '23', '25',
  '37', '42', '43', '53', '69', '77', '79', '87', '95', '101', '102', '103',
  '104', '109', '110', '111', '113', '115', '117', '119', '123', '135', '137',
  '139', '143', '161', '179', '389', '427', '465', '512', '513', '514', '515',
  '526', '530', '531', '532', '540', '548', '554', '556', '563', '587', '601',
  '636', '989', '990', '993', '995', '1719', '1720', '1723', '2049', '3659',
  '4045', '4190', '5060', '5061', '6000', '6566', '6665', '6666', '6667',
  '6668', '6669', '6679', '6697', '10080',
]);

/**
 * A real endpoint, used to test the assembly rather than a made-up one.
 *
 * `createSession` is the first request any browser makes, so if this cannot be
 * addressed the configuration cannot open a browser at all.
 */
const PROBE_PATH = '/v1/sessions';

/**
 * A URL or path with its trailing slashes removed.
 *
 * SHARED with the constructor rather than restated beside it, which is the
 * whole point. `call()` builds `${base}${path}`, so the constructor strips
 * these to stop `//v1/sessions` forming — and the usability check did its own
 * thing, comparing `pathname` literally. The two then disagreed about
 * `https://api.steel.dev//`: the provider normalises it to the working hosted
 * base, and the check refused it and hid the Browser control for a deployment
 * that would have worked.
 *
 * Every earlier finding here was a configuration advertised and then unusable.
 * This was the mirror image — usable and refused — and it has the same cause:
 * a rule that described what the code does instead of being what the code does.
 *
 * A loop rather than `/\/+$/`, which CodeQL flagged and was right to: a greedy
 * `+` anchored at the end backtracks polynomially, so a URL of many slashes
 * turns a config read into a stall. The input is operator-supplied rather than
 * attacker-supplied, which makes it unlikely — not safe. A loop is linear and
 * needs no argument about who can reach it.
 */
function withoutTrailingSlashes(value: string): string {
  let out = value;
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
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
    // Stripped so `${base}/v1/sessions` cannot become a double slash — some
    // gateways 404 on that, which reads as "wrong endpoint". The rule itself
    // lives in `withoutTrailingSlashes`, because the usability check has to
    // apply exactly the same one.
    this.base = withoutTrailingSlashes(opts.url || DEFAULT_BASE);
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
