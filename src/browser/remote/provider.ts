// ─────────────────────────────────────────────
//  Cascade AI — Remote browser providers
// ─────────────────────────────────────────────
//
//  The web app cannot do what the desktop does. On the desktop there is a real
//  Chromium the user is signed into and can watch; in a Railway container there
//  is no browser at all, and running one inside the container is the wrong
//  answer twice over:
//
//    - It is an SSRF engine. A page's own JavaScript issues requests that URL
//      validation never sees, so the request-level guard in `safeFetch` is
//      bypassed by construction — and that browser sits inside the trust
//      boundary, one hop from the container's metadata endpoint and any
//      sibling service on the private network.
//    - It costs 200-400 MB of resident memory per session, against Railway
//      tiers that start at 512 MB.
//
//  Pointing at a browser someone else runs removes both. The browser is outside
//  our trust boundary, so reaching our internals is not a thing it can do, and
//  the memory is not ours. What we give up is that the remote browser is NOT
//  signed into anything — so this surface is for public-web work, and the
//  desktop remains the place for anything authenticated.
//
//  Everything speaks CDP, so the driver is identical across providers and only
//  the session lifecycle differs. That is what this seam is: `createSession`
//  and `endSession`, and nothing else.

/** A live browser session somebody else is hosting. */
export interface RemoteBrowserSession {
  /** The provider's id for this session, needed to end it. */
  id: string;
  /**
   * CDP endpoint to drive, for Playwright's `connectOverCDP`.
   *
   * Carries the provider's credentials in most cases (a token in the query
   * string), so it is as sensitive as the API key and must never be logged.
   */
  cdpUrl: string;
  /**
   * A page showing the live session, embeddable in an iframe.
   *
   * A CAPABILITY URL: providers issue it deliberately without a token so it can
   * be handed to a viewer, which means anyone holding it can watch and — where
   * the provider supports input passthrough — drive the browser. It must never
   * be persisted in run history, written to a log, or sent to any client other
   * than the one that owns the run.
   */
  liveViewUrl?: string;
}

/**
 * Somewhere to get a browser from.
 *
 * Deliberately tiny. Everything a session DOES goes over CDP and is identical
 * whoever hosts it; only obtaining and releasing one differs, so those are the
 * only two things a provider has to implement. That keeps a new adapter to a
 * few dozen lines and keeps provider-specific behaviour from leaking into the
 * driver.
 */
export interface RemoteBrowserProvider {
  /** A short name for messages the model and the user see. */
  readonly name: string;
  /**
   * Whether `createSession` yields a browser of its own.
   *
   * False for a bare CDP endpoint, and the consequence is not cosmetic: that
   * endpoint IS one browser, so two "sessions" against it are the same browser
   * and, taking `contexts()[0].pages()[0]`, the same PAGE. Two runs would then
   * type into each other's forms — across users on a shared deployment.
   *
   * A provider that cannot isolate is therefore capped at one concurrent run
   * whatever the configured limit says. Raising a limit must not silently buy
   * concurrency the provider cannot actually deliver.
   */
  readonly isolatesSessions: boolean;
  createSession(signal?: AbortSignal): Promise<RemoteBrowserSession>;
  endSession(id: string): Promise<void>;
}

/** How the host was told to obtain browsers. */
export interface RemoteBrowserConfig {
  /** `cdp` for an endpoint you run; `steel` for a Steel deployment. */
  provider?: 'cdp' | 'steel';
  /**
   * For `cdp`, the websocket endpoint to connect to.
   * For `steel`, the API base — defaults to Steel's hosted API.
   */
  url?: string;
  apiKey?: string;
  /**
   * Concurrent sessions allowed. One by default, and deliberately so: every
   * session is billed, and a wave of workers each opening their own is a cost
   * the user did not choose. Raising it is a decision, not a default.
   */
  maxSessions?: number;
}
