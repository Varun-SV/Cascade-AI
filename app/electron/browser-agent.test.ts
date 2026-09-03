// ─────────────────────────────────────────────
//  Cascade Desktop — agent control of the built-in browser
// ─────────────────────────────────────────────
//
//  These cover the gates, not the actions: whether a run is allowed to touch
//  the page at all. Each one pins a property that was wrong in review.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/** IPC handlers registered by registerBrowserHandlers, so tests can call them. */
const handlers = new Map<string, (...args: unknown[]) => unknown>();

const fakeWebContents = {
  on: vi.fn(),
  setWindowOpenHandler: vi.fn(),
  getURL: () => 'https://example.test/page',
  getTitle: () => 'Page',
  isLoading: () => false,
  isDestroyed: () => false,
  navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
  loadURL: vi.fn(async (_url: string): Promise<void> => {}),
  executeJavaScript: vi.fn(async () => true),
  sendInputEvent: vi.fn(),
  reload: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
};

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  shell: { openExternal: vi.fn() },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    }),
  },
  WebContentsView: class {
    webContents = fakeWebContents;
    setBounds = vi.fn();
  },
}));

let minimized = false;
let windowShown = true;
const win = {
  isDestroyed: () => false,
  isMinimized: () => minimized,
  isVisible: () => windowShown,
  webContents: fakeWebContents,
  contentView: { children: [] as unknown[], addChildView: vi.fn(), removeChildView: vi.fn() },
};

type Mod = typeof import('./browser.js');
let mod: Mod;

/** Fresh module state per test — everything here is module-scoped by design. */
async function load(): Promise<Mod> {
  vi.resetModules();
  handlers.clear();
  win.contentView.children = [];
  const m = await import('./browser.js');
  m.registerBrowserHandlers(() => win as never);
  return m;
}

/** Open the browser panel, which is what makes the view visible. */
async function openPanel() {
  await handlers.get('browser:open')!({}, { bounds: { x: 0, y: 0, width: 800, height: 600 } });
}

const act = (sessionId: string, signal?: AbortSignal, actorId?: string) =>
  mod.actOnCurrentPage(
    { kind: 'click', selector: '#a' },
    { sessionId, ...(actorId ? { actorId } : {}), ...(signal ? { signal } : {}) },
  );

/**
 * Fire the module's own `did-navigate` handler, as Electron would.
 *
 * Goes through the registered handler rather than poking module state, so the
 * test covers the actual wiring: if the page-generation bump is ever moved off
 * this event, this stops working — which is the point.
 */
function navigated(): void {
  for (const [event, handler] of fakeWebContents.on.mock.calls) {
    if (event === 'did-navigate' && typeof handler === 'function') (handler as () => void)();
  }
}

/** Navigate somewhere, as a named worker of a run. */
const go = (sessionId: string, actorId: string, url: string) =>
  mod.actOnCurrentPage({ kind: 'navigate', url }, { sessionId, actorId });

// A test that times out never reaches its own cleanup, so fake timers installed
// inside one leak into every test after it — where the real setTimeout they wait
// on never fires and they time out too, hiding the one real failure behind three.
afterEach(() => { vi.useRealTimers(); });

beforeEach(async () => {
  // Cleared before load(), or handlers registered by earlier module instances
  // pile up and `navigated()` fires every one of them.
  fakeWebContents.on.mockClear();
  minimized = false;
  windowShown = true;
  fakeWebContents.executeJavaScript.mockReset();
  fakeWebContents.executeJavaScript.mockResolvedValue(true);
  fakeWebContents.loadURL.mockReset();
  fakeWebContents.loadURL.mockResolvedValue(undefined);
  fakeWebContents.stop.mockReset();
  mod = await load();
  mod.setAgentControlEnabled(true);
});

describe('the setting gate', () => {
  it('refuses every action while agent control is off', async () => {
    mod.setAgentControlEnabled(false);
    await openPanel();
    const out = await act('run-1');
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/turned off/i);
  });
});

describe('the visibility gate', () => {
  it('refuses to act while the browser is hidden', async () => {
    // Hiding does NOT destroy the view — applyBounds() collapses it to zero so
    // the page and its login survive a trip to another tab. So every other
    // check passes while the user is looking at something else, and without
    // this gate the agent would click and type in an authenticated page nobody
    // can see. That is the whole argument for driving the visible browser
    // rather than a headless one.
    await openPanel();
    expect((await act('run-1')).ok, 'sanity: acting works while visible').toBe(true);

    await handlers.get('browser:hide')!();

    const out = await act('run-1');
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not on screen/i);
  });

  it('refuses before the panel has ever been opened', async () => {
    const out = await act('run-1');
    expect(out.ok).toBe(false);
  });

  it('allows acting again once the user reopens the panel', async () => {
    await openPanel();
    await handlers.get('browser:hide')!();
    expect((await act('run-1')).ok).toBe(false);

    await openPanel();
    expect((await act('run-1')).ok).toBe(true);
  });
});

describe('Stop is scoped to one run', () => {
  it('does not carry into a later run on the same backend', async () => {
    // The bug this pins: the desktop backend starts ONCE and serves every run
    // after it, while revocation was a process-wide boolean reset only at
    // backend start. A Stop in run A therefore stayed in force for run B and
    // every run after it, until the app restarted.
    await openPanel();
    expect((await act('run-A')).ok).toBe(true);

    mod.stopAgentControl();                       // the panel's Stop button
    expect((await act('run-A')).ok, 'the stopped run stays stopped').toBe(false);

    expect((await act('run-B')).ok, 'a later run must be unaffected').toBe(true);
  });

  it('does not stop a concurrent run as collateral', async () => {
    await openPanel();
    mod.stopAgentControl('run-A');

    const stopped = await act('run-A');
    expect(stopped.ok).toBe(false);
    expect(stopped.detail).toMatch(/stopped/i);

    expect((await act('run-B')).ok).toBe(true);
  });

  it('can be lifted for a specific run', async () => {
    await openPanel();
    mod.stopAgentControl('run-A');
    expect((await act('run-A')).ok).toBe(false);

    mod.resumeAgentControl('run-A');
    expect((await act('run-A')).ok).toBe(true);
  });

  it('reports whether anything is driving', async () => {
    await openPanel();
    expect(mod.isAgentDriving()).toBe(false);
    await act('run-A');
    // The lease is released when the action finishes.
    expect(mod.isAgentDriving()).toBe(false);
  });
});

describe('one browser, one run at a time', () => {
  it('makes a second run wait for the first, and never act alongside it', async () => {
    // There is one browser and any number of runs. Two acting at once would
    // interleave clicks on the same page, each reading a DOM the other changed.
    // The second one waits its turn rather than being refused — but the thing
    // that matters is that it does not touch the page until the first is done.
    await openPanel();

    let release!: () => void;
    let acted = 0;
    fakeWebContents.executeJavaScript.mockImplementation(() => {
      acted += 1;
      return acted === 1 ? new Promise((resolve) => { release = () => resolve(true); }) : Promise.resolve(true);
    });

    const first = act('run-A');
    // Waited out properly, not with a microtask hop: taking the browser goes
    // through the queue and several awaits, so `await Promise.resolve()` let
    // the second run start before the first had taken anything — and the test
    // then passed against a build with no lease in it at all.
    await new Promise((r) => setTimeout(r, 30));
    expect(acted, 'sanity: the first run is on the page').toBe(1);

    const second = act('run-B');
    await new Promise((r) => setTimeout(r, 50));
    expect(acted, 'the second run must not have touched the page').toBe(1);

    release();
    expect((await first).ok).toBe(true);

    // …and the browser is free again once the first run is finished with it.
    mod.agentRunEnded('run-A');
    expect((await second).ok).toBe(true);
  });
});

describe('cancellation', () => {
  it('refuses an action from an already-cancelled run', async () => {
    await openPanel();
    const ac = new AbortController();
    ac.abort();
    const out = await act('run-A', ac.signal);
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/cancelled/i);
  });

  it('stops waiting when the run is cancelled mid-wait', async () => {
    // wait_for polls for up to 30s. Without honouring the signal, cancelling a
    // run leaves it sitting on the user's page until the budget runs out.
    await openPanel();
    fakeWebContents.executeJavaScript.mockImplementation(async () => false); // never appears
    const ac = new AbortController();

    const pending = mod.actOnCurrentPage(
      { kind: 'wait_for', selector: '#never', timeoutMs: 30_000 },
      { sessionId: 'run-A', signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();

    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/cancelled/i);
  });

  it('stops waiting when the user hits Stop mid-wait', async () => {
    await openPanel();
    fakeWebContents.executeJavaScript.mockImplementation(async () => false);

    const pending = mod.actOnCurrentPage(
      { kind: 'wait_for', selector: '#never', timeoutMs: 30_000 },
      { sessionId: 'run-A' },
    );
    await new Promise((r) => setTimeout(r, 20));
    mod.stopAgentControl();

    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/stopped/i);
  });
});

describe('watchable, not merely visible', () => {
  it('refuses while the window is minimized', async () => {
    // `visible` stays true when the window is minimized, and on macOS the view
    // survives closing the last window entirely. Alive is not watchable.
    await openPanel();
    minimized = true;
    const out = await act('run-1');
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not on screen/i);
  });

  it('waits for the panel to come back rather than refusing the action just approved', async () => {
    // BrowserView hides the panel whenever an approval modal is up — including
    // the approval for THIS action. Approving dequeues the modal and reopening
    // is a separate effect plus an IPC round-trip, so an instant check refused
    // the very action the user had just said yes to, depending on which landed
    // first. Waiting absorbs that without weakening the gate.
    await openPanel();
    await handlers.get('browser:hide')!();

    const pending = act('run-1');
    // …the panel reopens shortly after, as it does once the modal closes.
    await new Promise((r) => setTimeout(r, 60));
    await openPanel();

    expect((await pending).ok).toBe(true);
  });

  it('still gives up if the panel never comes back', async () => {
    await openPanel();
    await handlers.get('browser:hide')!();
    const out = await act('run-1');
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not on screen/i);
  }, 10_000);

  it('stops waiting immediately when the user stops the run', async () => {
    await openPanel();
    await handlers.get('browser:hide')!();
    const pending = act('run-1');
    await new Promise((r) => setTimeout(r, 30));
    mod.stopAgentControl('run-1');
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/stopped/i);
  });
});

describe('the browser lease is held by one actor across a whole sequence', () => {
  it('does not let another worker take the page between two steps', async () => {
    // THE bug the lease exists for. Serializing individual actions is not
    // enough: worker A does navigate → think → click, and if the browser is
    // free during "think", worker B navigates away and A's click lands on B's
    // page. Every action was serialized and the sequence was still corrupted.
    await openPanel();
    const order: string[] = [];
    fakeWebContents.loadURL.mockImplementation(async (url: string) => { order.push(new URL(url).hostname); });

    await go('run-A', 'w1', 'https://first.test/');          // A's first step
    const intruder = go('run-A', 'w2', 'https://second.test/');  // B, in the gap
    await new Promise((r) => setTimeout(r, 50));
    await go('run-A', 'w1', 'https://third.test/');          // A's second step

    expect(order, 'B must not have navigated between A\'s two steps')
      .toEqual(['first.test', 'third.test']);

    mod.stopAgentControl('run-A');
    expect((await intruder).ok).toBe(false);
  });

  it('queues the second actor rather than refusing it outright', async () => {
    // Every T3 worker passes the run's taskId as sessionId and T2 runs worker
    // waves in parallel, so siblings arrive with identical run ids and
    // different actor ids. Refusing all but one told the model "another action
    // is running" — a refusal it can only answer by retrying blind.
    await openPanel();
    await act('run-A', undefined, 'w1');

    const queued = act('run-A', undefined, 'w2');
    await new Promise((r) => setTimeout(r, 30));

    const state = handlers.get('browser:state')!() as { agentQueueDepth?: number };
    expect(state.agentQueueDepth, 'the panel can say someone is waiting').toBe(1);

    mod.stopAgentControl('run-A');
    expect((await queued).ok).toBe(false);
  });

  it('hands the browser to the queued actor when the holder finishes its run', async () => {
    // A run that has ended does not get to sit on the browser for the whole
    // idle timeout while another run waits behind it.
    await openPanel();
    let release!: () => void;
    fakeWebContents.executeJavaScript.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(true); }),
    );

    const holder = act('run-A', undefined, 'w1');
    await new Promise((r) => setTimeout(r, 20));
    const queued = act('run-B', undefined, 'w2');
    await new Promise((r) => setTimeout(r, 20));

    release();
    expect((await holder).ok).toBe(true);
    mod.agentRunEnded('run-A');

    expect((await queued).ok, 'the waiter gets its turn').toBe(true);
  });

  it('does NOT hand the browser on just because the holder is thinking', async () => {
    // This test asserted the opposite and was wrong — it encoded the bug as the
    // contract. The lease used to be released after 15s idle, but that gap is
    // where the worker is back at the LLM choosing its next tool call, and a
    // normal generation exceeds 15s routinely. So the timer handed the browser
    // to a queued worker mid-sequence and the holder's next click landed on a
    // page someone else had navigated — the exact corruption the lease exists
    // to prevent. Think-time is not a release signal.
    await openPanel();
    vi.useFakeTimers();
    await act('run-A', undefined, 'w1');

    // Asserted on the OUTCOME, not on whether the promise settled: a waiter
    // that gives up settles too, and "w2 was refused" is a pass, not a failure.
    // The property is that w2 never gets to touch the page.
    let granted = false;
    const queued = act('run-A', undefined, 'w2').then((r) => { granted = r.ok; return r; });

    // Far past the old 15s release, and well into ordinary think-time territory.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(granted, 'w1 is thinking, not finished — w2 must not get the page').toBe(false);

    mod.stopAgentControl('run-A');
    await vi.advanceTimersByTimeAsync(10);
    await queued;
  });

  it('never hands the page away from a live worker, however long it takes', async () => {
    // A five-minute "deadlock ceiling" was still a normal sequence boundary.
    // A worker legitimately outlives any fixed bound: approvalTimeoutMs is
    // 600s by default (configurable to 86_400_000) and localInferenceTimeoutMs
    // is 300s (to 3_600_000) — so a worker waiting on its own human approval
    // was having its page handed to a sibling at minute five, which is the
    // corruption the lifecycle release exists to eliminate.
    await openPanel();
    mod.setLifecycleReleaseWired(true);
    vi.useFakeTimers();
    await act('run-A', undefined, 'w1');

    let granted = false;
    const queued = act('run-A', undefined, 'w2').then((r) => { granted = r.ok; return r; });

    // Twenty minutes: past the old ceiling, past the approval window, past the
    // queue timeout. None of them may decide ownership.
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(granted, 'w1 has not finished, so w1 still owns the browser').toBe(false);

    mod.agentActorEnded('w1');
    await vi.advanceTimersByTimeAsync(10);
    expect((await queued).ok, 'and only w1 finishing releases it').toBe(true);
  });

  it('hands the browser on when the holding WORKER finishes', async () => {
    // The real release: the worker's own terminal path says it will never ask
    // again, which is the one thing a timer can never mean about a worker that
    // is merely waiting on a model response.
    await openPanel();
    await act('run-A', undefined, 'w1');

    let settled = false;
    const queued = act('run-A', undefined, 'w2').then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled, 'still held while w1 is live').toBe(false);

    mod.agentActorEnded('w1');
    expect((await queued).ok, 'w2 gets its turn as soon as w1 is done').toBe(true);
  });

  it('refuses a queued action whose page changed while it waited', async () => {
    // Approval is resolved in the WORKER, before the tool runs, so w2 can be
    // approved for `click #submit` and then queue. The holder is deliberately
    // free to navigate during its own sequence — that is what the lease is for
    // — so what w2 finds when its turn comes may be a different document, on
    // which the same selector is a different button doing a different thing to
    // a signed-in account. Setting, revocation and cancellation are all still
    // valid at that point; only the page changed.
    await openPanel();
    mod.setLifecycleReleaseWired(true);
    let clicked = 0;
    fakeWebContents.executeJavaScript.mockImplementation(async () => { clicked += 1; return true; });

    await act('run-A', undefined, 'w1');                 // w1 takes the browser
    const queued = act('run-A', undefined, 'w2');        // w2 queues, page as it is now
    await new Promise((r) => setTimeout(r, 20));

    // w1 navigates during its own sequence, which is allowed.
    await go('run-A', 'w1', 'https://somewhere-else.test/');
    navigated();
    mod.agentActorEnded('w1');

    const out = await queued;
    expect(out.ok, 'w2 must not act on a page it was not prepared for').toBe(false);
    expect(out.detail).toMatch(/page changed/i);
  });

  it('ignores an actor that never touched the browser', async () => {
    await openPanel();
    await act('run-A', undefined, 'w1');
    mod.agentActorEnded('a-worker-that-never-browsed');
    mod.agentActorEnded('');
    // w1 still holds it, so a different actor still queues rather than walking in.
    let settled = false;
    const queued = act('run-A', undefined, 'w2').then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    mod.stopAgentControl('run-A');
    await queued;
  });

  it('still refuses two overlapping actions from the SAME actor', async () => {
    // The lease is re-entrant for its holder — that is what makes a sequence a
    // sequence — so the per-action mutex is what stops one worker running two
    // actions at once. Removing it would let a retry race the call it retried.
    await openPanel();
    let release!: () => void;
    fakeWebContents.executeJavaScript.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(true); }),
    );

    const first = act('run-A', undefined, 'w1');
    await new Promise((r) => setTimeout(r, 20));
    const second = await act('run-A', undefined, 'w1');

    expect(second.ok).toBe(false);
    expect(second.detail).toMatch(/still finishing/i);

    release();
    expect((await first).ok).toBe(true);

    // …and that refusal must not have given the browser away. The lease is
    // re-entrant, so the action it gave up waiting on was this actor's OWN —
    // releasing on the way out handed the page to a queued sibling in the
    // middle of the very sequence the lease is there to keep whole.
    const outsider = act('run-A', undefined, 'w2');
    await new Promise((r) => setTimeout(r, 30));
    expect(handlers.get('browser:state')!(), 'w1 must still hold it')
      .toMatchObject({ agentQueueDepth: 1 });

    mod.stopAgentControl('run-A');
    await outsider;
  }, 10_000);

  it('refuses rather than queues once the line is full', async () => {
    // An unbounded queue turns a wide worker wave into hundreds of workers each
    // holding a turn for up to the idle timeout — a stall no user sits through.
    await openPanel();
    await act('run-A', undefined, 'holder');

    const queued = Array.from({ length: 8 }, (_, i) => act('run-A', undefined, `w${i}`));
    await new Promise((r) => setTimeout(r, 30));

    const overflow = await act('run-A', undefined, 'one-too-many');
    expect(overflow.ok).toBe(false);
    expect(overflow.detail).toMatch(/did not come free/i);

    // Stop clears the whole line, not just the step on screen.
    mod.stopAgentControl('run-A');
    const outcomes = await Promise.all(queued);
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(handlers.get('browser:state')!()).toMatchObject({ agentQueueDepth: 0 });
  });

  it('tells a queued actor the feature was switched off, not that it was busy', async () => {
    // Reported as "busy" a full minute later, a model politely retries
    // something that will never be granted.
    await openPanel();
    await act('run-A', undefined, 'w1');

    const queued = act('run-A', undefined, 'w2');
    await new Promise((r) => setTimeout(r, 20));
    mod.setAgentControlEnabled(false);

    const out = await queued;
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/turned off/i);
  });

  it('re-checks the gates after the wait, not only before it', async () => {
    // A minute can pass in the queue. Checking only on the way in tested a
    // world that no longer exists by the time the action actually runs.
    await openPanel();
    await act('run-A', undefined, 'w1');

    const queued = act('run-B', undefined, 'w2');
    await new Promise((r) => setTimeout(r, 20));
    mod.stopAgentControl('run-B');    // run-B revoked while it waits
    mod.agentRunEnded('run-A');       // …and then handed the browser

    const out = await queued;
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/stopped/i);
  });

  it('a sibling waiting for the browser does not report the survivor as user-stopped', async () => {
    // The finally clause cleared the shared session, and a concurrent wait_for
    // read that as the user having pressed Stop.
    await openPanel();
    fakeWebContents.executeJavaScript.mockImplementation(async () => false);

    const waiter = mod.actOnCurrentPage(
      { kind: 'wait_for', selector: '#never', timeoutMs: 400 },
      { sessionId: 'run-A', actorId: 'w1' },
    );
    await new Promise((r) => setTimeout(r, 30));
    const sibling = act('run-A', undefined, 'w2');

    const out = await waiter;
    expect(out.ok).toBe(false);
    expect(out.detail).not.toMatch(/stopped/i);
    expect(out.detail).toMatch(/did not appear/i);

    mod.stopAgentControl('run-A');
    await sibling;
  }, 10_000);
});

describe('Stop reaches an action already under way', () => {
  it('aborts an in-flight navigation and stops the page loading', async () => {
    // browser:stopAgent cleared the lease but nothing told the navigation, so a
    // slow loadURL kept going and could complete after the user pressed Stop.
    await openPanel();
    fakeWebContents.loadURL.mockImplementation(() => new Promise(() => {}));  // never settles

    const pending = mod.actOnCurrentPage(
      { kind: 'navigate', url: 'https://slow.test/' },
      { sessionId: 'run-A' },
    );
    await new Promise((r) => setTimeout(r, 30));
    mod.stopAgentControl();

    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/cancelled|stopped/i);
    expect(fakeWebContents.stop, 'the page must be told to stop loading').toHaveBeenCalled();
  });

  it('aborts an in-flight navigation when the feature is switched off', async () => {
    await openPanel();
    fakeWebContents.loadURL.mockImplementation(() => new Promise(() => {}));

    const pending = mod.actOnCurrentPage(
      { kind: 'navigate', url: 'https://slow.test/' },
      { sessionId: 'run-A' },
    );
    await new Promise((r) => setTimeout(r, 30));
    mod.setAgentControlEnabled(false);

    expect((await pending).ok).toBe(false);
    expect(fakeWebContents.stop).toHaveBeenCalled();
  });
});

describe('hidden to the tray is not watchable', () => {
  it('refuses while the whole window is hidden', async () => {
    // The tray menu's Hide calls mainWindow.hide() directly and never touches
    // the panel's `visible` flag, so every other check passed while the entire
    // app was hidden — the exact state this gate exists to forbid.
    await openPanel();
    expect((await act('run-1')).ok, 'sanity').toBe(true);

    windowShown = false;
    const out = await act('run-1');
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not on screen/i);
  });

  it('aborts a navigation in flight when the window is hidden', async () => {
    await openPanel();
    fakeWebContents.loadURL.mockImplementation(() => new Promise(() => {}));

    const pending = mod.actOnCurrentPage(
      { kind: 'navigate', url: 'https://slow.test/' },
      { sessionId: 'run-A' },
    );
    await new Promise((r) => setTimeout(r, 30));
    windowShown = false;

    const out = await pending;
    expect(out.ok).toBe(false);
    expect(fakeWebContents.stop, 'the page must be told to stop loading').toHaveBeenCalled();
  });
});

describe('losing sight of the browser aborts the action', () => {
  it('aborts a navigation when the panel is hidden mid-load', async () => {
    // Only Stop and disabling the feature fired the host abort, so a slow
    // loadURL kept going when the user simply switched away — while the comment
    // on activeAbort claimed it covered exactly this.
    await openPanel();
    fakeWebContents.loadURL.mockImplementation(() => new Promise(() => {}));

    const pending = mod.actOnCurrentPage(
      { kind: 'navigate', url: 'https://slow.test/' },
      { sessionId: 'run-A' },
    );
    await new Promise((r) => setTimeout(r, 30));
    await handlers.get('browser:hide')!({}, undefined);

    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/stopped|hidden|closed/i);
    expect(fakeWebContents.stop).toHaveBeenCalled();
  });

  it('aborts a navigation when the window is minimized mid-load', async () => {
    await openPanel();
    fakeWebContents.loadURL.mockImplementation(() => new Promise(() => {}));

    const pending = mod.actOnCurrentPage(
      { kind: 'navigate', url: 'https://slow.test/' },
      { sessionId: 'run-A' },
    );
    await new Promise((r) => setTimeout(r, 30));
    minimized = true;

    expect((await pending).ok).toBe(false);
    expect(fakeWebContents.stop).toHaveBeenCalled();
  });
});

describe('Stop stays reachable between actions', () => {
  it('keeps a run armed after an action finishes', async () => {
    // `drivingSession` clears in every action's finally, so a UI keyed only on
    // "an action is running" loses its Stop button during the model-thinking
    // gap — the moment the argument-less Stop fallback exists to serve.
    await openPanel();
    await act('run-A');

    const state = handlers.get('browser:state')!() as { agentDriving: boolean; agentArmedSession?: string };
    expect(state.agentDriving, 'no action is running').toBe(false);
    expect(state.agentArmedSession, 'but the run is still stoppable').toBe('run-A');
  });

  it('drops the armed run once it is stopped', async () => {
    await openPanel();
    await act('run-A');
    mod.stopAgentControl();

    const state = handlers.get('browser:state')!() as { agentArmedSession?: string };
    expect(state.agentArmedSession).toBeUndefined();
  });

  it('drops the armed run once the run ends', async () => {
    await openPanel();
    await act('run-A');
    mod.agentRunEnded('run-A');

    const state = handlers.get('browser:state')!() as { agentArmedSession?: string };
    expect(state.agentArmedSession).toBeUndefined();
  });

  it('a Stop pressed between two actions still stops the second', async () => {
    await openPanel();
    expect((await act('run-A')).ok).toBe(true);
    mod.stopAgentControl();                    // pressed in the gap
    expect((await act('run-A')).ok).toBe(false);
  });
});

describe('queued approvals do not time out an approved action', () => {
  it('waits out an approval window longer than the old fixed ceiling', async () => {
    // The ceiling has to outlast the thing it is waiting ON. At a fixed 120s it
    // did not: the escalator allows 600s by default, so approving the browser
    // action and then spending three minutes reading the SECOND queued approval
    // failed the first — its approval still valid, the second not yet timed
    // out. Same multi-approval defect as the 3s budget, just moved to 120s.
    await openPanel();
    mod.setApprovalWaitCeiling(660_000);
    await handlers.get('browser:hide')!({}, { reason: 'modal' });

    vi.useFakeTimers();
    let settled = false;
    const pending = act('run-A').then((r) => { settled = true; return r; });

    // Three minutes reading the next prompt — well past the old 120s ceiling.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(settled, 'the approved action must still be waiting, not refused').toBe(false);

    // Reopened while still on fake timers. Swapping back mid-wait orphans the
    // poll loop's pending setTimeout — it was scheduled on the fake clock and
    // the real one will never fire it — so the action hangs and the test times
    // out for a reason that has nothing to do with what it is testing.
    await openPanel();
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).ok, 'and it runs once the panel comes back').toBe(true);
  });

  it('still gives up eventually, so a stuck panel cannot pin a worker forever', async () => {
    await openPanel();
    mod.setApprovalWaitCeiling(1_000);
    await handlers.get('browser:hide')!({}, { reason: 'modal' });

    const out = await act('run-A');
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not on screen/i);
  }, 10_000);

  it('waits past the normal budget while a modal holds the panel', async () => {
    // BrowserView stays hidden while ANY approval is pending. With two queued,
    // approving the first leaves the panel hidden behind the second, and a
    // budget that counted that time refused the action the user had just
    // approved — deterministically, not as a race.
    await openPanel();
    await handlers.get('browser:hide')!({}, { reason: 'modal' });

    const pending = act('run-A');
    // Longer than WATCHABLE_WAIT_MS: the user is still reading the next prompt.
    await new Promise((r) => setTimeout(r, 3_600));
    await openPanel();

    expect((await pending).ok, 'the approved action must still run').toBe(true);
  }, 15_000);

  it('still gives up on a panel the user simply navigated away from', async () => {
    // The concession is only for a modal, which resolves itself. Hiding for any
    // other reason keeps the ordinary budget.
    await openPanel();
    await handlers.get('browser:hide')!({}, undefined);
    const out = await act('run-A');
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not on screen/i);
  }, 10_000);
});
