// ─────────────────────────────────────────────
//  Cascade AI — Driving a browser somebody else runs
// ─────────────────────────────────────────────
//
//  The web half of `browser_control`. It satisfies the SAME `BrowserController`
//  the desktop does, so the model sees one tool with one description whichever
//  surface it is running on — the six actions mean the same thing, and only who
//  owns the browser differs.
//
//  Two things are easier here than on the desktop, and both are worth saying so
//  a reader does not go looking for the equivalent guard:
//
//    - Selectors and values are DATA. Playwright takes them as arguments, so
//      there is no source string for a model-authored selector to escape from.
//      The Electron path passes them through JSON.stringify because it builds
//      JavaScript to run in the page; there is nothing of that shape here.
//    - `connectOverCDP` needs no browser binary. Playwright is an optional
//      dependency and the usual `npx playwright install chromium` step is for
//      LAUNCHING one; connecting to a browser someone else runs skips it.
//
//  And one thing is harder. The desktop refuses to act unless the user can see
//  the page, which is what makes its kill switch meaningful. There is no such
//  guarantee for a browser in someone else's data centre, so the equivalent
//  here is the live view: the run's owner watches the provider's stream and can
//  stop it. That is why a provider with no live view is a weaker configuration,
//  and why the caller is told rather than left to assume.

import type {
  BrowserAction,
  BrowserActionContext,
  BrowserActionOutcome,
} from '../../tools/browser-control.js';
import type { RemoteBrowserProvider, RemoteBrowserSession } from './provider.js';
import { BrowserLease } from '../lease.js';

/** Playwright's shapes, named locally so the optional dep stays optional. */
type Page = {
  url(): string;
  title(): Promise<string>;
  goto(url: string, opts?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' }): Promise<unknown>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
  press(selector: string, key: string, opts?: { timeout?: number }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  innerText(selector: string, opts?: { timeout?: number }): Promise<string>;
  on(event: string, handler: (...args: never[]) => void): void;
  isClosed(): boolean;
};
type Browser = {
  contexts(): Array<{ pages(): Page[]; newPage(): Promise<Page> }>;
  newContext(): Promise<{ pages(): Page[]; newPage(): Promise<Page> }>;
  close(): Promise<void>;
};

/** Default ceiling for a single action, matching the tool's own clamp. */
const ACTION_TIMEOUT_MS = 30_000;

export interface RemoteBrowserControllerOptions {
  provider: RemoteBrowserProvider;
  /**
   * Concurrent browser sessions. One by default: every session is billed, and
   * a wave of workers each opening their own is a cost nobody chose.
   */
  maxSessions?: number;
  /** Told when a run's live view becomes available, so the owner can watch. */
  onLiveView?: (runId: string, liveViewUrl: string | undefined) => void;
}

/** One run's browser, and the page it is working on. */
interface RunBrowser {
  session: RemoteBrowserSession;
  browser: Browser;
  page: Page;
  /** Bumped on every main-frame navigation. See the desktop's equivalent. */
  generation: number;
}

export class RemoteBrowserController {
  private provider: RemoteBrowserProvider;
  private maxSessions: number;
  /**
   * Live-view listeners, one per run.
   *
   * A single callback was fine while each run had its own controller. Now the
   * controller is shared across a deployment, so one callback would send run
   * A's live-view URL to whichever run registered last — and that URL is a
   * bearer capability for a browser somebody else is driving.
   */
  private liveViewListeners = new Map<string, (liveViewUrl: string | undefined) => void>();
  /** An embedder that wants every run's live view, told which run each is. */
  private onLiveViewAll: ((runId: string, liveViewUrl: string | undefined) => void) | undefined;

  private runs = new Map<string, RunBrowser>();
  /** Runs the user has stopped, by run id — same meaning as on the desktop. */
  private revoked = new Set<string>();
  /**
   * One lease PER RUN, because there is one browser per run.
   *
   * The desktop has a single lease because it has a single browser. Here each
   * run gets its own session, so a global lease would make run B queue behind
   * run A for a browser it was never going to use — and with no queue timeout,
   * queue for as long as A lasts. What limits runs against each other is the
   * session POOL, not the lease.
   */
  private leases = new Map<string, BrowserLease>();

  constructor(options: RemoteBrowserControllerOptions) {
    this.provider = options.provider;
    // Capped at one for a provider that cannot isolate, whatever was
    // configured. Otherwise raising the limit on a bare CDP endpoint buys no
    // concurrency at all — it just lets a second run drive the first one's
    // page, which on a shared deployment is one user typing into another's.
    const asked = Math.max(1, options.maxSessions ?? 1);
    this.maxSessions = options.provider.isolatesSessions ? asked : 1;
    // Kept as its own field rather than folded into the per-run map: it needs
    // the run id, and squeezing it in under a sentinel key lost exactly that.
    this.onLiveViewAll = options.onLiveView;
  }

  private leaseFor(runId: string): BrowserLease {
    let lease = this.leases.get(runId);
    if (!lease) {
      lease = new BrowserLease({ isRevoked: (id) => this.revoked.has(id) });
      // This host reports worker terminal states (see `actorEnded`), so no
      // timer may decide ownership: a worker waiting on a human approval
      // outlives any fixed bound.
      lease.setLifecycleReleaseWired(true);
      this.leases.set(runId, lease);
    }
    return lease;
  }

  /** The controller to hand to `Cascade.setBrowserController`. */
  get controller() {
    return (action: BrowserAction, context: BrowserActionContext) => this.act(action, context);
  }

  /** Watch one run's browser. The URL never goes to any other run's listener. */
  onLiveViewFor(runKey: string, listener: (liveViewUrl: string | undefined) => void): void {
    this.liveViewListeners.set(runKey, listener);
  }

  offLiveViewFor(runKey: string): void {
    this.liveViewListeners.delete(runKey);
  }

  private announceLiveView(runId: string, liveViewUrl: string | undefined): void {
    this.liveViewListeners.get(runId)?.(liveViewUrl);
    this.onLiveViewAll?.(runId, liveViewUrl);
  }

  /** Release every run's session. For when the deployment's config changes. */
  async dispose(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((runId) => this.endRun(runId)));
  }

  /** A worker finished; it will never ask for the browser again. */
  actorEnded(actorId: string): void {
    // Every run's lease: the caller knows which worker finished, not which run
    // it belonged to, and the call is a no-op for a lease that never saw it.
    for (const lease of this.leases.values()) lease.actorEnded(actorId);
  }

  /** The user stopped this run. Refuses further actions and clears its queue. */
  stopRun(runId: string): void {
    this.revoked.add(runId);
    this.leases.get(runId)?.dropRun(runId);
  }

  /** A run ended: release its browser rather than pay for an idle session. */
  async endRun(runId: string): Promise<void> {
    this.leases.get(runId)?.dropRun(runId);
    this.leases.delete(runId);
    const held = this.runs.get(runId);
    if (!held) return;
    this.runs.delete(runId);
    this.announceLiveView(runId, undefined);
    // Both are best-effort: a run is already over, and a provider that is
    // briefly unreachable must not turn that into a failure the user sees.
    await held.browser.close().catch(() => {});
    await this.provider.endSession(held.session.id).catch(() => {});
  }

  private async act(action: BrowserAction, context: BrowserActionContext): Promise<BrowserActionOutcome> {
    const runId = context.sessionId || 'unknown';
    const actor = context.actorId || runId;

    if (this.revoked.has(runId)) {
      return { ok: false, detail: 'The user stopped browser control for this run.' };
    }
    if (context.signal?.aborted) {
      return { ok: false, detail: 'The run was cancelled.' };
    }

    // Captured BEFORE any waiting, which is the whole point: this action was
    // planned against the page as it is NOW, and the holder is free to navigate
    // during its own sequence. Capturing it after the wait compares the page
    // with itself and can never disagree — which is exactly what the first
    // version of this did.
    const planned = this.runs.get(runId)?.generation ?? 0;

    const lease_ = this.leaseFor(runId);
    const lease = await lease_.acquire(actor, runId, context.signal);
    if (lease !== 'granted') {
      return { ok: false, detail: refusal(lease) };
    }

    // Re-checked AFTER the wait, which is unbounded while a holder works: the
    // run may have been stopped or cancelled while this actor sat in the queue.
    if (this.revoked.has(runId)) {
      lease_.releaseIfHeldBy(actor);
      return { ok: false, detail: 'The user stopped browser control for this run.' };
    }
    if (context.signal?.aborted) {
      lease_.releaseIfHeldBy(actor);
      return { ok: false, detail: 'The run was cancelled.' };
    }
    if (!(await lease_.awaitActionSlot())) {
      lease_.releaseIfHeldBy(actor);
      return { ok: false, detail: 'Another browser action is still finishing. Try again.' };
    }

    const token = lease_.beginAction();
    if (!token) {
      return { ok: false, detail: 'Another browser action is already running. Wait for it to finish.' };
    }

    try {
      const held = await this.open(runId, context.signal);
      return await this.perform(held, action, planned);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    } finally {
      lease_.endAction(token);
      // A cancelled or stopped run is finished with the browser either way, so
      // it does not keep the lease while a queued worker waits.
      if (context.signal?.aborted || this.revoked.has(runId)) lease_.releaseIfHeldBy(actor);
    }
  }

  /**
   * The run's browser, opened on first use.
   *
   * The ONE place the session cap is enforced. An earlier version also checked
   * it before taking the lease, on the reasoning that a run which cannot get a
   * session would otherwise queue forever — true when every run shared one
   * lease, and false once each run got its own, because a second run no longer
   * queues behind the first at all. Its own revert-check proved it dead: taking
   * it out changed no test. Two copies of a cap invite them to disagree.
   */
  private async open(runId: string, signal?: AbortSignal): Promise<RunBrowser> {
    const existing = this.runs.get(runId);
    if (existing && !existing.page.isClosed()) return existing;

    if (!existing && this.runs.size >= this.maxSessions) {
      throw new Error(
        `All ${this.maxSessions} browser session${this.maxSessions === 1 ? '' : 's'} are in use by other runs. ` +
        'Try again when one finishes, or raise the session limit in settings.',
      );
    }

    const playwright = await loadPlaywright();
    const session = await this.provider.createSession(signal);
    // Handed to the owner as soon as it exists, so the user can watch from the
    // first action rather than after it. A CAPABILITY URL — see the provider
    // seam: never persisted, never logged, never sent to another client.
    this.announceLiveView(runId, session.liveViewUrl);

    const browser = await playwright.chromium.connectOverCDP(session.cdpUrl) as unknown as Browser;
    // Reuse the context the remote browser already has: providers start one,
    // and a second context would leave the live view showing the first —
    // the user would watch an idle page while the agent worked elsewhere.
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();

    const held: RunBrowser = { session, browser, page, generation: 0 };
    page.on('framenavigated', (() => { held.generation += 1; }) as never);
    this.runs.set(runId, held);
    return held;
  }

  private async perform(held: RunBrowser, action: BrowserAction, planned: number): Promise<BrowserActionOutcome> {
    const { page } = held;
    const timeout = Math.min(action.timeoutMs ?? 10_000, ACTION_TIMEOUT_MS);
    const where = async (): Promise<{ url: string; title: string }> => ({
      url: page.url(),
      title: await page.title().catch(() => ''),
    });

    // Same rule as the desktop: an action planned against one page must not run
    // against another. `navigate` names its own destination, so it is exempt.
    if (action.kind !== 'navigate' && held.generation !== planned) {
      return {
        ok: false,
        detail: 'The page changed while this action was waiting for the browser, so it was not run. Look at the page again before retrying.',
        ...(await where()),
      };
    }

    switch (action.kind) {
      case 'navigate': {
        const target = action.url ?? '';
        if (!/^https?:\/\//i.test(target)) {
          return { ok: false, detail: 'Only http and https addresses can be opened.' };
        }
        await page.goto(target, { timeout: ACTION_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
        return { ok: true, detail: `Opened ${target}`, ...(await where()) };
      }
      case 'click':
        await page.click(action.selector!, { timeout });
        return { ok: true, detail: `Clicked ${action.selector}`, ...(await where()) };
      case 'fill':
        await page.fill(action.selector!, action.value ?? '', { timeout });
        return { ok: true, detail: `Filled ${action.selector}`, ...(await where()) };
      case 'press': {
        // A selector focuses first; without one the key goes to whatever has
        // focus, which is what "press Escape" usually means.
        if (action.selector) await page.press(action.selector, action.key!, { timeout });
        else await page.keyboard.press(action.key!);
        return { ok: true, detail: `Pressed ${action.key}`, ...(await where()) };
      }
      case 'wait_for':
        await page.waitForSelector(action.selector!, { timeout });
        return { ok: true, detail: `${action.selector} appeared`, ...(await where()) };
      case 'extract_text': {
        const text = await page.innerText(action.selector ?? 'body', { timeout });
        return { ok: true, detail: text.slice(0, 200_000), ...(await where()) };
      }
      default:
        return { ok: false, detail: `Unsupported action: ${String(action.kind)}` };
    }
  }
}

function refusal(result: 'busy' | 'cancelled' | 'off'): string {
  if (result === 'off') return 'Browser control was turned off while this action waited for the browser.';
  if (result === 'cancelled') return 'The run was cancelled while waiting for the browser.';
  return 'The browser is in use by another part of this run and did not come free in time. Try again, or do something else first.';
}

/**
 * Playwright, or a message that says what to install.
 *
 * Optional dependency, the same as the headless `browser` tool — but note the
 * instruction differs: connecting to a remote browser needs the PACKAGE only,
 * not `npx playwright install chromium`, because there is no local browser to
 * launch. Telling someone to download a browser they will never run is the
 * kind of wrong advice that costs an afternoon.
 */
async function loadPlaywright(): Promise<{ chromium: { connectOverCDP(url: string): Promise<unknown> } }> {
  try {
    return await import('playwright') as unknown as { chromium: { connectOverCDP(url: string): Promise<unknown> } };
  } catch {
    throw new Error('Playwright is not installed. Run: npm install playwright (no browser download is needed — this connects to a remote browser).');
  }
}
