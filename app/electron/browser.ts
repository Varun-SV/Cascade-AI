// ─────────────────────────────────────────────
//  Cascade Desktop — Built-in browser
// ─────────────────────────────────────────────
//
// A real browser inside the app, so looking something up doesn't mean leaving
// Cascade and losing the thread of a run. It works in both directions: the
// user browses, AND the agent can read the page they are on (`read_current_page`,
// wired in main.ts) — which is why this isn't just "open the system browser".
//
// A WebContentsView, not an <iframe> or <webview>. An iframe is blocked outright
// by X-Frame-Options / frame-ancestors on most real sites — GitHub, Google,
// almost anything worth looking up — so the panel would be permanently blank
// on the pages people actually want. A WebContentsView is a genuine browser
// view with its own process, subject to none of that.
//
// It is a NATIVE overlay: it sits on top of the renderer at bounds the renderer
// dictates, rather than inside the React tree. So the renderer draws the chrome
// (address bar, buttons) and tells us where the page rectangle is; hiding the
// view is the panel's job on every view switch, or the page would float above
// whatever the user navigated to next.

import { WebContentsView, ipcMain, shell, session, type BrowserWindow } from 'electron';
import { normalizeUrl, toNavigable } from './url.js';
import { normalizeBounds, type Bounds } from './bounds.js';

// A partition dedicated to the built-in browser, so its permission policy
// (below) applies only to pages the user navigates to here — never to the
// app's own renderer, which uses the default session.
const BROWSER_PARTITION = 'persist:cascade-browser';

/**
 * Deny every web permission by default.
 *
 * `sandbox` and process isolation stop a page from reaching Node or the app's
 * IPC surface, but they do nothing about Chromium's own permission prompts —
 * camera, microphone, geolocation, notifications, HID, USB. Electron grants
 * those unless the app installs a handler; with none installed anywhere in
 * this codebase, an arbitrary or compromised site the user visits here could
 * request them with no application-level policy standing in the way. None of
 * that is needed for reading web pages, so the policy is simply: deny.
 */
function hardenBrowserSession(): void {
  const s = session.fromPartition(BROWSER_PARTITION);
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
}


const HOME_URL = 'https://duckduckgo.com/';

/** Page text handed back in one read. Beyond this the model gains nothing and
 *  the tokens cost real money; the SDK tool truncates again on its own side. */
const MAX_TEXT_CHARS = 200_000;

let view: WebContentsView | null = null;
let owner: BrowserWindow | null = null;
let visible = false;
let lastBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
/** The current main-frame navigation error, if any. See did-fail-load below
 *  for why this survives the did-stop-loading that always follows it. */
let lastError: string | undefined;

// ── Agent control ─────────────────────────────────────────────────────
//
// Three pieces of state, separate on purpose.
//
// `agentControlEnabled` is the SETTING: the user turned this capability on.
// `drivingSession` is who holds the browser right now — the panel shows it and
// the kill switch targets it.
// `revokedSessions` is who has been stopped, keyed by run.
//
// Collapsing the setting and the live state would mean the kill switch either
// does nothing lasting (the next action re-enables it) or silently rewrites a
// persisted setting the user has to go find and turn back on. Stopping a run
// and revoking the feature are different intentions and get different switches.
//
// Keying the last two by RUN rather than using process-wide booleans is what
// makes "stop this run" mean that, on a backend that starts once and then
// serves every run for the life of the app.
let agentControlEnabled = false;

/**
 * The run currently holding the browser, or null.
 *
 * Live state for the banner and the kill switch — "something is happening on
 * your page right now" — not the ownership record. Ownership is `leaseActor`
 * below, which outlives any one action; this is null in the gaps between a
 * sequence's steps while that run is very much still the owner.
 */
let drivingSession: string | null = null;

/**
 * The action holding the browser, if any.
 *
 * Still needed alongside the lease, and for a reason the lease cannot cover:
 * the lease is RE-ENTRANT for its holder — that is what makes a sequence a
 * sequence — so nothing in it stops ONE actor running two actions at once. A
 * retry racing the call it retried is exactly that shape.
 *
 * A symbol rather than an id because it identifies the individual call: the
 * finally clause releases only if it is still the one that took it. Keying that
 * on the session let a sibling sharing the run's taskId hand the browser back
 * while this action was still using it, and whichever finished first cleared
 * the shared session so a concurrent `wait_for` read it as the user having
 * pressed Stop.
 */
let activeAction: symbol | null = null;

// ── The browser lease ─────────────────────────────────────────────────
//
// Held by ONE ACTOR across a whole sequence, not one action.
//
// Serializing individual actions is not enough. Worker A does
// navigate → fill → click; if the browser is free between those steps, worker B
// takes it, navigates away, and A's fill lands on B's page. Each action was
// serialized and the sequence was still corrupted.
//
// Keyed by actor (`tierId`, unique per worker) rather than by run: every T3
// worker in a run shares the run's taskId, so a session-keyed lease would hand
// the same lease to all of them at once — exactly the state this prevents.
// Revocation stays keyed by RUN, because "stop" is something the user does to a
// run, not to a worker they have never heard of.
//
// Released when the WORKER ITSELF finishes, not on a timer. This was wrong in
// the first version and the mistake is worth recording: the lease was released
// after 15s idle, on the reasoning that a model cannot be relied on to say it
// is done. But the idle gap between two of a worker's steps is exactly where
// that worker is back at the LLM deciding its next tool call, and a normal
// generation takes longer than 15s routinely. So the timer fired mid-sequence,
// handed the browser to a queued worker, and the original worker's next
// fill/click landed on a page someone else had navigated — recreating the
// precise corruption the sequence lease exists to prevent. A timer cannot be
// what declares a live worker finished; only the worker's own lifecycle can.
// See `agentActorEnded`, called from T3Worker.execute's finally.
let leaseActor: string | null = null;
let leaseSession: string | null = null;
let leaseIdleTimer: NodeJS.Timeout | null = null;

/**
 * Defensive deadlock ceiling — NOT the sequence boundary.
 *
 * Deliberately far longer than any plausible model think-time, because its only
 * job is to recover a lease whose owner died without ever signalling: a crashed
 * worker, or a host that never wired `agentActorEnded`. Anything short enough
 * to fire during normal operation is a correctness bug, not a safety net.
 */
const LEASE_DEADLOCK_CEILING_MS = 300_000;
/**
 * How long a queued actor waits for its turn before giving up.
 *
 * Raised from 60s when the lease started being held across the holder's
 * think-time, as it must be. A whole `navigate → fill → click` sequence spans
 * several model round trips, so a minute was short enough that queued workers
 * routinely timed out on a browser that was working normally. Giving up is
 * still recoverable — the model is told to retry or do something else — but it
 * should mean the browser is genuinely monopolised, not merely busy.
 */
const QUEUE_WAIT_MS = 180_000;
/** Waiters beyond this are refused rather than queued indefinitely. */
const MAX_QUEUED = 8;
/** How long a new holder waits for the previous action to unwind. */
const ACTION_HANDOFF_MS = 2_000;
const ACTION_HANDOFF_POLL_MS = 25;

/**
 * Why an actor did not get the browser.
 *
 * A boolean was not enough: "the queue is full, try again" and "your run was
 * stopped" are different things to tell a model, and a waiter dropped because
 * the user turned the feature off is neither. Reporting all three as "busy"
 * had a model politely retrying something that would never be granted.
 */
type LeaseResult = 'granted' | 'busy' | 'cancelled' | 'off';

interface Waiter {
  actorId: string;
  sessionId: string;
  settle: (result: LeaseResult) => void;
}

const waiting: Waiter[] = [];

/**
 * Queue one actor, resolving when it gets the browser or is turned away.
 *
 * `settle` is wrapped so it runs at most once and always takes the waiter out
 * of the line: the timeout, an abort and a handoff all race, and settling a
 * promise twice would silently leave a dead entry holding a queue slot.
 */
function enqueue(
  actorId: string,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<LeaseResult> {
  return new Promise<LeaseResult>((resolve) => {
    let done = false;
    const waiter: Waiter = {
      actorId,
      sessionId,
      settle: (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', giveUp);
        const i = waiting.indexOf(waiter);
        if (i >= 0) waiting.splice(i, 1);
        resolve(result);
      },
    };
    const timer = setTimeout(() => waiter.settle('busy'), QUEUE_WAIT_MS);
    timer.unref?.();
    const giveUp = () => waiter.settle('cancelled');
    signal?.addEventListener('abort', giveUp, { once: true });
    waiting.push(waiter);
  });
}

function clearLeaseTimer(): void {
  if (leaseIdleTimer) { clearTimeout(leaseIdleTimer); leaseIdleTimer = null; }
}

/** Hand the browser to the next actor in line, if any. */
function releaseLease(): void {
  clearLeaseTimer();
  leaseActor = null;
  leaseSession = null;

  // Skip anyone whose run was stopped while they queued — handing the browser
  // to a revoked run would only have it refused a line later, and the actor
  // behind it would wait out the whole queue timeout for a turn it could have
  // had immediately.
  let next = waiting.shift();
  while (next && revokedSessions.has(next.sessionId)) {
    next.settle('cancelled');
    next = waiting.shift();
  }
  if (next) {
    leaseActor = next.actorId;
    leaseSession = next.sessionId;
    // Armed even though the winner is about to clear it: between settle() and
    // the winner resuming there is a turn of the event loop, and if that actor
    // never resumes — its run cancelled in exactly that gap — the lease would
    // be held by nobody with nothing left to release it.
    armLeaseIdle();
    next.settle('granted');
  }
  pushStateToOwner();
}

/** Arm the deadlock ceiling. Not a release schedule — see the constant. */
function armLeaseIdle(): void {
  clearLeaseTimer();
  leaseIdleTimer = setTimeout(releaseLease, LEASE_DEADLOCK_CEILING_MS);
  leaseIdleTimer.unref?.();
}

/**
 * Take the browser for this actor, waiting in line if someone else holds it.
 *
 * Re-entrant for the actor that already holds it: that is the sequence case —
 * the same worker coming back for its next step must not queue behind itself.
 */
async function acquireLease(
  actorId: string,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<LeaseResult> {
  if (leaseActor === null || leaseActor === actorId) {
    leaseActor = actorId;
    leaseSession = sessionId;
    armLeaseIdle();
    return 'granted';
  }
  // Refused rather than queued past this point. An unbounded queue turns a
  // wide worker wave into hundreds of workers each holding a turn for up to
  // LEASE_IDLE_MS, which is a stall no user would sit through.
  if (waiting.length >= MAX_QUEUED) return 'busy';
  return enqueue(actorId, sessionId, signal);
}

/**
 * One worker has finished its whole sequence, so its hold on the browser ends.
 *
 * THIS is the semantic release. It is called from the worker's own terminal
 * path, so it means "this actor will never ask again" — which a timer can
 * never mean about a worker that is merely thinking. Without it the lease can
 * only end by the deadlock ceiling, and a queued worker waits out that ceiling
 * for a browser nobody is using.
 *
 * Idempotent and safe to call for an actor that never touched the browser.
 */
export function agentActorEnded(actorId: string): void {
  if (!actorId) return;
  for (let i = waiting.length - 1; i >= 0; i--) {
    const w = waiting[i]!;
    if (w.actorId === actorId) w.settle('cancelled');
  }
  releaseIfHeldBy(actorId);
  pushStateToOwner();
}

/** Drop every queued waiter belonging to a run, and the lease if it holds it. */
function dropRunFromQueue(sessionId: string): void {
  // Backwards: settle() splices, so forward iteration would skip entries.
  for (let i = waiting.length - 1; i >= 0; i--) {
    const w = waiting[i]!;
    if (w.sessionId === sessionId) w.settle('cancelled');
  }
  // After the waiters, not before: releaseLease() hands the browser to the
  // head of the queue, and this run's own waiters must be gone by then.
  if (leaseSession === sessionId) releaseLease();
}

/** Turn everyone away — the capability itself has gone. */
function dropAllWaiters(): void {
  for (let i = waiting.length - 1; i >= 0; i--) waiting[i]!.settle('off');
}

/**
 * Aborts the action in flight for reasons that are the HOST's, not the run's.
 *
 * The run's own AbortSignal covers cancellation, but pressing Stop, turning the
 * setting off, or the browser ceasing to be watchable are none of those — and
 * without a signal of our own a slow `loadURL` kept loading through all three.
 */
let activeAbort: AbortController | null = null;

/** Milliseconds an action waits for the browser to become watchable. */
const WATCHABLE_WAIT_MS = 3_000;

/** Hard ceiling on that wait even while an approval modal holds the panel. */
const MODAL_WAIT_CEILING_MS = 120_000;

/** How often a running action re-checks that it is still being watched. */
const WATCHDOG_INTERVAL_MS = 250;

/**
 * The last run to act, whether or not one of its actions is running now.
 *
 * `drivingSession` is per-ACTION — set when one starts, cleared when it
 * finishes — so between the steps of a multi-step sequence it is null while the
 * run is very much still going. A Stop pressed in one of those gaps found
 * nothing to stop and silently did nothing, and the next action went ahead.
 * That is the failure mode a kill switch cannot have, so an argument-less Stop
 * falls back to this.
 */
let lastActiveSession: string | null = null;

/**
 * Runs the user has stopped, by session id.
 *
 * A set rather than a boolean, and this is the whole point: the desktop backend
 * starts ONCE and serves every run after it, so a process-wide flag meant a
 * Stop in one run silently carried into every later run — and, being global,
 * stopped a concurrent run as collateral while the message claimed it applied
 * only "for this run". Keyed by run, a Stop lands on the run the user was
 * actually watching and a new run is unaffected without anything having to
 * remember to reset it.
 *
 * Growth is bounded by how many times the user presses Stop, which is small and
 * user-paced; entries are deliberately not evicted, because evicting one would
 * silently un-revoke the run it belongs to.
 */
const revokedSessions = new Set<string>();

/** Reflects the persisted setting. Called by main.ts on load and on change. */
export function setAgentControlEnabled(on: boolean): void {
  agentControlEnabled = on;
  if (!on) {
    drivingSession = null;
    // Turning the feature off mid-action stops that action, rather than only
    // preventing the next one.
    activeAbort?.abort();
    // And everyone queued behind it. Without this they keep their place in a
    // line for a capability that no longer exists, and each waits out the full
    // QUEUE_WAIT_MS before being told "busy" — the wrong reason, a minute late.
    dropAllWaiters();
    // Empty queue by now, so this releases rather than hands on.
    releaseLease();
  }
  pushStateToOwner();
}

export function isAgentDriving(): boolean {
  return drivingSession !== null;
}

/**
 * The kill switch. Stops one run from touching the page any further, without
 * disturbing the setting — turning it back on is a matter of approving the next
 * run, not of hunting through Settings.
 *
 * With no argument it stops whichever run is driving right now, which is what
 * the button in the browser panel means: the user is watching something happen
 * and wants THAT stopped.
 *
 * Deliberately does NOT close the browser or navigate away: whatever the agent
 * did is left on screen for the user to see and undo.
 */
export function stopAgentControl(sessionId?: string): void {
  const target = sessionId ?? drivingSession ?? lastActiveSession;
  if (target) revokedSessions.add(target);
  if (!sessionId || sessionId === drivingSession) {
    drivingSession = null;
    // Reaches an action already under way. Clearing the lease alone left a
    // navigation loading to completion after the user had pressed Stop.
    activeAbort?.abort();
  }
  // Stop has to mean the whole run, not just the step on screen. A run's other
  // workers are queued behind the one the user is watching, so stopping only
  // the visible action handed the browser straight to the next sibling and the
  // user watched the thing they just stopped carry on under a different worker.
  // Runs first added to revokedSessions above, so the handoff inside this skips
  // them rather than dealing the browser back out to the same run.
  if (target) dropRunFromQueue(target);
  pushStateToOwner();
}

/**
 * Lets a previously-stopped run act again.
 *
 * Called with no argument only when the process is starting fresh, where there
 * are no live runs to un-stop. It is NOT a per-run reset — that is what keying
 * revocation by session id removes the need for.
 */
/**
 * A run has finished, so its Stop affordance can go away.
 *
 * Called by the host when a run ends. Without it the panel would either drop
 * the Stop button the moment an action finished — leaving the user no way to
 * revoke during the model-thinking gap between two actions, which is exactly
 * when `lastActiveSession` exists to be reachable — or keep offering to stop a
 * run that ended hours ago.
 */
export function agentRunEnded(sessionId: string): void {
  if (lastActiveSession === sessionId) lastActiveSession = null;
  if (drivingSession === sessionId) {
    drivingSession = null;
    activeAbort?.abort();
  }
  // A finished run does not get to sit on the browser for another
  // LEASE_IDLE_MS, and its queued workers are never going to run.
  dropRunFromQueue(sessionId);
  pushStateToOwner();
}

export function resumeAgentControl(sessionId?: string): void {
  if (sessionId) revokedSessions.delete(sessionId);
  else revokedSessions.clear();
  pushStateToOwner();
}

function ensureView(win: BrowserWindow): WebContentsView {
  if (view && !view.webContents.isDestroyed()) {
    // On macOS, closing the last window leaves the app running and does NOT
    // destroy a child WebContentsView. `app.on('activate')` then builds a NEW
    // BrowserWindow, and returning early with the stale `owner` left every
    // applyBounds() and state push bailing on `owner.isDestroyed()` — the
    // reopened Browser tab was invisible and inert. Re-adopt the new window.
    if (owner !== win) {
      if (owner && !owner.isDestroyed() && owner.contentView.children.includes(view)) {
        owner.contentView.removeChildView(view);
      }
      owner = win;
    }
    return view;
  }

  hardenBrowserSession();
  view = new WebContentsView({
    webPreferences: {
      // No preload, no node: this renders untrusted web content and must have
      // no path to the app's IPC surface.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: BROWSER_PARTITION,
    },
  });
  owner = win;

  const wc = view.webContents;

  // window.open / target=_blank goes to the system browser rather than
  // spawning unmanaged windows we would then have to track and clean up.
  wc.setWindowOpenHandler(({ url }) => {
    const safe = normalizeUrl(url);
    if (safe) void shell.openExternal(safe);
    return { action: 'deny' };
  });

  const pushState = () => {
    if (!owner || owner.isDestroyed()) return;
    owner.webContents.send('browser:state', getState());
  };
  // A successful or freshly-started navigation retires the old error — this
  // is the only place lastError is cleared, so did-stop-loading (below) can't
  // wipe it out from underneath a failure it didn't cause.
  wc.on('did-navigate', () => { lastError = undefined; pushState(); });
  wc.on('did-start-loading', () => { lastError = undefined; pushState(); });
  wc.on('did-navigate-in-page', pushState);
  wc.on('page-title-updated', pushState);
  // Electron always follows a failed navigation with did-stop-loading. That
  // handler calls the SAME pushState, which re-sends whatever lastError is
  // currently set to — so a DNS/TLS/connectivity failure set by did-fail-load
  // survives it instead of being overwritten by a state with no error field a
  // moment later, which is what silently blanked the failure message before.
  wc.on('did-stop-loading', pushState);
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires on every ordinary redirect and on stop.
    // A subframe (ad/tracker/embed) failing is not the page the user is on.
    if (code === -3 || !isMainFrame) return;
    if (!owner || owner.isDestroyed()) return;
    lastError = `${desc} (${url})`;
    pushState();
  });

  return view;
}

/** Push current state to the renderer from outside ensureView's closure. */
function pushStateToOwner(): void {
  if (!owner || owner.isDestroyed()) return;
  owner.webContents.send('browser:state', getState());
}

function getState() {
  if (!view || view.webContents.isDestroyed()) {
    return {
      open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
      agentControlEnabled, agentDriving: drivingSession !== null,
      agentQueueDepth: waiting.length,
    };
  }
  const wc = view.webContents;
  return {
    open: visible,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    // The single source of truth for the current failure, so every caller of
    // getState() — the event pushes below, the open/state IPC handlers — sees
    // the same thing rather than each having to remember to attach it.
    error: lastError,
    // Carried on the same channel the renderer already subscribes to, so the
    // "agent is driving" banner and the kill switch need no second stream.
    agentControlEnabled,
    agentDriving: drivingSession !== null,
    // The run holding the browser, so the panel's Stop targets the run the user
    // is watching rather than "whatever is driving by the time the click lands".
    agentDrivingSession: drivingSession ?? undefined,
    // A run that has acted and has neither been stopped nor finished. The panel
    // keeps its Stop control while this is set, because `drivingSession` clears
    // between actions and rendering Stop only while an action runs made it
    // disappear during the model-thinking gap — the one moment a user watching
    // a multi-step sequence is most likely to want it, and the moment the
    // argument-less Stop fallback was built for.
    agentArmedSession:
      drivingSession
      ?? (lastActiveSession && !revokedSessions.has(lastActiveSession) ? lastActiveSession : undefined)
      ?? undefined,
    // How many actors are in line behind the one driving. Surfaced because a
    // queue the user cannot see looks identical to a hung action: the page sits
    // there doing nothing between steps either way. It is also what makes Stop
    // legible — pressing it clears the line as well as the step on screen, and
    // a user who never knew there was a line would not expect that.
    agentQueueDepth: waiting.length,
  };
}

function applyBounds(): void {
  if (!view || !owner || owner.isDestroyed()) return;
  // Collapsed to zero rather than removed when hidden: keeping the view
  // attached preserves the page, its scroll position and any login, so
  // switching to Chat and back does not silently reload what the user was on.
  view.setBounds(visible ? lastBounds : { x: 0, y: 0, width: 0, height: 0 });
}

/**
 * Read the page currently on screen — the agent half of the feature.
 *
 * `innerText` rather than the HTML: the model wants what a person can read, and
 * the markup would be mostly script and style tags burning tokens. Returns null
 * when nothing is open, so the tool can say so instead of inventing content.
 */
export async function readCurrentPage(): Promise<{ url: string; title: string; text: string } | null> {
  if (!view || view.webContents.isDestroyed()) return null;
  const wc = view.webContents;
  const url = wc.getURL();
  if (!url || url === 'about:blank') return null;

  const text = await wc.executeJavaScript(
    `(() => {
       const el = document.body;
       if (!el) return '';
       return (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${MAX_TEXT_CHARS});
     })()`,
    true,
  ).catch(() => '');

  return { url, title: wc.getTitle(), text: typeof text === 'string' ? text : '' };
}

// ── Acting on the page ────────────────────────────────────────────────

interface AgentAction {
  kind: 'navigate' | 'click' | 'fill' | 'press' | 'wait_for' | 'extract_text';
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  timeoutMs?: number;
}

interface AgentOutcome {
  ok: boolean;
  detail: string;
  url?: string;
  title?: string;
}

/**
 * Run a snippet in the page and get its value back.
 *
 * Every caller builds the snippet with JSON.stringify around anything the model
 * supplied. That is not tidiness — a selector is model-authored text being
 * spliced into source that runs in the user's LOGGED-IN page, so a bare
 * template interpolation is script injection into their session with their
 * cookies. JSON.stringify is what makes the value a value.
 */
async function inPage<T>(script: string): Promise<T> {
  if (!view || view.webContents.isDestroyed()) throw new Error('The browser is not open.');
  return (await view.webContents.executeJavaScript(script, true)) as T;
}

function pageWhere(): { url?: string; title?: string } {
  if (!view || view.webContents.isDestroyed()) return {};
  return { url: view.webContents.getURL(), title: view.webContents.getTitle() };
}

/**
 * Perform one agent action against the visible page.
 *
 * Refuses unless the feature is on AND the user has not hit stop. Both are
 * checked HERE rather than only in the tool: the tool is one caller, and a gate
 * that lives at the edge is a gate that a second caller forgets.
 */
/**
 * Can the user see this happen, and reach the Stop control?
 *
 * `visible` alone is not that question. The panel is hidden while a modal is
 * up — including the approval modal for this very action — and a minimized or
 * destroyed window is not watchable either, while the view behind it stays
 * alive (on macOS the module deliberately preserves it across closing the last
 * window).
 */
function isWatchable(): boolean {
  if (!visible) return false;
  if (!owner || owner.isDestroyed()) return false;
  // A window hidden to the tray is not watchable, and nothing else notices:
  // the tray's Hide calls mainWindow.hide() directly, which never touches the
  // panel's `visible` flag. Minimized and hidden are separate states in
  // Electron and this gate has to fail on both.
  //
  // Each predicate is feature-detected rather than assumed: these run against
  // whatever the host passes as a window, and a missing method should not
  // decide the gate by throwing.
  if (typeof owner.isMinimized === 'function' && owner.isMinimized()) return false;
  if (typeof owner.isVisible === 'function' && !owner.isVisible()) return false;
  return true;
}

/**
 * Why the panel is hidden, when the renderer told us.
 *
 * The distinction matters for exactly one thing: a panel hidden because an
 * approval modal is up is about to come back, and the user is looking at the
 * prompt for this very action. Counting that against the wait budget made an
 * approved action fail deterministically whenever a second approval was queued
 * behind it — the modal stack keeps the panel hidden, the budget expires, and
 * the action the user said yes to is refused while they are still reading the
 * next prompt.
 */
let hiddenForModal = false;

/**
 * Wait, briefly, for the browser to become watchable.
 *
 * This exists because of an interaction that made refusing outright wrong.
 * BrowserView hides the panel whenever an approval modal is up, so that the
 * native overlay does not cover it — and the approval for a browser_control
 * action IS one of those. Approving it dequeues the modal and reopening the
 * panel is a separate React effect and IPC round-trip, so an instant check
 * refused the very action the user had just approved, nondeterministically,
 * depending on which landed first.
 *
 * Waiting absorbs that race without weakening the gate: it still refuses when
 * the browser genuinely is not watchable, and a run that is stopped or
 * cancelled while waiting stops waiting.
 */
async function awaitWatchable(
  session: string,
  signal: AbortSignal | undefined,
  hostSignal: AbortSignal,
): Promise<boolean> {
  let budget = WATCHABLE_WAIT_MS;
  const ceiling = Date.now() + MODAL_WAIT_CEILING_MS;
  for (;;) {
    if (isWatchable()) return true;
    if (signal?.aborted || hostSignal.aborted || revokedSessions.has(session)) return false;
    // A modal is holding the panel down and will release it. Waiting through
    // that is not the same as waiting on a browser the user walked away from,
    // so it does not spend the budget — but it is still bounded, so a modal
    // left open forever cannot pin a worker forever.
    if (!hiddenForModal) {
      budget -= 50;
      if (budget <= 0) return false;
    }
    if (Date.now() >= ceiling) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function actOnCurrentPage(
  action: AgentAction,
  context: { sessionId: string; actorId?: string; signal?: AbortSignal },
): Promise<AgentOutcome> {
  const session = context.sessionId || 'unknown';
  // Falls back to the run when a host supplies no actor. That degrades to one
  // lease per run — the behaviour before the lease existed — rather than
  // throwing at a caller that has not been updated. The SDK tool always sends
  // one, so the fallback is for embedders, not for the normal path.
  const actor = context.actorId || session;

  if (!agentControlEnabled) {
    return { ok: false, detail: 'Agent browser control is turned off. The user can enable it in Settings.' };
  }
  if (revokedSessions.has(session)) {
    return { ok: false, detail: 'The user stopped agent browser control for this run.' };
  }
  if (context.signal?.aborted) {
    return { ok: false, detail: 'The run was cancelled.' };
  }
  if (!view || view.webContents.isDestroyed()) {
    return { ok: false, detail: 'No page is open in the built-in browser. Ask the user to open one.' };
  }

  // Queue for the browser rather than refuse. A wave of T3 workers that each
  // need the page used to have all but one told "another action is running" —
  // a refusal the model can only answer by retrying blind. Waiting in line is
  // both what the user asked for and the only ordering that keeps a
  // navigate → fill → click sequence intact: the lease is held by the ACTOR
  // across all three, so nobody navigates away in the middle of one.
  const lease = await acquireLease(actor, session, context.signal);
  if (lease !== 'granted') {
    if (lease === 'off') {
      return { ok: false, detail: 'Agent browser control was turned off while this action waited for the browser.' };
    }
    if (lease === 'cancelled') {
      return {
        ok: false,
        detail: revokedSessions.has(session)
          ? 'The user stopped agent browser control for this run.'
          : 'The run was cancelled while waiting for the browser.',
      };
    }
    return {
      ok: false,
      detail: 'The browser is in use by another part of this run and did not come free in time. Try again, or do something else first.',
    };
  }

  // Re-checked AFTER the wait, which can be a minute long: the run may have
  // been stopped, the feature turned off, or the browser closed while this
  // actor sat in the queue. Checking only on the way in tested a world that no
  // longer exists by the time the action runs.
  const stale = staleAfterWait(session, context.signal);
  if (stale) {
    releaseIfHeldBy(actor);
    return stale;
  }

  // The outgoing action may still be unwinding: releaseLease() can hand the
  // browser on while the previous holder's abort is still propagating through
  // an awaited navigation. That is a handoff, not a conflict, so it is waited
  // out rather than refused — but it is bounded, because a wedged action must
  // not pin the queue.
  if (!(await awaitActionSlot())) {
    releaseIfHeldBy(actor);
    return { ok: false, detail: 'Another browser action is still finishing. Try again.' };
  }

  const token = Symbol('browser-action');
  const abort = new AbortController();
  activeAction = token;
  activeAbort = abort;
  drivingSession = session;
  lastActiveSession = session;
  // The idle clock is for the gap BETWEEN a sequence's steps. Left running, it
  // would fire mid-action on any navigate slower than LEASE_IDLE_MS and hand
  // the page to a queued worker while this one was still driving it.
  clearLeaseTimer();
  pushStateToOwner();

  try {
    if (!(await awaitWatchable(session, context.signal, abort.signal))) {
      if (revokedSessions.has(session)) {
        return { ok: false, detail: 'The user stopped agent browser control for this run.' };
      }
      if (context.signal?.aborted || abort.signal.aborted) {
        return { ok: false, detail: 'The run was cancelled.' };
      }
      return {
        ok: false,
        detail: 'The built-in browser is not on screen. Ask the user to open the Browser tab — actions only run where they can watch them and stop them.',
      };
    }
    // Watches for the browser ceasing to be watchable WHILE an action runs.
    // Without this, only Stop and disabling the feature aborted anything, so a
    // slow loadURL kept going after the user switched tabs, minimized, hid the
    // app to the tray, or a sibling approval covered the panel — and the
    // comment on activeAbort claimed otherwise, which made it worse than the
    // gap itself. wait_for polled watchability already; navigate did not, and
    // a per-action watchdog covers both without every action remembering to.
    const watchdog = setInterval(() => {
      if (!isWatchable()) abort.abort();
    }, WATCHDOG_INTERVAL_MS);
    try {
      return await perform(action, context.signal, abort.signal);
    } finally {
      clearInterval(watchdog);
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err), ...pageWhere() };
  } finally {
    // Only the action that took the slot releases it. Keying this on the
    // session instead let a sibling worker sharing the same taskId hand the
    // browser back while this one was still using it.
    if (activeAction === token) {
      activeAction = null;
      activeAbort = null;
      drivingSession = null;
      // The LEASE deliberately outlives the action — that is the whole point,
      // and what keeps the next step of this actor's sequence from being
      // overtaken. It goes back on the idle clock now that nothing is running.
      //
      // Except when this run is finished with the browser either way, in which
      // case holding it for another LEASE_IDLE_MS is dead time a queued worker
      // spends waiting for a run that will never come back.
      if (leaseActor === actor) {
        if (context.signal?.aborted || revokedSessions.has(session)) releaseLease();
        else armLeaseIdle();
      }
      pushStateToOwner();
    }
  }
}

/**
 * The gates that can have changed while an actor sat in the queue.
 *
 * Returns the outcome to hand back, or null when it is still fine to act.
 */
function staleAfterWait(session: string, signal: AbortSignal | undefined): AgentOutcome | null {
  if (!agentControlEnabled) {
    return { ok: false, detail: 'Agent browser control was turned off while this action waited for the browser.' };
  }
  if (revokedSessions.has(session)) {
    return { ok: false, detail: 'The user stopped agent browser control for this run.' };
  }
  if (signal?.aborted) {
    return { ok: false, detail: 'The run was cancelled.' };
  }
  if (!view || view.webContents.isDestroyed()) {
    return { ok: false, detail: 'No page is open in the built-in browser. Ask the user to open one.' };
  }
  return null;
}

/**
 * Give the browser up when we are about to return without using it.
 *
 * Two guards, both load-bearing.
 *
 * Never while an action is in flight, because the lease is RE-ENTRANT: the
 * action still running may be this same actor's previous step, and taking the
 * lease off it hands the page to a queued worker mid-sequence — precisely the
 * interleave the lease exists to prevent. That action's own finally settles
 * the lease when it unwinds, and the idle timer is already armed, so nothing
 * leaks by leaving it alone.
 *
 * And only while still the holder, because by the time a refusal path runs a
 * Stop may already have released the lease and handed it on — releasing it a
 * second time would take the browser off whoever got it.
 */
function releaseIfHeldBy(actorId: string): void {
  if (activeAction) return;
  if (leaseActor === actorId) releaseLease();
}

/** Wait, briefly, for the outgoing action to unwind. See the call site. */
async function awaitActionSlot(): Promise<boolean> {
  for (let waited = 0; waited < ACTION_HANDOFF_MS; waited += ACTION_HANDOFF_POLL_MS) {
    if (!activeAction) return true;
    await new Promise((r) => setTimeout(r, ACTION_HANDOFF_POLL_MS));
  }
  return activeAction === null;
}

async function perform(
  action: AgentAction,
  signal: AbortSignal | undefined,
  hostSignal: AbortSignal,
): Promise<AgentOutcome> {
  const wc = view!.webContents;
  /** Either reason to stop: the run was cancelled, or the host revoked. */
  const stopped = () => signal?.aborted || hostSignal.aborted;

  switch (action.kind) {
    case 'navigate': {
      // Through the same normaliser the address bar uses, so the agent cannot
      // reach file:// or a devtools: URL that the user could not type either.
      const target = toNavigable(action.url ?? '');
      if (!target) return { ok: false, detail: 'Only http and https addresses can be opened.' };
      // loadURL resolves only when the navigation settles, which is unbounded on
      // a slow or hanging page. Racing the signal lets a cancelled run stop
      // waiting; wc.stop() also stops the page still loading underneath it,
      // rather than leaving it fetching in the user's session.
      // Raced against BOTH signals. Listening only to the run's meant pressing
      // Stop, or turning the setting off, left the page loading to completion
      // in the user's session — the host had revoked but nothing told the
      // navigation.
      const abort = new Promise<'cancelled'>((resolve) => {
        if (stopped()) return resolve('cancelled');
        const fire = () => resolve('cancelled');
        signal?.addEventListener('abort', fire, { once: true });
        hostSignal.addEventListener('abort', fire, { once: true });
      });
      const raced = await Promise.race([wc.loadURL(target).then(() => 'loaded' as const), abort]);
      if (raced === 'cancelled') {
        // Stop the page too: the alternative is a navigation that completes in
        // the user's session after they stopped it.
        wc.stop();
        return {
          ok: false,
          detail: hostSignal.aborted && !signal?.aborted
            ? 'Stopped while the page was loading — the browser was closed, hidden, or the user pressed Stop.'
            : 'The run was cancelled while the page was loading.',
          ...pageWhere(),
        };
      }
      return { ok: true, detail: `Navigated to ${target}`, ...pageWhere() };
    }

    case 'click': {
      const found = await inPage<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(action.selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`);
      return found
        ? { ok: true, detail: `Clicked ${action.selector}`, ...pageWhere() }
        : { ok: false, detail: `Nothing matches ${action.selector} on this page.`, ...pageWhere() };
    }

    case 'fill': {
      // Assigning `.value` directly is not enough on any framework-driven page:
      // React tracks the previous value on the DOM node and swallows the change
      // event as a no-op, so the field looks filled and submits empty. Going
      // through the prototype's native setter is what makes the framework see it.
      const status = await inPage<string>(`(() => {
        const el = document.querySelector(${JSON.stringify(action.selector)});
        if (!el) return 'missing';
        if (!('value' in el)) return 'not-a-field';
        el.focus();
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(action.value ?? '')});
        else el.value = ${JSON.stringify(action.value ?? '')};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()`);
      if (status === 'missing') return { ok: false, detail: `Nothing matches ${action.selector} on this page.`, ...pageWhere() };
      if (status === 'not-a-field') return { ok: false, detail: `${action.selector} is not a text field.`, ...pageWhere() };
      return { ok: true, detail: `Filled ${action.selector}`, ...pageWhere() };
    }

    case 'press': {
      // A real input event rather than a synthesised KeyboardEvent: a dispatched
      // one has isTrusted false and will not submit a form or trigger the
      // browser's own handling, which is the entire point of pressing Enter.
      const key = action.key ?? '';
      wc.sendInputEvent({ type: 'keyDown', keyCode: key });
      wc.sendInputEvent({ type: 'char', keyCode: key });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key });
      return { ok: true, detail: `Pressed ${key}`, ...pageWhere() };
    }

    case 'wait_for': {
      const budget = Math.min(action.timeoutMs ?? 10_000, 30_000);
      const deadline = Date.now() + budget;
      // Polled rather than driven by a MutationObserver: an observer would have
      // to survive a navigation mid-wait, which is exactly when a wait is most
      // likely to be running.
      for (;;) {
        // The host signal covers Stop and the setting being turned off; the
        // run's covers cancellation. Watching `drivingSession` instead was
        // wrong once siblings shared a session — one finishing cleared it and
        // this read that as the user having stopped.
        if (hostSignal.aborted) {
          return { ok: false, detail: 'The user stopped agent browser control while waiting.', ...pageWhere() };
        }
        if (signal?.aborted) {
          return { ok: false, detail: 'The run was cancelled while waiting.', ...pageWhere() };
        }
        // A browser that stops being watchable mid-wait is no longer a browser
        // the user can stop, so waiting on it is exactly what must not happen.
        if (!isWatchable()) {
          return { ok: false, detail: 'The built-in browser is no longer on screen; stopped waiting.', ...pageWhere() };
        }
        const there = await inPage<boolean>(
          `!!document.querySelector(${JSON.stringify(action.selector)})`,
        ).catch(() => false);
        if (there) return { ok: true, detail: `${action.selector} appeared`, ...pageWhere() };
        if (Date.now() >= deadline) {
          return { ok: false, detail: `${action.selector} did not appear within ${budget}ms.`, ...pageWhere() };
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    case 'extract_text': {
      const text = await inPage<string>(`(() => {
        const el = ${action.selector ? `document.querySelector(${JSON.stringify(action.selector)})` : 'document.body'};
        if (!el) return null;
        return (el.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${MAX_TEXT_CHARS});
      })()`);
      if (text === null) return { ok: false, detail: `Nothing matches ${action.selector} on this page.`, ...pageWhere() };
      return { ok: true, detail: text.trim() || '[no readable text]', ...pageWhere() };
    }

    default:
      return { ok: false, detail: `Unknown action "${String(action.kind)}".` };
  }
}

export function registerBrowserHandlers(getWindow: () => BrowserWindow | null): void {
  const win = () => {
    const w = getWindow();
    return w && !w.isDestroyed() ? w : null;
  };

  ipcMain.handle('browser:open', (_e, arg: unknown) => {
    const w = win();
    if (!w) return { ok: false, error: 'No window.' };
    const a = (arg ?? {}) as { url?: string; bounds?: Bounds };
    const v = ensureView(w);
    if (!w.contentView.children.includes(v)) w.contentView.addChildView(v);
    visible = true;
    hiddenForModal = false;
    if (a.bounds) lastBounds = normalizeBounds(a.bounds);
    applyBounds();
    if (!v.webContents.getURL()) {
      void v.webContents.loadURL(toNavigable(a.url ?? '') ?? HOME_URL);
    } else if (a.url) {
      const target = toNavigable(a.url);
      if (target) void v.webContents.loadURL(target);
    }
    return { ok: true, state: getState() };
  });

  // Hide, don't destroy: the page (and any session the user signed into)
  // survives a trip to another view.
  ipcMain.handle('browser:hide', (_e, arg: unknown) => {
    visible = false;
    // The renderer says WHY. Hidden behind an approval modal is a state that
    // resolves itself and must not spend an action's wait budget; hidden
    // because the user went to another view is not.
    const reason = (arg as { reason?: string } | undefined)?.reason;
    hiddenForModal = reason === 'modal';
    applyBounds();
    // An action already running is no longer being watched.
    if (!isWatchable()) activeAbort?.abort();
    pushStateToOwner();
    return { ok: true };
  });

  ipcMain.handle('browser:close', () => {
    visible = false;
    if (view && owner && !owner.isDestroyed() && owner.contentView.children.includes(view)) {
      owner.contentView.removeChildView(view);
    }
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    view = null;
    return { ok: true };
  });

  ipcMain.handle('browser:setBounds', (_e, b: unknown) => {
    const bounds = b as Bounds;
    if (!bounds || typeof bounds.width !== 'number') return { ok: false };
    lastBounds = normalizeBounds(bounds);
    applyBounds();
    return { ok: true };
  });

  ipcMain.handle('browser:navigate', (_e, url: unknown) => {
    if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'Browser is not open.' };
    const target = toNavigable(String(url ?? ''));
    if (!target) return { ok: false, error: 'Only http and https addresses can be opened here.' };
    void view.webContents.loadURL(target);
    return { ok: true };
  });

  ipcMain.handle('browser:back', () => {
    if (view && !view.webContents.isDestroyed() && view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    }
    return { ok: true };
  });

  ipcMain.handle('browser:forward', () => {
    if (view && !view.webContents.isDestroyed() && view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    }
    return { ok: true };
  });

  ipcMain.handle('browser:reload', () => {
    if (view && !view.webContents.isDestroyed()) view.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle('browser:stop', () => {
    if (view && !view.webContents.isDestroyed()) view.webContents.stop();
    return { ok: true };
  });

  ipcMain.handle('browser:state', () => getState());

  // The kill switch. Deliberately separate from the Settings toggle: this stops
  // the run that is acting right now and leaves the setting alone, so the user
  // is not made to go re-enable a feature they still want in order to halt one
  // run that is doing the wrong thing.
  ipcMain.handle('browser:stopAgent', (_e, sessionId: unknown) => {
    // No id from the panel's button means "stop whoever is driving" — the user
    // is watching something happen and wants that stopped, and the module knows
    // which run that is better than the renderer does.
    stopAgentControl(typeof sessionId === 'string' && sessionId ? sessionId : undefined);
    return { ok: true, state: getState() };
  });

  ipcMain.handle('browser:resumeAgent', (_e, sessionId: unknown) => {
    resumeAgentControl(typeof sessionId === 'string' && sessionId ? sessionId : undefined);
    return { ok: true, state: getState() };
  });

  // The page the user is on, for the renderer (Settings/debug) — the agent
  // reaches the same function directly through the SDK tool.
  ipcMain.handle('browser:readPage', async () => (await readCurrentPage()) ?? null);

  ipcMain.handle('browser:openExternal', (_e, url: unknown) => {
    const safe = normalizeUrl(String(url ?? ''));
    if (!safe) return { ok: false };
    void shell.openExternal(safe);
    return { ok: true };
  });
}
