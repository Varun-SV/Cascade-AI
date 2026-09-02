// ─────────────────────────────────────────────
//  Cascade Desktop — agent control of the built-in browser
// ─────────────────────────────────────────────
//
//  These cover the gates, not the actions: whether a run is allowed to touch
//  the page at all. Each one pins a property that was wrong in review.

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  loadURL: vi.fn(async () => undefined),
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
const win = {
  isDestroyed: () => false,
  isMinimized: () => minimized,
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

const act = (sessionId: string, signal?: AbortSignal) =>
  mod.actOnCurrentPage({ kind: 'click', selector: '#a' }, { sessionId, ...(signal ? { signal } : {}) });

beforeEach(async () => {
  minimized = false;
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
  it('refuses a second run while another holds the browser', async () => {
    // There is one browser and any number of runs. Two acting at once would
    // interleave clicks on the same page, each reading a DOM the other changed.
    await openPanel();

    let release!: () => void;
    fakeWebContents.executeJavaScript.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(true); }),
    );

    const first = act('run-A');
    await Promise.resolve();

    const second = await act('run-B');
    expect(second.ok).toBe(false);
    // Wording is about the ACTION, not the run: the lease rejects any overlap,
    // including two workers of the same run sharing one taskId.
    expect(second.detail).toMatch(/already running/i);

    release();
    expect((await first).ok).toBe(true);

    // …and the browser is free again once the first finishes.
    expect((await act('run-B')).ok).toBe(true);
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

describe('the lease rejects any overlap, not just across runs', () => {
  it('refuses a second action from the SAME run', async () => {
    // Every T3 worker passes the run's taskId as sessionId and T2 runs worker
    // waves in parallel, so siblings arrive with identical ids. A session-keyed
    // lease waved them straight through to interleave on one page.
    await openPanel();
    let release!: () => void;
    fakeWebContents.executeJavaScript.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve(true); }),
    );

    const first = act('run-A');
    await Promise.resolve();
    const second = await act('run-A');

    expect(second.ok).toBe(false);
    expect(second.detail).toMatch(/already running/i);

    release();
    expect((await first).ok).toBe(true);
  });

  it('a sibling finishing does not report the survivor as user-stopped', async () => {
    // The nastier half: the finally clause cleared the shared session, and a
    // concurrent wait_for read that as the user having pressed Stop.
    await openPanel();
    fakeWebContents.executeJavaScript.mockImplementation(async () => false);

    const waiting = mod.actOnCurrentPage(
      { kind: 'wait_for', selector: '#never', timeoutMs: 400 },
      { sessionId: 'run-A' },
    );
    await new Promise((r) => setTimeout(r, 30));
    // A sibling of the SAME run tries to act and is refused by the lease…
    await act('run-A');

    // …and the waiter must time out on its own terms, not claim it was stopped.
    const out = await waiting;
    expect(out.ok).toBe(false);
    expect(out.detail).not.toMatch(/stopped/i);
    expect(out.detail).toMatch(/did not appear/i);
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
