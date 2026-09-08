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
  /** The page's own top-level frame; sub-frames are not it. See `generation`. */
  mainFrame(): unknown;
  /** The context this page belongs to — where a CDP session is opened from. */
  context(): BrowserContext;
  isClosed(): boolean;
  close(): Promise<void>;
};
/**
 * A raw Chrome DevTools Protocol session on one page.
 *
 * Playwright's high-level API has no screencast, so watching the page means
 * talking to CDP directly. Deliberately narrow: three methods is the whole
 * surface this needs, and a wider type would invite reaching past the seam.
 */
type CDPSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (payload: never) => void): void;
  detach(): Promise<void>;
};
type BrowserContext = {
  pages(): Page[];
  newPage(): Promise<Page>;
  newCDPSession(page: Page): Promise<CDPSession>;
  close(): Promise<void>;
};
type Browser = {
  contexts(): BrowserContext[];
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
};

/** What a run's watcher is told about its browser. */
export interface BrowserViewInfo {
  /** A browser is attached to this run. Stop is meaningful while true. */
  active: boolean;
  /** Where to watch it, when the provider can stream one. */
  liveViewUrl?: string;
}

/**
 * One rendered frame of a run's browser, on its way to whoever is watching.
 *
 * A JPEG rather than a video stream, and deliberately: CDP's screencast is
 * adaptive — Chrome sends a frame when the page actually changes, not on a
 * clock — so an idle page costs nothing, and there is no media pipeline to run
 * inside the deployment. It is worse than WebRTC for video-heavy pages and
 * better than it for everything else this feature is pointed at.
 */
export interface BrowserFrame {
  /** base64 JPEG, as CDP hands it over. Never decoded on the way through. */
  data: string;
  /** The remote viewport, so a canvas can size itself without guessing. */
  width: number;
  height: number;
}

/** Who is driving a run's browser, and whether it is being pictured. */
export interface BrowserControlState {
  /** True while a person holds it and the agent is being refused. */
  human: boolean;
  /** Whether frames are being produced right now. See `setCapture`. */
  capturing: boolean;
}

/**
 * One thing a person did to the page while they held it.
 *
 * Coordinates are NORMALISED — 0..1 across the frame — rather than pixels, and
 * that is a boundary decision rather than a convenience. The picture the user
 * clicked is a JPEG scaled twice on its way to them: once by CDP into
 * `maxWidth`/`maxHeight`, once by the panel into whatever width the layout
 * gave it. Only this side knows the viewport those pixels came from, so only
 * this side can turn a click back into a page coordinate. A client sending
 * pixels would have to reconstruct both scalings and would silently miss by a
 * few pixels whenever it got one wrong — which, on a page of small controls, is
 * a click on the wrong thing.
 *
 * Typing is `text` rather than a stream of key events because `Input.insertText`
 * puts the whole string in at once: no IME to emulate, no per-character key
 * codes to get wrong for anything but a US layout, and no chance of a password
 * arriving one keystroke per socket message. `key` covers the keys that are
 * commands rather than characters, from a fixed list — see `KEYS`.
 */
export type BrowserInput =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: number }
  | { kind: 'scroll'; x: number; y: number; deltaY: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string };

/**
 * The keys a person may send, and what Chrome needs to be told about each.
 *
 * An allowlist, not a passthrough. `Input.dispatchKeyEvent` is a raw protocol
 * call: it will deliver anything, including the modifier combinations a browser
 * itself acts on, and there is no reason a takeover needs them. These are the
 * keys that move a caret or submit a form — everything a person actually types
 * goes through `insertText` instead.
 *
 * The virtual key codes are not optional decoration: Chrome dispatches on
 * `windowsVirtualKeyCode`, and a key event without one arrives as a keypress
 * that no page handler recognises.
 */
const KEYS: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: '\r' },
  Tab: { code: 9 },
  Backspace: { code: 8 },
  Delete: { code: 46 },
  Escape: { code: 27 },
  ArrowUp: { code: 38 },
  ArrowDown: { code: 40 },
  ArrowLeft: { code: 37 },
  ArrowRight: { code: 39 },
  Home: { code: 36 },
  End: { code: 35 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
};

/** Which CDP button name each pointer button maps to, and its `buttons` mask. */
const BUTTONS = { left: 1, middle: 4, right: 2 } as const;

/**
 * How the frames are asked for.
 *
 * Capped rather than native-resolution: this crosses a socket to a panel a few
 * hundred pixels wide, and a full-size frame would spend bandwidth on detail
 * the viewer cannot see. Quality 60 is where JPEG stops being obviously lossy
 * on text.
 */
const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800 } as const;

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
  /**
   * The CDP session streaming this run's page, while somebody is watching.
   *
   * Absent whenever nobody is: an unwatched run must not pay for encoding
   * frames nobody sees, and on a metered provider it must not pay for the
   * bandwidth either. Started by `startWatching`, and torn down by
   * `stopWatching` or by the run ending — whichever comes first.
   */
  screencast?: CDPSession;
  /**
   * Whether that session is currently producing frames.
   *
   * Separate from having one, because of the credential case: a person typing
   * a password wants the picture to stop WITHOUT giving up control, and giving
   * up the CDP session would give up their input channel with it. So capture
   * is suspended on a session that stays attached.
   */
  capturing?: boolean;
  /**
   * The remote viewport, as the last frame reported it.
   *
   * Where a normalised click becomes a page coordinate. Read from the frame
   * metadata rather than configured, because the page decides it: a provider
   * may hand out any window size, and `SCREENCAST`'s caps change the picture's
   * size without changing the viewport it depicts.
   */
  viewport?: { width: number; height: number };
  /**
   * A context this run created and must therefore destroy.
   *
   * Set only for a provider that does NOT isolate sessions — a shared endpoint
   * whose default context belongs to the operator and outlives every run.
   * Undefined when the provider handed us a browser of its own, because there
   * the default context IS the session and disposing it is `endSession`'s job.
   */
  ownedContext?: BrowserContext;
  /** Bumped on every main-frame navigation. See the desktop's equivalent. */
  generation: number;
  /**
   * Fires when this run's browser must stop, now.
   *
   * Playwright takes no AbortSignal, and its calls are not merely slow — they
   * are DELIBERATELY patient: `click` waits for the element to become
   * actionable, which can be seconds, and then clicks. So a Stop pressed
   * during that wait did nothing at all and the click landed afterwards, on a
   * run the user believed they had halted. Racing the signal is not enough
   * either, because the underlying operation keeps going; the page is closed,
   * which makes the pending call reject instead of complete.
   */
  abort: AbortController;
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
  private liveViewListeners = new Map<string, (info: BrowserViewInfo) => void>();
  /**
   * Told when a run's browser changes hands, or stops being pictured.
   *
   * Needed because a takeover can end without anybody asking. The hold lapses
   * on its own after `HUMAN_IDLE_MS`, and a client left believing it still has
   * control would keep sending input into a lease it no longer holds — every
   * event refused, with nothing on screen saying why.
   */
  private controlListeners = new Map<string, (state: BrowserControlState) => void>();
  /** What each run's listener was last told, so unchanged states stay quiet. */
  private controlAnnounced = new Map<string, string>();
  /** An embedder that wants every run's live view, told which run each is. */
  private onLiveViewAll: ((runId: string, liveViewUrl: string | undefined) => void) | undefined;

  private runs = new Map<string, RunBrowser>();
  /**
   * Runs that have a pool slot but no browser yet.
   *
   * Counted alongside `runs` against the cap. Without it the limit was a
   * check-then-act across four awaits, and simultaneous first uses both won.
   */
  private opening = new Set<string>();
  /**
   * A run's stop signal, created when its slot is reserved.
   *
   * Before this, Stop looked only in `runs` — so during the first `open()`,
   * while the run existed only in `opening` and four awaits were in flight, it
   * found nothing and returned. The open then completed, built a FRESH
   * unaborted controller, and the click the user had stopped went ahead. The
   * signal has to exist before the browser does.
   */
  private aborts = new Map<string, AbortController>();
  /**
   * Runs whose provider session is being released right now.
   *
   * `stopRun`, `endRun`, `releaseIfIdle`, and the stale-page branch of `open`
   * all delete a run from `runs` synchronously and only THEN await
   * `disposeRun` settling — the browser disconnect, and `provider.endSession`,
   * which for Steel is a real HTTP `/release` call. Between that delete and
   * the call actually finishing, the admission check in `open()` — which
   * counts only `runs` and `opening` — saw the slot as free, so a second run
   * could pass admission and call `createSession` before the first run's
   * session was truly released. At `maxSessions: 1` that is two live, BILLED
   * provider sessions at once, exactly what the pool exists to prevent.
   * Counting this set alongside the other two closes the window.
   *
   * Keyed by run id, not a counter: every one of those four call sites checks
   * the run is still IN `runs` before deleting it and starting teardown, and
   * that delete is synchronous, so at most one teardown can ever be in flight
   * for a given run id at a time — a second caller finds the entry already
   * gone and never starts a competing one. The entry is removed only once its
   * own teardown settles, so a later, genuine re-open of the same run id
   * never collides with one still in flight.
   */
  private closing = new Set<string>();
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
      lease = new BrowserLease({
        isRevoked: (id) => this.revoked.has(id),
        onChange: () => this.announceControl(runId),
      });
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
  onLiveViewFor(runKey: string, listener: (info: BrowserViewInfo) => void): void {
    this.liveViewListeners.set(runKey, listener);
  }

  offLiveViewFor(runKey: string): void {
    this.liveViewListeners.delete(runKey);
  }

  onControlFor(runKey: string, listener: (state: BrowserControlState) => void): void {
    this.controlListeners.set(runKey, listener);
  }

  offControlFor(runKey: string): void {
    this.controlListeners.delete(runKey);
    this.controlAnnounced.delete(runKey);
  }

  /**
   * Say who has the browser, but only when the answer has changed.
   *
   * The lease reports every ownership change, and during ordinary work that is
   * one per action as workers take it and give it back. None of those are
   * interesting to a viewer — the agent had it before and has it now — and
   * emitting them would put a socket message on every click the agent makes.
   */
  private announceControl(runId: string): void {
    const listener = this.controlListeners.get(runId);
    if (!listener) return;
    const state: BrowserControlState = {
      human: this.leases.get(runId)?.heldByHuman === true,
      capturing: this.runs.get(runId)?.capturing === true,
    };
    const key = `${state.human}:${state.capturing}`;
    if (this.controlAnnounced.get(runId) === key) return;
    this.controlAnnounced.set(runId, key);
    listener(state);
  }

  /**
   * Tell a run's listener what its browser situation is.
   *
   * `active` is separate from the URL and both are needed: a provider with no
   * live view is attached-but-unwatchable, and a finished run is not attached
   * at all. Both have no URL, so a listener given only the URL cannot tell them
   * apart — and would drop the Stop control for the first as if it were the
   * second.
   */
  private announceLiveView(runId: string, liveViewUrl: string | undefined, active: boolean): void {
    this.liveViewListeners.get(runId)?.({ active, ...(liveViewUrl ? { liveViewUrl } : {}) });
    this.onLiveViewAll?.(runId, liveViewUrl);
  }

  /**
   * Hand back a session the run turned out not to want.
   *
   * A browser opened for an action that is then refused would otherwise stay
   * allocated and billed until the whole run ended, for a run that has just
   * been stopped.
   */
  private async releaseIfIdle(runId: string): Promise<void> {
    const held = this.runs.get(runId);
    if (!held) return;
    this.runs.delete(runId);
    this.closing.add(runId);
    // Awaited, not fired and forgotten: the caller is about to report the
    // refusal, and the session should be gone by the time it does. Otherwise
    // "stopped" and "still paying for a browser" are true at the same moment.
    await this.teardown(runId, held);
  }

  /** Release every run's session. For when the deployment's config changes. */
  async dispose(): Promise<void> {
    // Runs still OPENING as well as runs already open. A run inside `open()`
    // has no RunBrowser yet, so enumerating `runs` alone walked straight past
    // it — and the caller for this is `attachRemoteBrowser` noticing the
    // operator changed the provider settings, which is usually a credential
    // rotation. Missing an in-flight open there means the session it is about
    // to allocate is allocated with the credential being retired, on a
    // controller nothing holds a reference to any more.
    const ids = new Set([...this.runs.keys(), ...this.opening]);
    await Promise.all([...ids].map((runId) => this.endRun(runId)));
  }

  /** A worker finished; it will never ask for the browser again. */
  actorEnded(actorId: string): void {
    // Every run's lease: the caller knows which worker finished, not which run
    // it belonged to, and the call is a no-op for a lease that never saw it.
    for (const lease of this.leases.values()) lease.actorEnded(actorId);
  }

  /**
   * Start streaming this run's page to whoever is watching it.
   *
   * Nothing streams until someone asks. That is the whole reason this is a
   * method rather than something `open()` does: an unwatched run would
   * otherwise pay to encode frames nobody sees, on every run, forever — and on
   * a metered provider it would pay for the bandwidth too.
   *
   * Frames are ACKED after they are handed on, never before, because the ack
   * is the flow control: Chrome sends the next frame only once the previous
   * one is acknowledged, so a slow consumer throttles the stream instead of
   * queueing memory behind it. Dropping the ack stops the stream dead, which is
   * why the ack is best-effort but unconditional.
   *
   * Returns false when there is nothing to watch — the run has no browser, or
   * it is already being watched. Callers use that to avoid promising a viewer
   * a stream that will never arrive.
   */
  async startWatching(runId: string, onFrame: (frame: BrowserFrame) => void): Promise<boolean> {
    const held = this.runs.get(runId);
    if (!held || held.screencast) return false;

    const cdp = await held.page.context().newCDPSession(held.page);
    // Recorded before the first frame can arrive, so a `stopWatching` racing
    // the very first frame still finds something to tear down.
    held.screencast = cdp;

    cdp.on('Page.screencastFrame', ((e: {
      data?: string;
      sessionId?: number;
      metadata?: { deviceWidth?: number; deviceHeight?: number };
    }) => {
      if (typeof e?.data === 'string') {
        const width = e.metadata?.deviceWidth ?? 0;
        const height = e.metadata?.deviceHeight ?? 0;
        // Kept for the takeover: this is the only place the remote viewport is
        // ever stated, and a click cannot be placed on the page without it.
        if (width > 0 && height > 0) held.viewport = { width, height };
        onFrame({ data: e.data, width, height });
      }
      // Best-effort: the session may have been detached between the frame
      // arriving and this running, and an ack into a dead session is not an
      // error worth surfacing to a user watching a browser.
      void cdp.send('Page.screencastFrameAck', { sessionId: e?.sessionId }).catch(() => {});
    }) as never);

    try {
      await cdp.send('Page.startScreencast', { ...SCREENCAST });
      held.capturing = true;
      this.announceControl(runId);
      return true;
    } catch {
      // The page went away between opening the session and starting the
      // stream. Leave nothing half-attached behind.
      held.screencast = undefined;
      await cdp.detach().catch(() => {});
      return false;
    }
  }

  /** Nobody is watching any more: stop paying to render frames. */
  async stopWatching(runId: string): Promise<void> {
    const cdp = this.runs.get(runId)?.screencast;
    if (!cdp) return;
    const held = this.runs.get(runId);
    if (held) { held.screencast = undefined; held.capturing = false; }
    this.announceControl(runId);
    // Both best-effort and in this order: stop the stream first so no further
    // frames are produced, then let the session go. A run whose page has
    // already closed throws on both, and neither failure is actionable.
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }

  /**
   * Suspend or resume the picture without giving up control.
   *
   * The credential case, and the only reason this is separate from watching. A
   * person who has taken the page over to sign in is about to type a password
   * into a field whose contents are echoed as dots — but a password manager's
   * dropdown, a "show password" toggle, a one-time code in plain text and the
   * confirmation page afterwards are not, and all of them would otherwise be
   * encoded into frames and sent across the network.
   *
   * What this does NOT do is hide anything from the agent: it stops the
   * picture, not the page. Nothing about a suspended capture would stop a
   * `extract_text` from reading the same screen — it is the lease that stops
   * that, by refusing the agent for as long as the person holds it.
   *
   * Answers whether frames are flowing afterwards, which is what a UI needs to
   * show and is not always what was asked for: a run with nobody watching has
   * no session to suspend.
   */
  async setCapture(runId: string, on: boolean): Promise<boolean> {
    const held = this.runs.get(runId);
    const cdp = held?.screencast;
    if (!held || !cdp) return false;
    if (held.capturing === on) return on;
    try {
      if (on) await cdp.send('Page.startScreencast', { ...SCREENCAST });
      else await cdp.send('Page.stopScreencast');
      held.capturing = on;
      this.announceControl(runId);
    } catch {
      // The page went away underneath. Report what is actually true rather
      // than what was requested — a UI that believes it is streaming when it
      // is not is the failure this whole panel exists to avoid.
      return held.capturing === true;
    }
    return on;
  }

  /** Whether a person is driving this run's browser right now. */
  humanHolds(runId: string): boolean {
    return this.leases.get(runId)?.heldByHuman === true;
  }

  /**
   * Hand this run's browser to the person watching it.
   *
   * The wait is the substance. An agent action already inside Playwright cannot
   * be interrupted — `click` waits for its element to become actionable and
   * then clicks, whatever anyone decided in the meantime — so a takeover that
   * returned immediately would put the person on a page an action was still
   * about to change. Bounded by the action ceiling, because that is the longest
   * an action can legitimately take; past it something is wedged, and saying so
   * is better than a spinner that never resolves.
   *
   * Idempotent for someone who already holds it: a second click of Take control
   * just says they are still there.
   */
  async takeOver(runId: string): Promise<{ ok: boolean; detail?: string }> {
    if (this.revoked.has(runId)) {
      return { ok: false, detail: 'Browser control was stopped for this run.' };
    }
    if (!this.runs.has(runId)) {
      return { ok: false, detail: 'This run has no browser open.' };
    }
    const lease = this.leaseFor(runId);
    if (lease.heldByHuman) { lease.touch(); return { ok: true }; }
    if (!(await lease.awaitActionSlot(ACTION_TIMEOUT_MS))) {
      return {
        ok: false,
        detail: 'The agent is still finishing an action on this page. Try again in a moment.',
      };
    }
    lease.takeOver(runId);
    return { ok: true };
  }

  /** The person is done. Answers whether they were holding it at all. */
  handBack(runId: string): boolean {
    return this.leases.get(runId)?.handBack() === true;
  }

  /**
   * One thing the person did to the page.
   *
   * Authorised per event, not per session. A takeover is not a channel that
   * stays open once opened: between two clicks the run can be stopped, the hold
   * can lapse, the page can close, and each of those has to stop the NEXT
   * event rather than be noticed at the end. So every event re-checks that this
   * run is live and that the lease is still the person's, and every accepted
   * event says so by extending the hold.
   */
  async input(runId: string, event: BrowserInput): Promise<{ ok: boolean; detail?: string }> {
    // No separate `revoked` check, and that is deliberate rather than an
    // omission. Stop drops the run's lease along with everything else, so a
    // stopped run has no human holder and the check below already refuses it —
    // proven by taking it out and watching the stopped-run test still fail.
    // Two answers to "may this land" is how they come to disagree.
    const held = this.runs.get(runId);
    const cdp = held?.screencast;
    if (!held || held.page.isClosed()) return { ok: false, detail: 'This run has no browser open.' };
    // No CDP session means nobody is watching, and input you cannot see the
    // result of is not a takeover — it is typing into the dark.
    if (!cdp) return { ok: false, detail: 'Nothing is streaming this browser, so it cannot be driven.' };
    const lease = this.leaseFor(runId);
    if (!lease.heldByHuman) {
      return { ok: false, detail: 'You do not have control of this browser. Take control first.' };
    }

    try {
      await this.dispatch(cdp, held, event);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    lease.touch();
    return { ok: true };
  }

  /** Turn one authorised event into CDP calls. Coordinates arrive normalised. */
  private async dispatch(cdp: CDPSession, held: RunBrowser, event: BrowserInput): Promise<void> {
    if (event.kind === 'text') {
      // Bounded because it crosses a socket and lands in a page: a paste is a
      // reasonable thing to do during a takeover, a novel is not.
      const text = String(event.text ?? '').slice(0, 4_000);
      if (!text) return;
      await cdp.send('Input.insertText', { text });
      return;
    }
    if (event.kind === 'key') {
      const spec = KEYS[event.key];
      if (!spec) throw new Error(`That key cannot be sent to the page: ${event.key}`);
      const base = {
        key: event.key,
        code: event.key,
        windowsVirtualKeyCode: spec.code,
        nativeVirtualKeyCode: spec.code,
        ...(spec.text ? { text: spec.text } : {}),
      };
      await cdp.send('Input.dispatchKeyEvent', { ...base, type: spec.text ? 'keyDown' : 'rawKeyDown' });
      await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      return;
    }

    // The viewport comes from a frame, so an event arriving before the first
    // one has nowhere to land. Refused rather than guessed at a default size:
    // a click placed by guesswork lands on whatever happens to be there.
    const view = held.viewport;
    if (!view) throw new Error('The page has not been seen yet, so a click cannot be placed on it.');
    const x = clamp01(event.x) * view.width;
    const y = clamp01(event.y) * view.height;

    if (event.kind === 'move') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      return;
    }
    if (event.kind === 'scroll') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, button: 'none', buttons: 0,
        deltaX: 0, deltaY: clampScroll(event.deltaY),
      });
      return;
    }

    const button = event.button && event.button in BUTTONS ? event.button : 'left';
    const buttons = BUTTONS[button];
    // Double-click is two events with clickCount 2, which pages read to mean
    // word-selection. Capped because a click count is a number from a client.
    const clickCount = Math.min(Math.max(Math.trunc(event.clicks ?? 1), 1), 3);
    // Moved first: hover states, menus and anything listening for mouseover
    // otherwise never see the pointer arrive, and a press on an element that
    // was never hovered is not what a real click looks like to the page.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount });
  }

  /** The user stopped this run. Refuses further actions and clears its queue. */
  stopRun(runId: string): void {
    this.revoked.add(runId);
    this.leases.get(runId)?.dropRun(runId);
    // Aborted whether or not a browser exists yet: a run whose session is still
    // opening has a signal but no RunBrowser, and looking only in `runs` let
    // the first action of a stopped run go ahead once the open finished.
    this.aborts.get(runId)?.abort();
    const held = this.runs.get(runId);
    if (!held) return;
    // Released NOW, not when the Cascade run eventually ends. Browser Stop
    // deliberately lets the rest of the run continue, so the session would
    // otherwise stay allocated and billed for all of it — while the user has
    // just been told the browser is no longer in use. `revoked` keeps refusing
    // further actions, so giving the session back costs nothing.
    this.runs.delete(runId);
    // Added to `closing` synchronously, in this same synchronous stretch of
    // `stopRun`, so the pool counts this slot as still-in-use for the entire
    // window between here and the fire-and-forget teardown settling — not
    // just for the part of it this function happens to await. `stopRun` must
    // stay synchronous (callers do not await it), so the teardown itself is
    // still fire-and-forget; only the bookkeeping around it changed.
    this.closing.add(runId);
    void this.teardown(runId, held);
  }

  /** A run ended: release its browser rather than pay for an idle session. */
  async endRun(runId: string): Promise<void> {
    this.leases.get(runId)?.dropRun(runId);
    // Aborted whether or not a browser exists yet — the same reason `stopRun`
    // does it, and the same bug if it does not. A run still inside `open()`
    // has a signal and no RunBrowser, so the `!held` branch below used to
    // forget it and return while the open ran on to completion, unstoppable.
    // It has to happen BEFORE `forgetRun`, which deletes the signal.
    this.aborts.get(runId)?.abort();
    const held = this.runs.get(runId);
    if (!held) { this.forgetRun(runId); return; }
    this.runs.delete(runId);
    this.closing.add(runId);
    await this.teardown(runId, held);
    this.forgetRun(runId);
  }

  /** Forget a finished run entirely, so nothing accumulates per run. */
  private forgetRun(runId: string): void {
    // The controller now outlives every run on the deployment, so a set that
    // only ever grew would collect one UUID per stopped run for the life of the
    // process. The run is over; there is nothing left to refuse.
    this.revoked.delete(runId);
    this.leases.delete(runId);
    this.aborts.delete(runId);
    // The live-view listener is per-run state of exactly the same kind, and it
    // closes over the embedder's socket. The one caller today does call
    // `offLiveViewFor` right after `endRun`, so nothing leaks — but the run is
    // over here, the controller owns every other scrap of its state, and an
    // embedder that forgot the second call (or threw between the two) would
    // hold a socket closure per run for the life of the process. The final
    // "browser gone" announcement has already gone out by now: `disposeRun`
    // makes it, and teardown completes before this runs.
    this.liveViewListeners.delete(runId);
    this.offControlFor(runId);
  }

  /**
   * Let go of one run's browser.
   *
   * Best-effort throughout: a run is already over by the time this runs, and a
   * provider that is briefly unreachable must not turn that into a failure the
   * user sees. The provider's own idle timeout collects anything left.
   */
  private async disposeRun(runId: string, held: RunBrowser): Promise<void> {
    held.abort.abort();
    this.announceLiveView(runId, undefined, false);
    // Before the page and the connection it rides on. A screencast left
    // attached would keep Chrome encoding frames for a run that is over, into
    // a session about to be detached underneath it.
    const watching = held.screencast;
    held.screencast = undefined;
    if (watching) {
      await watching.send('Page.stopScreencast').catch(() => {});
      await watching.detach().catch(() => {});
    }
    // Before the connection goes, because it is reached THROUGH the connection.
    // This is the run's own context on a shared endpoint: closing it takes its
    // pages, cookies and storage with it, which is what stops the next tenant
    // inheriting them. Absent for a provider-owned browser, where endSession
    // below disposes the whole thing.
    await held.ownedContext?.close().catch(() => {});
    // Disconnects this Playwright client. Checked against Playwright 1.62.1
    // rather than assumed: after `connectOverCDP`, `Browser.close()` resolves
    // to closing the websocket transport, not to a `Browser.close` command — a
    // real `chromium --remote-debugging-port` stayed up and kept serving
    // /json/version across two full connect/close cycles, with the operator's
    // own page intact. If that ever changes, this is the line that would start
    // terminating somebody else's browser.
    await held.browser.close().catch(() => {});
    await this.provider.endSession(held.session.id).catch(() => {});
  }

  /**
   * Run `disposeRun`, with the run id counted in `closing` until it settles.
   *
   * The caller adds the id to `closing` itself, synchronously, in the same
   * breath as deleting the run from `runs` — see the field comment. This just
   * guarantees the removal happens, success or failure, so a disposal that
   * throws cannot leave the slot counted against the pool forever.
   */
  private async teardown(runId: string, held: RunBrowser): Promise<void> {
    try {
      await this.disposeRun(runId, held);
    } finally {
      this.closing.delete(runId);
    }
  }

  private async act(action: BrowserAction, context: BrowserActionContext): Promise<BrowserActionOutcome> {
    // Refused rather than defaulted. `sessionId` is a required string on the
    // tool contract, so this should be unreachable — but the old `|| 'unknown'`
    // chose the worst possible failure if it ever were reached: on a
    // deployment-wide controller serving many tenants, every identity-less call
    // would land in ONE bucket, sharing a lease, a RunBrowser and — on a
    // non-isolating CDP endpoint — a single page, across users. Failing closed
    // costs an action; failing open costs a tenant boundary.
    const runId = context.sessionId;
    if (!runId) {
      return { ok: false, detail: 'This browser action arrived without a run identity, so it was not run.' };
    }
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

      // Re-checked AFTER the open, which can take seconds: createSession and
      // connectOverCDP are not interruptible, so a Stop or cancellation during
      // them resolves into a perfectly good browser and the action would go
      // straight ahead. Aborting the signal is not enough on its own — nothing
      // is awaiting it at that moment.
      if (this.revoked.has(runId)) {
        await this.releaseIfIdle(runId);
        return { ok: false, detail: 'The user stopped browser control for this run.' };
      }
      if (context.signal?.aborted || held.abort.signal.aborted) {
        await this.releaseIfIdle(runId);
        return { ok: false, detail: 'The run was cancelled.' };
      }

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
    if (existing) {
      // Its page is gone, so it is unusable — but the provider session behind
      // it is still allocated and still billed. Overwriting the map entry
      // dropped the only reference to it.
      this.runs.delete(runId);
      // Same delete-before-await shape as `stopRun`/`endRun`/`releaseIfIdle`,
      // and the same fix: without counting this run in `closing` while its old
      // session is disposed of, a DIFFERENT run's admission check below could
      // see this slot as free and get admitted before the old session was
      // actually released.
      this.closing.add(runId);
      await this.teardown(runId, existing);
    }

    // Counted WITH the open runs, and taken before the first await.
    //
    // The check used to sit above a run of awaits — loadPlaywright,
    // createSession, connectOverCDP, page creation — with the run only entering
    // `runs` at the very end. Two first-use calls starting together therefore
    // both saw an empty map, both passed a limit of one, and both allocated. On
    // Steel that is two billed sessions against maxSessions: 1; on a bare CDP
    // endpoint it defeats the non-isolating cap and puts two runs back on one
    // page. A reservation closes the window because it is taken synchronously.
    //
    // `closing` joins the other two for the same reason: a run mid-teardown
    // has left `runs` and `opening` already but has not yet actually given the
    // provider session back, so leaving it out of this sum would reopen the
    // exact race this comment describes, just via release instead of open.
    if (this.runs.size + this.opening.size + this.closing.size >= this.maxSessions) {
      throw new Error(
        `All ${this.maxSessions} browser session${this.maxSessions === 1 ? '' : 's'} are in use by other runs. ` +
        'Try again when one finishes, or raise the session limit in settings.',
      );
    }
    this.opening.add(runId);
    // Created here, not after the browser exists, so a Stop arriving mid-open
    // has something to abort — and so the RunBrowser adopts the same signal
    // rather than a new one that has forgotten it.
    if (!this.aborts.has(runId)) this.aborts.set(runId, new AbortController());

    try {
      return await this.openReserved(runId, signal);
    } finally {
      // Released on every path. A reservation that leaked would count against
      // the cap forever and wedge the deployment.
      this.opening.delete(runId);
    }
  }

  /** The part that may fail, with the pool slot already reserved. */
  private async openReserved(runId: string, signal?: AbortSignal): Promise<RunBrowser> {
    const playwright = await loadPlaywright();
    // `signal` alone is the CASCADE RUN's cancellation, passed down from
    // `act()` — NOT the per-run browser abort `stopRun` fires, which lives in
    // `this.aborts` and is created back in `open()` before this is ever
    // called. SteelProvider's `createSession` genuinely honours whatever
    // signal it is given (it is threaded straight into the underlying fetch),
    // so a browser-only Stop pressed while that POST is in flight left it
    // unheard: the request ran to completion, Steel allocated and started
    // billing a real session, and only the post-open revocation re-check
    // below noticed afterwards and released it. Composing both signals here
    // means Stop cancels the request that creates the paid resource, not just
    // the use of it once it exists. `AbortSignal.any` needs no listener
    // cleanup of our own — it is the platform's own primitive for exactly
    // this, unlike `stoppable()` above, which reaches for Playwright directly
    // because Playwright has no signal to hand it in the first place.
    const abort = this.aborts.get(runId)?.signal;
    const creationSignal = signal && abort ? AbortSignal.any([signal, abort]) : (signal ?? abort);
    const session = await this.provider.createSession(creationSignal);
    // Handed to the owner as soon as it exists, so the user can watch from the
    // first action rather than after it. A CAPABILITY URL — see the provider
    // seam: never persisted, never logged, never sent to another client.
    this.announceLiveView(runId, session.liveViewUrl, true);

    // Everything past createSession is rolled back on failure. Without this a
    // CDP connection that dies leaves an allocated, billed session with nothing
    // holding a reference to release it — and the client still showing a live
    // view for a browser that will never be driven.
    // Declared OUTSIDE the try so the rollback can reach them. They were
    // `const`s inside it, which meant a throw after the connection was made —
    // or after the run's own context was created — left both attached to a
    // browser that outlives the run, with `endSession` (a deliberate no-op for
    // a shared endpoint) the only cleanup the catch could perform. Repeated
    // transient failures accumulated incognito contexts and CDP connections on
    // the operator's browser for runs that never even reached `this.runs`.
    let browser: Browser | undefined;
    let owned: BrowserContext | undefined;
    try {
      browser = await playwright.chromium.connectOverCDP(session.cdpUrl) as unknown as Browser;
      // Whose context this is decides everything about how the run may use it.
      //
      // A provider that ISOLATES sessions just made this browser for this run,
      // and its default context is the session — the one the live-view URL
      // points at. Opening a second context there would leave the user watching
      // an idle page while the agent worked somewhere they could not see, which
      // defeats the only supervision this surface has.
      //
      // A provider that does NOT isolate is a shared endpoint. Its default
      // context is the operator's and outlives every run, so reusing it made
      // one tenant's run inherit the previous tenant's page: same URL, same
      // cookies, same localStorage. `maxSessions = 1` prevents two runs
      // OVERLAPPING there; it does nothing about the run that comes after.
      // Verified against a real `chromium --remote-debugging-port`: a second
      // connection landed on the first's page and read back its localStorage
      // and its session cookie. So this run gets a context of its own, and
      // destroys it on the way out.
      owned = this.provider.isolatesSessions ? undefined : await browser.newContext();
      const context = owned ?? browser.contexts()[0] ?? await browser.newContext();
      const page = owned ? await owned.newPage() : (context.pages()[0] ?? await context.newPage());

      // The controller `open()` registered for this run. If it is GONE, the
      // run was ended or disposed while these awaits were running: `forgetRun`
      // deletes it. Registering a RunBrowser now would attach a browser to a
      // run nothing is tracking any more — no `endRun` will come for it, and
      // the `?? new AbortController()` this used to fall back to made it
      // unstoppable too, since a later `stopRun` looks the signal up in
      // `aborts` and would find nothing. Roll back instead.
      const abort = this.aborts.get(runId);
      if (!abort) throw new Error('The run ended while its browser was still opening.');
      const held: RunBrowser = { session, browser, page, generation: 0, abort, ...(owned ? { ownedContext: owned } : {}) };
      // MAIN frame only. Playwright emits `framenavigated` for every frame,
      // sub-frames included, and this handler used to discard the frame it was
      // given and count them all — while the field it bumps is documented, and
      // used, as "the page the model is looking at has changed".
      //
      // The consequence was a refusal, not a wrong action, but a common one:
      // an ad slot or an embedded chat widget re-navigating on its own timer is
      // ordinary on exactly the sites this feature gets pointed at. Any action
      // that waited — for the lease, or for a session Steel can take up to a
      // minute to create — could come back to a bumped generation and be told
      // "the page changed while this action was waiting", about a page that had
      // not changed at all.
      page.on('framenavigated', ((frame: unknown) => {
        if (frame !== page.mainFrame()) return;
        held.generation += 1;
      }) as never);
      this.runs.set(runId, held);
      return held;
    } catch (err) {
      this.announceLiveView(runId, undefined, false);
      // Innermost first, and before endSession: the context is reached through
      // the connection, and for a shared endpoint endSession is a no-op that
      // would leave both behind.
      await owned?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await this.provider.endSession(session.id).catch(() => {});
      throw err;
    }
  }

  private async perform(held: RunBrowser, action: BrowserAction, planned: number): Promise<BrowserActionOutcome> {
    const { page } = held;
    /**
     * Race one Playwright call against this run's Stop.
     *
     * The rejection is not the mechanism — closing the page is. Playwright's
     * calls are deliberately patient (`click` waits for actionability), and
     * abandoning the promise would leave the underlying operation running to
     * completion, so the click would still land after Stop. Closing makes it
     * fail instead.
     */
    const stoppable = async <T>(work: Promise<T>): Promise<T> => {
      if (held.abort.signal.aborted) throw new Error('The user stopped browser control for this run.');
      // Named and removed when the work wins, because `{ once: true }` only
      // fires once — it does not detach on the OTHER outcome. Every successful
      // action left one behind, so ordinary run cleanup (which aborts) fired
      // all of them and called page.close() with nothing in flight. That page
      // used to be the operator's own on a persistent CDP endpoint — a normal
      // completion reached out and closed somebody else's tab. The run-owned
      // context above means it is now always ours, but the listener still has
      // to be removed: closing the page mid-sequence would break the run's own
      // next action.
      let onAbort!: () => void;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            onAbort = () => {
              void page.close().catch(() => {});
              reject(new Error('The user stopped browser control for this run.'));
            };
            held.abort.signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } finally {
        held.abort.signal.removeEventListener('abort', onAbort);
      }
    };
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
        await stoppable(page.goto(target, { timeout: ACTION_TIMEOUT_MS, waitUntil: 'domcontentloaded' }));
        return { ok: true, detail: `Opened ${target}`, ...(await where()) };
      }
      case 'click':
        await stoppable(page.click(action.selector!, { timeout }));
        return { ok: true, detail: `Clicked ${action.selector}`, ...(await where()) };
      case 'fill':
        await stoppable(page.fill(action.selector!, action.value ?? '', { timeout }));
        return { ok: true, detail: `Filled ${action.selector}`, ...(await where()) };
      case 'press': {
        // A selector focuses first; without one the key goes to whatever has
        // focus, which is what "press Escape" usually means.
        if (action.selector) await stoppable(page.press(action.selector, action.key!, { timeout }));
        else await stoppable(page.keyboard.press(action.key!));
        return { ok: true, detail: `Pressed ${action.key}`, ...(await where()) };
      }
      case 'wait_for':
        await stoppable(page.waitForSelector(action.selector!, { timeout }));
        return { ok: true, detail: `${action.selector} appeared`, ...(await where()) };
      case 'extract_text': {
        const text = await stoppable(page.innerText(action.selector ?? 'body', { timeout }));
        return { ok: true, detail: text.slice(0, 200_000), ...(await where()) };
      }
      default:
        return { ok: false, detail: `Unsupported action: ${String(action.kind)}` };
    }
  }
}

function refusal(result: 'busy' | 'cancelled' | 'off' | 'human'): string {
  // Said plainly, and as a finished outcome rather than a delay: a model told
  // "busy" retries, and retrying a person is exactly the behaviour a takeover
  // exists to prevent.
  if (result === 'human') {
    return 'The user has taken control of this browser. Stop using it and tell them what you were about to do.';
  }
  if (result === 'off') return 'Browser control was turned off while this action waited for the browser.';
  if (result === 'cancelled') return 'The run was cancelled while waiting for the browser.';
  return 'The browser is in use by another part of this run and did not come free in time. Try again, or do something else first.';
}

/** A client's coordinate, kept inside the picture it claims to be from. */
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
}

/** A scroll, bounded so one wheel event cannot ask for an absurd jump. */
function clampScroll(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(n, -2_000), 2_000) : 0;
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
