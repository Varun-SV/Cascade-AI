// ─────────────────────────────────────────────
//  Cascade AI — The user's own browser, through the relay
// ─────────────────────────────────────────────
//
//  A provider like the others, as far as the controller can tell: it yields a
//  CDP endpoint and takes it back. What is behind the endpoint is different.
//  There is no browser here to create. The run asks the user's device for
//  theirs, the user says yes or no on that device, and the endpoint is a
//  one-time, loopback-only pipe to it.
//
//  One provider per run, because the browser is one user's on one device. A
//  provider shared across runs, as the hosted ones are, would have nothing to
//  say about whose tab a session is.

import type { RelayHub, RelayedBrowser } from '../relay/hub.js';
import type { RemoteBrowserProvider, RemoteBrowserSession } from './provider.js';

export interface RelayProviderOptions {
  hub: RelayHub;
  /** Where the run's own CDP client reaches a claimed lease. Never leaves the server. */
  agentUrl(token: string): string;
  /** Whose run this is, and which of their devices serves it. */
  userId: string;
  deviceId: string;
  runId: string;
  now?: () => number;
}

export class RelayBrowserProvider implements RemoteBrowserProvider {
  readonly name = 'your own browser';
  // The device gives this run one tab of its own, and nothing else is in it.
  readonly isolatesSessions = true;
  // Nothing is allocated or billed: the browser is the user's.
  readonly allocatesSessions = false;

  private readonly held = new Map<string, RelayedBrowser>();
  private next = 1;

  constructor(private readonly opts: RelayProviderOptions) {}

  /**
   * Asks the device, and resolves once the user has approved and the device has
   * claimed. A refusal rejects with words fit to show: the device is offline, the
   * user said no, the browser is in use.
   */
  async createSession(signal?: AbortSignal): Promise<RemoteBrowserSession> {
    const { hub, userId, deviceId, runId } = this.opts;
    if (signal?.aborted) throw new Error('The run was stopped before its browser was asked for.');
    // A Stop while the user is still deciding withdraws the question on their device.
    const onAbort = (): void => hub.endRun(runId, 'the run was stopped');
    signal?.addEventListener('abort', onAbort, { once: true });
    let browser: RelayedBrowser;
    try {
      browser = await hub.requestBrowser({ userId, deviceId, runId });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) {
      browser.close('the run was stopped');
      throw new Error('The run was stopped while its browser was opening.');
    }
    const id = `relay-${this.next++}`;
    this.held.set(id, browser);
    void browser.closed.then(() => { this.held.delete(id); });
    const now = (this.opts.now ?? Date.now)();
    return { id, cdpUrl: this.opts.agentUrl(browser.token), expiresInMs: Math.max(0, browser.expiresAt - now) };
  }

  /** Gives the tab back. The device ends the page and closes its browser. */
  async endSession(id: string): Promise<void> {
    this.held.get(id)?.close('the run released the browser');
    this.held.delete(id);
  }
}
