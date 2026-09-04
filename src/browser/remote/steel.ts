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

/** How long to wait for the provider to hand back a session. */
const CREATE_TIMEOUT_MS = 60_000;

interface SteelSessionDetails {
  id?: string;
  websocketUrl?: string;
  debugUrl?: string;
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
    };
  }

  async endSession(id: string): Promise<void> {
    // Swallowed on purpose. Release is cleanup, usually running while a run is
    // already ending or being torn down; a provider that is briefly unreachable
    // must not turn "the run finished" into "the run failed". The session's own
    // idle timeout collects it on the provider side.
    try {
      await this.call('POST', `/v1/sessions/${encodeURIComponent(id)}/release`, undefined, {});
    } catch {
      // Nothing useful to do; the provider expires it on its own.
    }
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
