// ─────────────────────────────────────────────
//  Cascade AI — A CDP endpoint you run yourself
// ─────────────────────────────────────────────
//
//  The escape hatch, and the more important of the two adapters.
//
//  It takes a websocket URL and nothing else, which means it covers a
//  self-hosted Steel, a Browserless container, a bare
//  `chromium --remote-debugging-port`, or anything else that speaks CDP — with
//  no vendor account, no API key, and no dependency on a third party staying up
//  or keeping its API stable. Whatever happens to the branded adapters, this
//  one keeps working.
//
//  It has no live view. There is no session API to ask for one, because there
//  is no session API at all — the endpoint simply exists. Callers must cope
//  with `liveViewUrl` being absent rather than assume every provider offers one.

import type { RemoteBrowserProvider, RemoteBrowserSession } from './provider.js';

export class GenericCdpProvider implements RemoteBrowserProvider {
  readonly name = 'CDP endpoint';
  // The endpoint is a single browser. There is no session to allocate, so two
  // runs against it share a page — see the seam.
  readonly isolatesSessions = false;

  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  /**
   * There is no session to create — the endpoint is the session.
   *
   * `id` is a constant rather than a generated one because there is nothing to
   * look up later: `endSession` has nothing to call. Inventing a unique id
   * would imply a lifecycle this provider does not have.
   */
  async createSession(): Promise<RemoteBrowserSession> {
    return { id: 'cdp', cdpUrl: this.endpoint };
  }

  /**
   * Deliberately nothing.
   *
   * The endpoint belongs to whoever runs it and outlives any single run, so
   * "ending" it is not ours to do — closing it would take the browser away from
   * every other user of a shared endpoint. The driver still closes its own
   * connection and its pages; this is only about the browser's lifetime.
   */
  async endSession(): Promise<void> {
    // Intentionally empty. See above.
  }
}

/**
 * Whether a URL is a plausible CDP endpoint.
 *
 * Checked so a misconfiguration is a clear message at startup rather than an
 * obscure Playwright failure on the first action, and so an `http://` URL
 * pasted from a provider's docs is named as the mistake it is.
 */
export function isCdpEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'ws:' || u.protocol === 'wss:';
  } catch {
    return false;
  }
}
