// ─────────────────────────────────────────────
//  Cascade AI — driving a remote browser
// ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RemoteBrowserProvider } from './provider.js';

/**
 * A CDP session, modelled well enough to test flow control.
 *
 * `sent` is the record of protocol calls; `pushFrame` is Chrome delivering a
 * screencast frame. The ack matters as much as the frame does — Chrome sends
 * the next one only once the last is acknowledged — so the fake records both
 * in one ordered list and a test can prove the ack came AFTER delivery.
 */
function fakeCdp() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const session = {
    sent: [] as string[],
    /** The same calls with their arguments, for the ones whose arguments are the point. */
    calls: [] as Array<{ method: string; params?: Record<string, unknown> }>,
    detached: false,
    /** Everything that happened, in order: deliveries and acks interleaved. */
    order: [] as string[],
    /**
     * What `Page.getLayoutMetrics` answers — the page's CSS-pixel viewport.
     *
     * Defaults to the same numbers the screencast metadata reports, because
     * that IS the ordinary desktop case and every existing assertion depends
     * on it. A test that wants the two spaces to differ says so.
     */
    layout: { clientWidth: 1280, clientHeight: 800 },
    /** Answer with the deprecated device-pixel field only. See below. */
    legacyOnly: false,
    async send(method: string, params?: Record<string, unknown>) {
      session.sent.push(method);
      session.calls.push({ method, ...(params ? { params } : {}) });
      if (method === 'Page.getLayoutMetrics') {
        // `legacyOnly` models an older Chrome: the deprecated `visualViewport`
        // is present and `cssVisualViewport` is not. Its numbers are DEVICE
        // pixels, which is the whole point — they must not be read as CSS ones.
        return session.legacyOnly
          ? { visualViewport: { ...session.layout } }
          : { cssVisualViewport: { ...session.layout } };
      }
      if (method === 'Page.screencastFrameAck') session.order.push(`ack:${params?.['sessionId']}`);
      return {};
    },
    on(event: string, handler: (payload: never) => void) {
      handlers.set(event, handler as (p: unknown) => void);
    },
    async detach() { session.detached = true; },
    /**
     * Chrome producing a frame.
     *
     * `metadata` is overridable because the picture's geometry and the page's
     * coordinate space are DIFFERENT things — `deviceWidth`/`deviceHeight` are
     * the device screen in DIP, and `offsetTop` is the browser chrome above the
     * page. A fake that only ever reports the identity case cannot tell a
     * correct mapping from one that multiplies by the wrong numbers.
     */
    pushFrame(sessionId: number, data = 'BASE64JPEG', metadata: Record<string, number> = {}) {
      handlers.get('Page.screencastFrame')?.({
        data, sessionId, metadata: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, ...metadata },
      });
    },
  };
  return session;
}
/** The CDP session the current test's context will hand out. */
let cdp = fakeCdp();
/** How many times anything asked the page for a CDP session. */
let cdpCreated = 0;
/**
 * When set, `newCDPSession` waits on this before resolving.
 *
 * The whole point: the attach race lives between asking for a session and
 * recording it, and a fake that resolves immediately never opens that window.
 */
let cdpGate: Promise<void> | null = null;

/** A promise a test can settle by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Frame identities the fake reports, so main and sub can be told apart. */
const MAIN_FRAME = { id: 'main' };
const SUB_FRAME = { id: 'iframe-ad-slot' };

/** The fake page every test drives, and the record of what it was asked. */
const page = {
  closed: false,
  currentUrl: 'https://start.test/',
  navHandlers: [] as Array<(frame: unknown) => void>,
  calls: [] as string[],
  url() { return this.currentUrl; },
  async title() { return 'Title'; },
  async goto(u: string) {
    this.calls.push(`goto:${u}`); this.currentUrl = u;
    // Playwright reports the frame that moved. A real top-level navigation
    // reports the main frame; see `navigateSubframe` for the other kind.
    this.navHandlers.forEach((h) => h(MAIN_FRAME));
  },
  /** An ad slot or embedded widget re-navigating itself. Not the page. */
  navigateSubframe() { this.navHandlers.forEach((h) => h(SUB_FRAME)); },
  mainFrame() { return MAIN_FRAME; },
  async click(s: string) { this.calls.push(`click:${s}`); },
  async fill(s: string, v: string) { this.calls.push(`fill:${s}=${v}`); },
  async press(s: string, k: string) { this.calls.push(`press:${s}:${k}`); },
  keyboard: { press: async (k: string) => { page.calls.push(`key:${k}`); } },
  async waitForSelector(s: string) { this.calls.push(`wait:${s}`); },
  async innerText(s: string) { this.calls.push(`text:${s}`); return 'page text'; },
  on(event: string, handler: (frame: unknown) => void) { if (event === 'framenavigated') this.navHandlers.push(handler); },
  async close() { this.closed = true; this.closeCount += 1; },
  isClosed() { return this.closed; },
  context() { return pageContext; },
  /** How many times anything asked to close this page. See the leak test. */
  closeCount: 0,
};

/**
 * A context, modelled properly rather than as an object literal.
 *
 * `close()` is what stops one run's cookies and storage reaching the next on a
 * shared endpoint, so the fake has to be able to say whether it was called.
 */
function fakeContext(pageForThisContext: typeof page) {
  const c = {
    closed: false,
    pages: () => [pageForThisContext],
    newPage: async () => pageForThisContext,
    newCDPSession: async () => { cdpCreated += 1; if (cdpGate) await cdpGate; return cdp; },
    close: async () => { c.closed = true; },
  };
  return c;
}

/** The context a shared endpoint already had. Belongs to the operator. */
const defaultContext = fakeContext(page);
/** What `page.context()` answers — the run's own context once it has one. */
let pageContext = defaultContext;
/** Every context a run asked the browser to make for itself. */
const createdContexts: Array<ReturnType<typeof fakeContext>> = [];

const browser = {
  closed: false,
  contexts: () => [defaultContext],
  newContext: async () => { const c = fakeContext(page); createdContexts.push(c); return c; },
  close: async () => { browser.closed = true; },
};

vi.mock('playwright', () => ({ chromium: { connectOverCDP: async () => browser } }));

const { RemoteBrowserController } = await import('./controller.js');

/** A provider that records its lifecycle calls. */
function fakeProvider(liveViewUrl?: string) {
  const created: string[] = [];
  const ended: string[] = [];
  let n = 0;
  const provider: RemoteBrowserProvider = {
    name: 'fake',
    async createSession() {
      const id = `sess-${++n}`;
      created.push(id);
      return { id, cdpUrl: 'ws://fake/cdp', ...(liveViewUrl ? { liveViewUrl } : {}) };
    },
    async endSession(id: string) { ended.push(id); },
  };
  return { provider, created, ended };
}

const ctx = (runId: string, actorId: string, signal?: AbortSignal) =>
  ({ sessionId: runId, actorId, ...(signal ? { signal } : {}) });

/** Restored per test: several tests swap a method, and `page` is shared. */
const pristineClick = page.click;

beforeEach(() => {
  page.click = pristineClick;
  page.closed = false;
  page.closeCount = 0;
  page.currentUrl = 'https://start.test/';
  page.calls = [];
  page.navHandlers = [];
  browser.closed = false;
  browser.contexts = () => [defaultContext];
  defaultContext.closed = false;
  createdContexts.length = 0;
  cdp = fakeCdp();
  cdpCreated = 0;
  cdpGate = null;
  pageContext = defaultContext;
});

describe('the six actions reach the page', () => {
  it('maps each one onto Playwright', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });

    await c.controller({ kind: 'navigate', url: 'https://a.test/' }, ctx('run', 'w1'));
    await c.controller({ kind: 'click', selector: '#go' }, ctx('run', 'w1'));
    await c.controller({ kind: 'fill', selector: '#q', value: 'hello' }, ctx('run', 'w1'));
    await c.controller({ kind: 'press', selector: '#q', key: 'Enter' }, ctx('run', 'w1'));
    await c.controller({ kind: 'wait_for', selector: '#done' }, ctx('run', 'w1'));
    await c.controller({ kind: 'extract_text' }, ctx('run', 'w1'));

    expect(page.calls).toEqual([
      'goto:https://a.test/', 'click:#go', 'fill:#q=hello', 'press:#q:Enter', 'wait:#done', 'text:body',
    ]);
  });

  it('presses to the focused element when no selector is given', async () => {
    // "Press Escape" usually means the page, not a particular field.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'press', key: 'Escape' }, ctx('run', 'w1'));
    expect(page.calls).toEqual(['key:Escape']);
  });

  it('clears a field rather than rejecting an empty value', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'fill', selector: '#q', value: '' }, ctx('run', 'w1'));
    expect(page.calls).toEqual(['fill:#q=']);
  });

  it('opens only http and https', async () => {
    // Same rule as the desktop: the agent must not reach a scheme the user
    // could not type into the address bar either.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    const out = await c.controller({ kind: 'navigate', url: 'file:///etc/passwd' }, ctx('run', 'w1'));
    expect(out.ok).toBe(false);
    expect(page.calls).toEqual([]);
  });
});

describe('one browser, many workers', () => {
  it('makes a second worker wait rather than interleave', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1'));

    let granted = false;
    const queued = c.controller({ kind: 'click', selector: '#b' }, ctx('run', 'w2'))
      .then((r) => { granted = r.ok; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(granted, 'w1 holds it across its whole sequence').toBe(false);
    expect(page.calls).toEqual(['click:#a']);

    c.actorEnded('w1');
    expect((await queued).ok).toBe(true);
    expect(page.calls).toEqual(['click:#a', 'click:#b']);
  });

  it('refuses a queued action whose page changed while it waited', async () => {
    // The holder is deliberately free to navigate during its own sequence, so
    // what a queued worker finds may be a different document — on which its
    // selector is a different element entirely.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1'));

    const queued = c.controller({ kind: 'click', selector: '#b' }, ctx('run', 'w2'));
    await new Promise((r) => setTimeout(r, 20));
    await c.controller({ kind: 'navigate', url: 'https://elsewhere.test/' }, ctx('run', 'w1'));
    c.actorEnded('w1');

    const out = await queued;
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/page changed/i);
    expect(page.calls, 'and it never touched the new page').not.toContain('click:#b');
  });
});

describe('stopping and ending a run', () => {
  it('refuses every further action once the user stops the run', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1'));
    c.stopRun('run');

    const out = await c.controller({ kind: 'click', selector: '#b' }, ctx('run', 'w1'));
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/stopped/i);
    expect(page.calls).toEqual(['click:#a']);
  });

  it('refuses an already-cancelled run before touching the page', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    const ac = new AbortController();
    ac.abort();
    const out = await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1', ac.signal));
    expect(out.ok).toBe(false);
    expect(page.calls).toEqual([]);
  });

  it('gives the session back when the run ends', async () => {
    // A session nobody is using is a session somebody is paying for.
    const { provider, created, ended } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1'));
    await c.endRun('run');

    expect(created).toEqual(['sess-1']);
    expect(ended).toEqual(['sess-1']);
    expect(browser.closed).toBe(true);
  });

  it('does not fail a finished run because the provider is unreachable', async () => {
    const { provider } = fakeProvider();
    provider.endSession = async () => { throw new Error('provider down'); };
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1'));
    await expect(c.endRun('run')).resolves.toBeUndefined();
  });
});

describe('Stop reaches an action already under way', () => {
  it('does not let a pending click land after Stop', async () => {
    // The dangerous case, and the reason racing alone is not enough:
    // Playwright's click is deliberately patient — it waits for the element to
    // become actionable and THEN clicks. Abandoning the promise would leave
    // that running, so the click would still happen on a run the user believed
    // they had halted. The page is closed instead, which makes it fail.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#warmup' }, ctx('run-A', 'w1'));

    let landed = false;
    // Restored by beforeEach. Leaving it in place made every later test wait
    // five seconds on a click and time out — the fake page is module-level.
    page.click = async () => { await new Promise((r) => setTimeout(r, 5_000)); landed = true; };

    const pending = c.controller({ kind: 'click', selector: '#submit' }, ctx('run-A', 'w1'));
    await new Promise((r) => setTimeout(r, 20));
    c.stopRun('run-A');

    const out = await pending;
    expect(out.ok).toBe(false);
    expect(landed, 'the click must not complete after Stop').toBe(false);
    expect(page.closed, 'the page is closed so the pending call cannot finish').toBe(true);
  }, 10_000);
});

describe('Stop during the very first open', () => {
  it('does not let the first action land once the browser arrives', async () => {
    // The existing Stop test warms a session up first, so it only ever covered
    // the already-held branch. On FIRST use the run lives only in `opening`
    // while createSession and connectOverCDP await — Stop found no RunBrowser,
    // returned, and the click went ahead the moment the open finished.
    let landed = false;
    page.click = async () => { landed = true; };

    let releaseCreate!: () => void;
    const slowCreate = new Promise<void>((r) => { releaseCreate = r; });
    const ended: string[] = [];
    const provider = {
      name: 'slow',
      isolatesSessions: true,
      async createSession() {
        await slowCreate;
        return { id: 'sess-1', cdpUrl: 'ws://fake/cdp' };
      },
      async endSession(id: string) { ended.push(id); },
    };

    const c = new RemoteBrowserController({ provider });
    const pending = c.controller({ kind: 'click', selector: '#submit' }, ctx('run-A', 'w1'));

    // Stop while the session is still being created — no RunBrowser exists yet.
    await new Promise((r) => setTimeout(r, 20));
    c.stopRun('run-A');
    releaseCreate();

    const out = await pending;
    expect(out.ok).toBe(false);
    expect(landed, 'the action must not run after Stop').toBe(false);
    expect(ended, 'and the session it allocated is handed back').toEqual(['sess-1']);
  }, 10_000);

  it('keeps refusing after the interrupted open', async () => {
    let releaseCreate!: () => void;
    const slowCreate = new Promise<void>((r) => { releaseCreate = r; });
    const provider = {
      name: 'slow',
      isolatesSessions: true,
      async createSession() { await slowCreate; return { id: 'sess-1', cdpUrl: 'ws://fake/cdp' }; },
      async endSession() {},
    };

    const c = new RemoteBrowserController({ provider });
    const pending = c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await new Promise((r) => setTimeout(r, 20));
    c.stopRun('run-A');
    releaseCreate();
    await pending;

    const next = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-A', 'w1'));
    expect(next.ok, 'a stopped run stays stopped').toBe(false);
  }, 10_000);
});

describe('a normal completion does not close somebody else\'s page', () => {
  it('leaves no abort listener behind after a successful action', async () => {
    // stoppable() added a { once: true } abort listener per action and never
    // removed it when the work won. disposeRun aborts on ordinary completion,
    // so every listener a successful run accumulated fired then and called
    // page.close() — and on a persistent CDP endpoint that page belongs to the
    // operator, which is exactly why GenericCdpProvider.endSession does nothing.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.controller({ kind: 'click', selector: '#b' }, ctx('run-A', 'w1'));
    await c.controller({ kind: 'click', selector: '#c' }, ctx('run-A', 'w1'));
    expect(page.closeCount, 'no action closed the page while it was winning').toBe(0);

    // The abort has to actually FIRE, or this proves nothing: the leaked
    // listeners are armed on `held.abort.signal` and do nothing until something
    // aborts it. Asserting `page.closed` after three quiet successes was
    // vacuous — it was false whether or not a single listener was ever
    // removed. `stopRun` is the production path that aborts.
    c.stopRun('run-A');
    await new Promise((r) => setTimeout(r, 10));

    // Counted, not booleaned. Three leaked listeners would each call
    // `page.close()` here, and on a persistent CDP endpoint that page is the
    // operator's — which is why GenericCdpProvider.endSession deliberately does
    // nothing. Nothing was in flight when Stop landed, so nothing should have
    // been closed at all.
    expect(page.closeCount, 'a completed action must leave no listener to fire on abort').toBe(0);
  });
});

describe('a session that half-opened', () => {
  it('is released rather than left running and billed', async () => {
    // createSession succeeded, so the provider allocated a browser. If the CDP
    // connection then fails, nothing holds a reference to release it.
    const { provider, created, ended } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    const { chromium } = await import('playwright') as unknown as { chromium: { connectOverCDP: unknown } };
    const original = chromium.connectOverCDP;
    (chromium as { connectOverCDP: unknown }).connectOverCDP = async () => { throw new Error('cdp refused'); };

    try {
      const out = await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
      expect(out.ok).toBe(false);
      expect(created).toEqual(['sess-1']);
      expect(ended, 'the allocated session is handed back').toEqual(['sess-1']);
    } finally {
      (chromium as { connectOverCDP: unknown }).connectOverCDP = original;
    }
  });

  it('withdraws the live view it already announced', async () => {
    // The URL was emitted the moment the session existed. Leaving it showing
    // points the user at a browser that will never be driven.
    const { provider } = fakeProvider('https://provider.test/live/abc');
    const seen: Array<string | undefined> = [];
    const c = new RemoteBrowserController({ provider });
    c.onLiveViewFor('run-A', (info) => seen.push(info.liveViewUrl));
    const { chromium } = await import('playwright') as unknown as { chromium: { connectOverCDP: unknown } };
    const original = chromium.connectOverCDP;
    (chromium as { connectOverCDP: unknown }).connectOverCDP = async () => { throw new Error('cdp refused'); };

    try {
      await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
      expect(seen).toEqual(['https://provider.test/live/abc', undefined]);
    } finally {
      (chromium as { connectOverCDP: unknown }).connectOverCDP = original;
    }
  });
});

describe('the session pool', () => {
  it('refuses a second run when only one session is allowed', async () => {
    // Every session is billed, so the default is one and raising it is a
    // decision. The refusal has to say which, or it reads as a bug.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider, maxSessions: 1 });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const out = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2'));
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/session.*in use|raise the session limit/i);
  });

  it('frees a slot when the run that held it ends', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider, maxSessions: 1 });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.endRun('run-A');

    const out = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2'));
    expect(out.ok).toBe(true);
  });
});

describe('a provider that cannot isolate sessions', () => {
  it('is held to one run however high the limit is set', async () => {
    // A bare CDP endpoint IS one browser: two "sessions" against it are the
    // same browser and the same page. Honouring maxSessions: 4 there would not
    // buy concurrency, it would let two runs — two users on a shared
    // deployment — type into each other's forms.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider, maxSessions: 4 });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const out = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2'));
    expect(out.ok, 'the limit cannot exceed what the provider can deliver').toBe(false);
  });

  it('lets an isolating provider honour the configured limit', async () => {
    const { provider } = fakeProvider();
    (provider as { isolatesSessions: boolean }).isolatesSessions = true;
    const c = new RemoteBrowserController({ provider, maxSessions: 2 });

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    const out = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2'));
    expect(out.ok).toBe(true);
  });
});

describe('one controller, several runs', () => {
  it('sends each run its own live view and no one else\'s', async () => {
    // The controller is shared across a deployment now, so a single callback
    // would send run A's URL to whichever run registered last — and that URL is
    // a bearer capability for a browser someone else is driving.
    const { provider } = fakeProvider('https://provider.test/live/abc');
    (provider as { isolatesSessions: boolean }).isolatesSessions = true;
    const c = new RemoteBrowserController({ provider, maxSessions: 2 });

    const seenA: Array<string | undefined> = [];
    const seenB: Array<string | undefined> = [];
    c.onLiveViewFor('run-A', (info) => seenA.push(info.liveViewUrl));
    c.onLiveViewFor('run-B', (info) => seenB.push(info.liveViewUrl));

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    expect(seenA).toEqual(['https://provider.test/live/abc']);
    expect(seenB, 'run B is not driving anything yet').toEqual([]);
  });

  it('stops telling a run about a browser once it has detached', async () => {
    const { provider } = fakeProvider('https://provider.test/live/abc');
    const c = new RemoteBrowserController({ provider });
    const seen: Array<string | undefined> = [];
    c.onLiveViewFor('run-A', (info) => seen.push(info.liveViewUrl));
    c.offLiveViewFor('run-A');

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    expect(seen).toEqual([]);
  });
});

describe('attached is not the same as watchable', () => {
  it('reports a browser as active even when it cannot be streamed', async () => {
    // A bare CDP endpoint offers no view. The listener has to learn that a
    // browser EXISTS anyway, or the UI drops the Stop control along with the
    // picture — leaving the agent driving something the user can neither see
    // nor halt.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    const seen: Array<{ active: boolean; liveViewUrl?: string }> = [];
    c.onLiveViewFor('run-A', (info) => seen.push(info));

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    expect(seen[0]).toEqual({ active: true });
  });

  it('reports it inactive once the run is finished with it', async () => {
    // Same absent URL, opposite meaning. Only `active` tells them apart.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    const seen: Array<{ active: boolean; liveViewUrl?: string }> = [];
    c.onLiveViewFor('run-A', (info) => seen.push(info));

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.endRun('run-A');

    expect(seen.at(-1)).toEqual({ active: false });
  });
});

describe('two runs starting at the same moment', () => {
  it('cannot both allocate at a limit of one', async () => {
    // The sequential pool tests could never catch this: the cap was checked,
    // then four awaits ran (loadPlaywright, createSession, connectOverCDP, page
    // creation), and only then did the run enter the map. Two first-use calls
    // starting together both saw an empty map and both allocated — two billed
    // Steel sessions at maxSessions: 1, or two runs on one CDP page.
    //
    // The barrier is the point: createSession blocks until BOTH calls have
    // reached it, which is exactly the interleaving a sequential test cannot
    // produce.
    // Time-limited on purpose. A barrier that WAITS for two arrivals
    // deadlocks once the fix works, because the second call is now refused
    // before it ever reaches the provider — the first version of this test hung
    // for exactly that reason. Racing a short delay keeps it a barrier when
    // both arrive (the buggy shape) without requiring that they do.
    let reached = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((r) => { release = r; });
    const barrier = () => Promise.race([bothArrived, new Promise((r) => setTimeout(r, 50))]);

    const created: string[] = [];
    const provider = {
      name: 'barrier',
      isolatesSessions: true,
      async createSession() {
        created.push(`sess-${created.length + 1}`);
        if (++reached === 2) release();
        await barrier();
        return { id: `sess-${created.length}`, cdpUrl: 'ws://fake/cdp' };
      },
      async endSession() {},
    };

    const c = new RemoteBrowserController({ provider, maxSessions: 1 });
    const [a, b] = await Promise.all([
      c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1')),
      c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2')),
    ]);

    // One succeeds, one is refused — and crucially only ONE session was ever
    // allocated, so the refusal happened before the provider was called.
    expect([a.ok, b.ok].filter(Boolean), 'exactly one run gets the browser').toHaveLength(1);
    expect(created, 'the loser must not have allocated a session').toHaveLength(1);
  }, 10_000);

  it('frees the reservation when opening fails', async () => {
    // A reservation that leaked would count against the cap forever and wedge
    // the deployment after a single transient provider error.
    let attempt = 0;
    const provider = {
      name: 'flaky',
      isolatesSessions: true,
      async createSession() {
        if (++attempt === 1) throw new Error('provider hiccup');
        return { id: 'sess-2', cdpUrl: 'ws://fake/cdp' };
      },
      async endSession() {},
    };

    const c = new RemoteBrowserController({ provider, maxSessions: 1 });
    const first = await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    expect(first.ok).toBe(false);

    const second = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2'));
    expect(second.ok, 'the slot was given back').toBe(true);
  });
});

describe('a session mid-release still counts against the pool', () => {
  it('keeps a stopped run\'s slot reserved until the provider actually releases it', async () => {
    // `stopRun` deletes the run from `runs` and hands its session's release to
    // a fire-and-forget teardown. If the pool's admission check does not also
    // count that in-flight release, a second run can pass admission and call
    // `createSession` before the first run's session is actually given back —
    // at `maxSessions: 1` that is two live, billed sessions at once, which is
    // exactly what the cap exists to prevent.
    let releaseEnd!: () => void;
    const blockedEnd = new Promise<void>((r) => { releaseEnd = r; });
    // Resolved from inside `endSession`, so the test proceeds when the release
    // has actually started rather than when a sleep guesses it has.
    let releasing!: () => void;
    const releaseStarted = new Promise<void>((r) => { releasing = r; });
    const created: string[] = [];
    const ended: string[] = [];
    let n = 0;
    const provider = {
      name: 'slow-release',
      isolatesSessions: true,
      async createSession() {
        const id = `sess-${++n}`;
        created.push(id);
        return { id, cdpUrl: 'ws://fake/cdp' };
      },
      async endSession(id: string) {
        ended.push(id);
        releasing();
        await blockedEnd;
      },
    };

    const c = new RemoteBrowserController({ provider, maxSessions: 1 });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    c.stopRun('run-A');

    // A's fire-and-forget teardown has reached `endSession` and is blocked
    // there — well past the point where it deleted A from `runs`.
    await releaseStarted;
    expect(ended, 'A\'s release has started but not finished').toEqual(['sess-1']);

    const refused = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2'));
    expect(refused.ok, 'B must not be admitted while A\'s release is still in flight').toBe(false);
    expect(created, 'and must never have reached the provider to prove it').toEqual(['sess-1']);

    releaseEnd();
    await new Promise((r) => setTimeout(r, 20));

    const out = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2'));
    expect(out.ok, 'B proceeds once the slot is truly free').toBe(true);
    expect(created).toEqual(['sess-1', 'sess-2']);
  });
});

describe('Stop cancels the browser it is still waiting on', () => {
  it('aborts an in-flight session request rather than paying for it before giving it back', async () => {
    // `openReserved` used to hand the provider only the CASCADE run's
    // cancellation signal, never the per-run browser abort `stopRun` fires —
    // so a browser-only Stop pressed while `createSession` was in flight (a
    // real HTTP POST for Steel) went unheard: the request ran to completion
    // and allocated a session that was only released afterwards, by the
    // post-open revocation re-check. This provider blocks until ITS OWN
    // signal fires and never resolves otherwise, so the test only passes if
    // Stop actually reaches that signal — releasing the provider by hand
    // instead would prove nothing.
    let sawAbort = false;
    let entered!: () => void;
    // See `stalling()` below: waited on rather than slept past, because getting
    // here crosses loadPlaywright()'s dynamic import and a fixed sleep flakes.
    const reached = new Promise<void>((r) => { entered = r; });
    const cascadeSignal = new AbortController(); // present, but never fires
    const provider = {
      name: 'abortable',
      isolatesSessions: true,
      createSession(signal?: AbortSignal) {
        return new Promise<{ id: string; cdpUrl: string }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('creation aborted'));
          });
          entered();
        });
      },
      async endSession() {},
    };

    const c = new RemoteBrowserController({ provider });
    const pending = c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1', cascadeSignal.signal));
    // Nothing else will ever settle it, so keep an unhandled rejection from
    // escaping if the assertions below fail.
    pending.catch(() => {});

    await reached;
    c.stopRun('run-A');

    // Raced rather than plainly awaited: without the fix this request is
    // uncancellable and `pending` never settles at all, and a suite timeout
    // five seconds later says only "timed out" — it does not say that Stop
    // failed to reach the signal, which is the actual property.
    const settled = await Promise.race([
      pending.then((r) => r, () => undefined),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 250)),
    ]);

    expect(sawAbort, 'the signal handed to createSession must abort on Stop').toBe(true);
    expect(settled, 'Stop must end the wait, not leave the run hanging on a request it cannot cancel')
      .not.toBe('hung');
    expect((settled as { ok?: boolean } | undefined)?.ok ?? false).toBe(false);
  });
});

describe('the live view', () => {
  it('is handed to the owner as soon as the session exists', async () => {
    // Before the first action rather than after, or the user watches the
    // agent's opening move having missed it.
    const { provider } = fakeProvider('https://provider.test/live/abc');
    const seen: Array<[string, string | undefined]> = [];
    const c = new RemoteBrowserController({ provider, onLiveView: (r, u) => seen.push([r, u]) });

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1'));
    expect(seen[0]).toEqual(['run', 'https://provider.test/live/abc']);
  });

  it('is withdrawn when the run ends', async () => {
    const { provider } = fakeProvider('https://provider.test/live/abc');
    const seen: Array<[string, string | undefined]> = [];
    const c = new RemoteBrowserController({ provider, onLiveView: (r, u) => seen.push([r, u]) });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1'));
    await c.endRun('run');
    expect(seen.at(-1)).toEqual(['run', undefined]);
  });

  it('reports its absence rather than inventing one', async () => {
    // The generic CDP endpoint has no live view. The caller has to know, so it
    // can tell the user this configuration cannot be watched.
    const { provider } = fakeProvider();
    const seen: Array<[string, string | undefined]> = [];
    const c = new RemoteBrowserController({ provider, onLiveView: (r, u) => seen.push([r, u]) });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1'));
    expect(seen[0]).toEqual(['run', undefined]);
  });
});

// `maxSessions = 1` stops two runs sharing a page AT THE SAME TIME. It says
// nothing about the run that comes next, and on a shared endpoint the next run
// is usually a different person.
//
// Verified against a real `chromium --remote-debugging-port` before writing
// this: a second connection taking `contexts()[0].pages()[0]` landed on the
// first connection's page — same URL — and read back its localStorage value
// and its session cookie. The fake below models the mechanism that prevents
// that; the browser confirmed the mechanism is needed.
describe('a shared endpoint between two tenants', () => {
  it('drives a context of its own, not the one the endpoint already had', async () => {
    const { provider } = fakeProvider();          // isolatesSessions is falsy
    const c = new RemoteBrowserController({ provider });

    // A page nobody in this run should ever touch — the operator's own tab.
    const operatorPage = { ...page, calls: [] as string[], closed: false };
    const operatorContext = fakeContext(operatorPage as unknown as typeof page);
    browser.contexts = () => [operatorContext];

    const out = await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    expect(out.ok).toBe(true);
    expect(page.calls, 'the run drove its own page').toContain('click:#a');
    expect(operatorPage.calls, 'and never the endpoint\'s existing one').toEqual([]);
    expect(operatorContext.closed, 'the operator\'s context is not ours to close').toBe(false);
  });

  it('destroys that context when the run ends, taking its cookies with it', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    expect(createdContexts, 'the run made itself a context').toHaveLength(1);
    expect(createdContexts[0]!.closed).toBe(false);

    await c.endRun('run-A');

    // Leaving it open is the leak: the endpoint keeps it, and it keeps the
    // storage and cookies this run wrote.
    expect(createdContexts[0]!.closed, 'closed on the way out').toBe(true);
    expect(defaultContext.closed, 'without touching the operator\'s').toBe(false);
  });

  it('gives the next tenant a different context from the last one', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.endRun('run-A');
    // The slot is free now — this is the sequential case the cap never covered.
    await c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2'));

    expect(createdContexts).toHaveLength(2);
    expect(createdContexts[1], 'B is not handed A\'s context').not.toBe(createdContexts[0]);
    expect(createdContexts[0]!.closed, 'and A\'s is gone before B starts writing').toBe(true);
    expect(createdContexts[1]!.closed).toBe(false);
  });

  it('leaves a provider-owned session on the context its live view points at', async () => {
    // The opposite case, and it is not symmetry for its own sake: a provider
    // that isolates just made this browser for this run, and the live-view URL
    // shows its default context. A second context there would leave the user
    // watching an idle page while the agent worked out of sight.
    const { provider } = fakeProvider();
    (provider as { isolatesSessions: boolean }).isolatesSessions = true;
    const c = new RemoteBrowserController({ provider });

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    expect(createdContexts, 'nothing to create — the session IS the context').toHaveLength(0);
    expect(page.calls).toContain('click:#a');

    await c.endRun('run-A');
    // endSession disposes the whole browser; closing its context by hand would
    // be reaching into something the provider owns.
    expect(defaultContext.closed).toBe(false);
  });
});

// The existing half-open tests fail `connectOverCDP()` itself, so they stop
// before any of this run's own state exists. The window that matters now is
// AFTER the connection: on a shared endpoint the browser outlives the run, so
// anything created and not cleaned up stays there.
describe('an open that fails after the run already owns something', () => {
  it('closes the context and the connection it had already made', async () => {
    const { provider, ended } = fakeProvider();          // non-isolating
    const c = new RemoteBrowserController({ provider });

    // newContext() succeeds; the page after it does not. `endSession` is a
    // no-op for this provider, so without an explicit teardown the context and
    // the CDP connection are simply abandoned on the operator's browser.
    const good = browser.newContext;
    browser.newContext = async () => {
      const ctxt = await good();
      ctxt.newPage = async () => { throw new Error('target closed'); };
      return ctxt;
    };

    try {
      const out = await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
      expect(out.ok).toBe(false);
    } finally {
      browser.newContext = good;
    }

    expect(createdContexts, 'the context was created').toHaveLength(1);
    expect(createdContexts[0]!.closed, 'and not left on the endpoint').toBe(true);
    expect(browser.closed, 'the connection is dropped too').toBe(true);
    expect(ended, 'and the provider is still told, in case it owns anything').toEqual(['sess-1']);
  });

  it('does not wedge the pool after the failure', async () => {
    // A leaked reservation would cost the deployment its only session.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });

    const good = browser.newContext;
    browser.newContext = async () => {
      const ctxt = await good();
      ctxt.newPage = async () => { throw new Error('target closed'); };
      return ctxt;
    };
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    browser.newContext = good;

    const next = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-B', 'w2'));
    expect(next.ok, 'the slot came back').toBe(true);
  });
});

// "The page changed while this action was waiting" has to mean the page, not
// something inside it. Playwright emits `framenavigated` for EVERY frame, and
// the handler that decides this used to count them all.
describe('an iframe navigating is not the page changing', () => {
  it('runs a queued action that only an ad slot moved under', async () => {
    // Deliberately the same shape as "refuses a queued action whose page
    // changed while it waited" above, because the generation is captured at
    // ENTRY: a frame navigating before the action starts is counted into the
    // plan and cannot disagree with it. The bug only shows while an action
    // WAITS — and waiting is ordinary here, for the lease or for a session
    // Steel can take a minute to create. An ad or chat widget re-navigating on
    // its own timer during that window is ordinary too, on exactly the sites
    // this feature gets pointed at.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run', 'w1'));

    const queued = c.controller({ kind: 'click', selector: '#buy' }, ctx('run', 'w2'));
    await new Promise((r) => setTimeout(r, 20));
    page.navigateSubframe();
    page.navigateSubframe();
    c.actorEnded('w1');

    const out = await queued;
    expect(out.ok, 'a sub-frame moving must not invalidate the plan').toBe(true);
    expect(page.calls).toContain('click:#buy');
  });
});

// A run that is still OPENING has a signal but no browser yet, and the paths
// that end a run looked only at the browsers. `stopRun` was fixed for this in
// an earlier round; `endRun` and `dispose` had the same hole.
describe('ending a run whose browser has not arrived yet', () => {
  /** A provider whose createSession only settles when its signal fires. */
  function stalling() {
    const created: string[] = [];
    let sawAbort = false;
    let entered!: () => void;
    /**
     * Resolves once the open has genuinely reached the provider AND registered
     * its abort listener.
     *
     * A fixed `setTimeout` used to stand in for this, and it flaked: getting
     * here goes through `loadPlaywright()`'s dynamic import, which on a loaded
     * machine takes longer than any sleep short enough to be worth writing. The
     * test then ended a run that had not started opening yet and saw no abort —
     * a red suite reporting a bug that was not there. Waiting for the condition
     * itself cannot guess wrong.
     */
    const reached = new Promise<void>((r) => { entered = r; });
    const provider = {
      name: 'stalling',
      isolatesSessions: true,
      createSession(signal?: AbortSignal) {
        created.push(`sess-${created.length + 1}`);
        return new Promise<{ id: string; cdpUrl: string }>((_res, rej) => {
          signal?.addEventListener('abort', () => { sawAbort = true; rej(new Error('aborted')); });
          // After the listener, never before: the test proceeds to fire the
          // abort the moment this resolves.
          entered();
        });
      },
      async endSession() {},
    };
    return { provider, created, sawAbort: () => sawAbort, reached };
  }

  it('stops the open instead of letting it finish unattended', async () => {
    const { provider, sawAbort, reached } = stalling();
    const c = new RemoteBrowserController({ provider });
    const pending = c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    pending.catch(() => {});
    await reached;

    await c.endRun('run-A');

    // Without this the open ran to completion on a run nothing was tracking
    // any more — no endRun would ever come for the session it allocated.
    expect(sawAbort(), 'endRun must reach a run that is still opening').toBe(true);
    const out = await Promise.race([
      pending,
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 250)),
    ]);
    expect(out, 'and the caller is not left waiting on it').not.toBe('hung');
  });

  it('disposes a deployment whose only run has not opened yet', async () => {
    // `dispose` is what a provider or credential change calls. It enumerated
    // open browsers only, so a session about to be allocated with the
    // credential being retired was invisible to it.
    const { provider, sawAbort, reached } = stalling();
    const c = new RemoteBrowserController({ provider });
    const pending = c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    pending.catch(() => {});
    await reached;

    await c.dispose();

    expect(sawAbort(), 'dispose must reach a run that is still opening').toBe(true);
  });
});

// Two hardening properties. Neither has a live trigger today; both pick the
// safe side of a failure that would otherwise cross a tenant boundary or hold
// a socket closure for the life of the process.
describe('the controller owns every scrap of a run\'s state', () => {
  it('refuses an action that cannot say which run it belongs to', async () => {
    // `sessionId` is a required string on the tool contract, so this should be
    // unreachable. The old fallback defaulted it to a shared 'unknown' bucket,
    // which on a deployment-wide controller means two tenants sharing a lease,
    // a browser and — on a non-isolating CDP endpoint — one page.
    const { provider, created } = fakeProvider();
    const c = new RemoteBrowserController({ provider });

    const out = await c.controller(
      { kind: 'click', selector: '#a' },
      { sessionId: '', actorId: 'w1' } as never,
    );

    expect(out.ok).toBe(false);
    expect(created, 'and no session was allocated for an unattributable call').toEqual([]);
  });

  it('drops a finished run\'s live-view listener without being asked twice', async () => {
    // The listener closes over the embedder's socket. The caller does remove
    // it today, but the controller cleans up everything else about a finished
    // run, and an embedder that threw between endRun and offLiveViewFor would
    // keep one closure per run forever.
    const { provider } = fakeProvider('https://provider.test/live/abc');
    const c = new RemoteBrowserController({ provider });

    const seen: Array<boolean> = [];
    c.onLiveViewFor('run-A', (info) => seen.push(info.active));
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.endRun('run-A');

    // The teardown's own "browser gone" announcement must still have arrived —
    // dropping the listener any earlier would take the panel down by silence
    // rather than by saying so.
    expect(seen, 'attached, then explicitly released').toEqual([true, false]);

    // Nothing further can reach it: a later announcement for a re-used run id
    // must not fire the old run's callback.
    seen.length = 0;
    await c.controller({ kind: 'click', selector: '#b' }, ctx('run-A', 'w2'));
    expect(seen, 'the finished run\'s listener is gone').toEqual([]);
  });
});

// Owning the pixel stream is what gives every provider a live view — a bare
// CDP endpoint has no viewer URL at all, so today that configuration ships a
// Stop button and a banner apologising that it cannot be watched.
describe('watching a run\'s browser', () => {
  it('streams nothing until somebody actually asks', async () => {
    // The reason this is a method rather than something open() does. An
    // unwatched run would otherwise pay to encode frames nobody sees, on every
    // run — and on a metered provider, pay to ship them too.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    expect(cdp.sent, 'a browser that nobody is watching encodes nothing').toEqual([]);

    await c.startWatching('run-A', () => {});
    expect(cdp.sent).toContain('Page.startScreencast');
  });

  it('hands each frame on, then acknowledges it', async () => {
    // The ack IS the flow control: Chrome sends the next frame only once the
    // last is acknowledged. Acking before delivery would turn that into a
    // firehose bounded by nothing; never acking stops the stream dead.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const seen: string[] = [];
    await c.startWatching('run-A', (f) => {
      seen.push(f.data);
      cdp.order.push(`deliver:${f.data}`);
    });

    cdp.pushFrame(1, 'FRAME-ONE');
    cdp.pushFrame(2, 'FRAME-TWO');

    expect(seen).toEqual(['FRAME-ONE', 'FRAME-TWO']);
    // Delivery before its own ack, for each frame in turn.
    expect(cdp.order).toEqual([
      'deliver:FRAME-ONE', 'ack:1',
      'deliver:FRAME-TWO', 'ack:2',
    ]);
  });

  it('reports the remote viewport, so a canvas need not guess', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    let got: { width: number; height: number } | undefined;
    await c.startWatching('run-A', (f) => { got = { width: f.width, height: f.height }; });
    cdp.pushFrame(1);

    expect(got).toEqual({ width: 1280, height: 800 });
  });

  it('stops paying for frames the moment nobody is watching', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.startWatching('run-A', () => {});

    await c.stopWatching('run-A');

    expect(cdp.sent).toContain('Page.stopScreencast');
    expect(cdp.detached, 'and the session goes with it').toBe(true);
  });

  it('tears the stream down when the run ends, without being asked', async () => {
    // A screencast left attached keeps Chrome encoding for a run that is over,
    // into a session about to be detached underneath it.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.startWatching('run-A', () => {});

    await c.endRun('run-A');

    expect(cdp.sent).toContain('Page.stopScreencast');
    expect(cdp.detached).toBe(true);
  });

  it('refuses to promise a stream it cannot deliver', async () => {
    // A run with no browser has nothing to show. Saying so lets the caller
    // avoid telling a viewer to expect frames that will never come.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });

    expect(await c.startWatching('never-opened', () => {})).toBe(false);

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    expect(await c.startWatching('run-A', () => {}), 'the first watcher attaches').toBe(true);
    // The answer is "is this page streaming", not "did you cause it to". They
    // used to share `false`, which told a reconnecting client that a stream it
    // was in fact receiving did not exist.
    expect(await c.startWatching('run-A', () => {}), 'and so is the second').toBe(true);
  });

  it('leaves nothing attached when the stream will not start', async () => {
    // The page went away between opening the session and starting the stream.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const good = cdp.send;
    cdp.send = async (method: string) => {
      if (method === 'Page.startScreencast') throw new Error('target closed');
      return good.call(cdp, method);
    };

    expect(await c.startWatching('run-A', () => {})).toBe(false);
    expect(cdp.detached, 'the half-open session is not left behind').toBe(true);

    // And the run can still be watched later, rather than being wedged as
    // "already watching" by the attempt that failed.
    cdp.send = good;
    expect(await c.startWatching('run-A', () => {})).toBe(true);
  });
});

// The other half of watching. A person who can see the page but cannot touch it
// is stuck the moment the agent hits a login, a captcha, or a consent dialog
// only they can answer — and the alternative the provider offers, an interactive
// viewer, is a SECOND controller racing the agent on the same page.
describe('handing the browser to the person watching', () => {
  /** Open a run's browser, start its stream, and report one frame. */
  async function watched(c: InstanceType<typeof RemoteBrowserController>, runId = 'run-A') {
    await c.controller({ kind: 'click', selector: '#a' }, ctx(runId, 'w1'));
    await c.startWatching(runId, () => {});
    // The viewport is only ever learned from a frame, so a takeover test that
    // never delivers one is testing a page nobody has seen.
    cdp.pushFrame(1);
  }

  it('refuses the agent outright once a person has taken over', async () => {
    // Refused, not queued. A worker parked behind a person acts the moment they
    // look away — minutes later, on a page they have since changed.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');

    expect(await c.takeOver('run-A')).toEqual({ ok: true });

    const out = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-A', 'w2'));
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/taken control/i);
    expect(page.calls, 'and it never reached the page').not.toContain('click:#b');
  });

  it('waits for the action already in flight before saying you have control', async () => {
    // The substance of the handoff. Playwright cannot be interrupted mid-call —
    // `click` waits for its element and then clicks — so a takeover that
    // returned immediately would put the person on a page an action was still
    // about to change.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);

    let finishClick = () => {};
    page.click = async (selector: string) => {
      page.calls.push(`click:${selector}`);
      await new Promise<void>((r) => { finishClick = r; });
    };
    const acting = c.controller({ kind: 'click', selector: '#slow' }, ctx('run-A', 'w1'));
    await new Promise((r) => setTimeout(r, 20));

    let granted = false;
    const handoff = c.takeOver('run-A').then((r) => { granted = r.ok; return r; });
    await new Promise((r) => setTimeout(r, 50));
    expect(granted, 'not while the agent is still inside the page').toBe(false);

    finishClick();
    await acting;
    expect((await handoff).ok).toBe(true);
  });

  it('places a click on the page it was clicked on', async () => {
    // The client sends a fraction of the picture; only this side knows the
    // viewport that picture was scaled down from.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    expect(await c.input('run-A', { kind: 'click', x: 0.5, y: 0.25 })).toEqual({ ok: true });

    const mouse = cdp.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
    // Half of 1280, a quarter of 800 — the viewport the frame reported.
    expect(mouse.map((m) => [m.params?.['type'], m.params?.['x'], m.params?.['y']])).toEqual([
      ['mouseMoved', 640, 200],
      ['mousePressed', 640, 200],
      ['mouseReleased', 640, 200],
    ]);
  });

  it('maps into the page\'s space, not the picture\'s', async () => {
    // The identity case cannot tell these apart: `deviceWidth/Height` are the
    // DEVICE SCREEN in DIP, while `Input.dispatchMouseEvent` wants the main
    // frame's viewport in CSS pixels. Here a 1280x900 screen shows a 1024x600
    // page, and `offsetTop` is non-zero to prove it is NOT subtracted — the
    // screencast frame is the page render, so a fraction of that image is
    // already a fraction of the page.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    cdp.layout = { clientWidth: 1024, clientHeight: 600 };
    await c.startWatching('run-A', () => {});
    cdp.pushFrame(1, 'JPEG', { deviceWidth: 1280, deviceHeight: 900, offsetTop: 100 });
    c.actorEnded('w1');
    await c.takeOver('run-A');

    // The middle of the picture is the middle of the page.
    await c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 });
    const middle = cdp.calls.find((call) => call.params?.['type'] === 'mousePressed');
    expect([middle?.params?.['x'], middle?.params?.['y']], 'the viewport\'s centre, in its own pixels')
      .toEqual([512, 300]);

    // And the very top of the picture is the very top of the page, not a
    // rejected click in a gutter that this frame does not contain.
    expect((await c.input('run-A', { kind: 'click', x: 0, y: 0 })).ok).toBe(true);
    const top = cdp.calls.filter((call) => call.params?.['type'] === 'mousePressed').at(-1);
    expect([top?.params?.['x'], top?.params?.['y']]).toEqual([0, 0]);
  });

  it('re-measures the page whenever it has been repainted', async () => {
    // The signal has to be broader than the screencast metadata. Resizing the
    // window on one monitor changes the CSS viewport while `deviceWidth`,
    // `deviceHeight` and `offsetTop` all hold still — so a cache keyed on those
    // looked correct only because the test that exercised it moved both at once.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.startWatching('run-A', () => {});
    cdp.pushFrame(1);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    await c.input('run-A', { kind: 'click', x: 1, y: 1 });
    const first = cdp.calls.filter((call) => call.params?.['type'] === 'mousePressed').at(-1);
    expect([first?.params?.['x'], first?.params?.['y']]).toEqual([1280, 800]);

    // The window was resized. The device screen did not move.
    cdp.layout = { clientWidth: 640, clientHeight: 480 };
    cdp.pushFrame(2, 'JPEG', { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0 });

    await c.input('run-A', { kind: 'click', x: 1, y: 1 });
    const second = cdp.calls.filter((call) => call.params?.['type'] === 'mousePressed').at(-1);
    expect([second?.params?.['x'], second?.params?.['y']], 'the new viewport, not the old one')
      .toEqual([640, 480]);
  });

  it('refuses to place a click it could not re-measure for', async () => {
    // Once the measurement is known stale, falling back to it is how a click
    // lands on whatever moved into that position after a resize. A refused
    // click is recoverable; a misplaced one is not.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.startWatching('run-A', () => {});
    cdp.pushFrame(1);
    c.actorEnded('w1');
    await c.takeOver('run-A');
    await c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 });

    // A fresh frame invalidates the measurement, and the page then refuses to
    // be measured.
    cdp.pushFrame(2);
    const good = cdp.send;
    cdp.send = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getLayoutMetrics') throw new Error('target closed');
      return good.call(cdp, method, params);
    };

    const before = cdp.calls.filter((call) => call.params?.['type'] === 'mousePressed').length;
    const out = await c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not been measured/i);
    expect(
      cdp.calls.filter((call) => call.params?.['type'] === 'mousePressed'),
      'and nothing was clicked on a guess',
    ).toHaveLength(before);
    cdp.send = good;
  });

  it('refuses rather than read device pixels as CSS pixels', async () => {
    // CDP's legacy `visualViewport` is documented as deprecated and in DEVICE
    // pixels; `cssVisualViewport` is the CSS-pixel replacement, and CSS pixels
    // are what `Input.dispatchMouseEvent` takes. Reading one as the other
    // reintroduces the wrong-coordinate bug at any device scale but 1 — on
    // precisely the old Chrome a fallback would be there to help. Converting
    // would need a scale valid for someone else's build; refusing is a fact
    // about ours.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    cdp.legacyOnly = true;
    await c.startWatching('run-A', () => {});
    cdp.pushFrame(1);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    const out = await c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not been measured/i);
    expect(cdp.sent, 'nothing was clicked in the wrong units').not.toContain('Input.dispatchMouseEvent');
  });

  it('keeps a click inside the picture it claims to come from', async () => {
    // Coordinates arrive from a client. Out-of-range ones would otherwise be
    // dispatched at negative or off-screen positions.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    await c.input('run-A', { kind: 'click', x: 4, y: -2 });

    const pressed = cdp.calls.find((call) => call.params?.['type'] === 'mousePressed');
    expect([pressed?.params?.['x'], pressed?.params?.['y']]).toEqual([1280, 0]);
  });

  it('types text in one piece and sends only keys that are commands', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    expect(await c.input('run-A', { kind: 'text', text: 'hunter2' })).toEqual({ ok: true });
    expect(await c.input('run-A', { kind: 'key', key: 'Enter' })).toEqual({ ok: true });

    const refused = await c.input('run-A', { kind: 'key', key: 'F12' });
    expect(refused.ok, 'the key list is an allowlist, not a passthrough').toBe(false);

    expect(cdp.calls.filter((call) => call.method === 'Input.insertText').map((m) => m.params?.['text']))
      .toEqual(['hunter2']);
    expect(cdp.calls.filter((call) => call.method === 'Input.dispatchKeyEvent')
      .map((m) => [m.params?.['type'], m.params?.['windowsVirtualKeyCode']]))
      .toEqual([['keyDown', 13], ['keyUp', 13]]);
  });

  it('refuses a kind it does not know instead of clicking', async () => {
    // A mutation boundary reached from a socket. The old chain of ifs ended in
    // the click branch, so a version-skewed or malformed event — `drag`, or a
    // kind with no coordinates at all — pressed the mouse on a real page, at
    // the top-left corner when the coordinates were missing.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    const out = await c.input('run-A', { kind: 'drag', x: 0.5, y: 0.5 } as never);
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not something that can be done/i);

    // A KNOWN kind with missing or malformed required fields is just as
    // malformed. An earlier version of this test asserted the opposite — that
    // a click with no coordinates was "still a click" — which codified the bug
    // rather than catching it: the coordinates were coerced to 0 and the mouse
    // was pressed at the top-left corner of a real page.
    for (const bad of [
      { kind: 'click' },
      { kind: 'click', x: 0.5 },
      { kind: 'move', x: 'left', y: 0.5 },
      { kind: 'click', x: Number.NaN, y: 0.5 },
      { kind: 'scroll', x: 0.5, y: 0.5 },
      // The same rule for the fields of the other kinds: a number where text
      // belongs would have typed "123" into the page, and a non-finite click
      // count reached CDP as `clickCount: NaN`.
      { kind: 'text', text: 123 },
      { kind: 'key' },
      { kind: 'click', x: 0.5, y: 0.5, clicks: 'lots' },
      // Present-but-invalid is not the same as absent: this used to fall
      // through to a real left click nobody asked for.
      { kind: 'click', x: 0.5, y: 0.5, button: 'primary' },
      // Inherited properties are not allowlist entries. `KEYS['__proto__']` is
      // Object.prototype and truthy; `'toString' in BUTTONS` is true and hands
      // back a function. An allowlist that answers for keys nobody put in it
      // is not an allowlist.
      { kind: 'key', key: '__proto__' },
      { kind: 'key', key: 'constructor' },
      { kind: 'click', x: 0.5, y: 0.5, button: 'toString' },
    ]) {
      const refused = await c.input('run-A', bad as never);
      expect(refused.ok, `${JSON.stringify(bad)} must not reach the page`).toBe(false);
    }

    expect(
      cdp.sent.filter((m) => m === 'Input.dispatchMouseEvent'),
      'not one of them touched the mouse',
    ).toHaveLength(0);
    expect(cdp.sent, 'and nothing was typed either').not.toContain('Input.insertText');

    // And the well-formed one still works, so this is a gate rather than a wall.
    expect((await c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 })).ok).toBe(true);
    expect(
      cdp.calls.filter((call) => call.params?.['type'] === 'mousePressed'),
      'exactly one press, from the only valid click',
    ).toHaveLength(1);
  });

  it('refuses input from someone who has not taken control', async () => {
    // Per event, not per session: a socket that was allowed to click once is
    // not thereby allowed to click for the rest of the run.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');

    const out = await c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/take control/i);
    expect(cdp.sent).not.toContain('Input.dispatchMouseEvent');
  });

  it('stops accepting input the moment the run is stopped', async () => {
    // Stop takes the browser away from EVERYONE, the person included. It is
    // the same kill switch it always was, and a takeover must not turn it into
    // one that only stops the agent.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    c.stopRun('run-A');
    expect(c.humanHolds('run-A'), 'the hold goes with the run').toBe(false);

    const out = await c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 });
    expect(out.ok).toBe(false);
    expect(cdp.sent).not.toContain('Input.dispatchMouseEvent');
  });

  it('will not drive a browser nobody is watching', async () => {
    // Input you cannot see the result of is not a takeover.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');
    await c.stopWatching('run-A');

    const out = await c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/streaming/i);
  });

  it('does not let the agent start on top of a click still going in', async () => {
    // Handback is where the two sides are closest to touching. The person's
    // click is dispatched over CDP and awaited; if the hold can be released
    // while that is in flight, the agent acquires and acts on top of it —
    // exactly the concurrent control a takeover exists to prevent.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    // Hold the person's dispatch open inside CDP.
    const gate = deferred();
    const realSend = cdp.send;
    cdp.send = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mousePressed') await gate.promise;
      return realSend.call(cdp, method, params);
    };

    const clicking = c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 });
    await new Promise((r) => setTimeout(r, 20));

    // The person lets go while their click is still landing.
    expect(c.handBack('run-A'), 'not while their event is in flight').toBe(false);

    let agentActed = false;
    const agent = c.controller({ kind: 'click', selector: '#agent' }, ctx('run-A', 'w2'))
      .then((r) => { agentActed = r.ok; return r; });
    await new Promise((r) => setTimeout(r, 30));
    expect(agentActed, 'and the agent is not in the page yet').toBe(false);
    expect(page.calls, 'nothing of the agent\'s has touched it').not.toContain('click:#agent');

    gate.resolve();
    cdp.send = realSend;
    expect((await clicking).ok).toBe(true);
    await agent;
  });

  it('gives the agent the browser back when the person is done', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    expect(c.handBack('run-A')).toBe(true);
    expect(c.handBack('run-A'), 'and a second click is not a second handback').toBe(false);

    const out = await c.controller({ kind: 'click', selector: '#b' }, ctx('run-A', 'w2'));
    expect(out.ok).toBe(true);
    expect(page.calls).toContain('click:#b');
  });

  it('suspends the picture without giving up control', async () => {
    // Signing in: the password is dots, but the manager's dropdown, a one-time
    // code and the page afterwards are not.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    expect(await c.setCapture('run-A', false)).toBe(false);
    expect(cdp.sent).toContain('Page.stopScreencast');
    expect(cdp.detached, 'the session stays, or the input channel would go with it').toBe(false);

    // Still theirs, and still able to type into the page they cannot see.
    expect(await c.input('run-A', { kind: 'text', text: 'hunter2' })).toEqual({ ok: true });

    expect(await c.setCapture('run-A', true)).toBe(true);
    expect(cdp.sent.filter((m) => m === 'Page.startScreencast')).toHaveLength(2);
  });

  it('will not let anyone but the holder hide the page', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');

    // Nobody has taken over, so nobody may make the agent invisible.
    expect(await c.setCapture('run-A', false)).toBe(true);
    expect(cdp.sent).not.toContain('Page.stopScreencast');
  });

  it('will not hide a page that has never been shown', async () => {
    // The same invariant below the UI, because a client is an affordance and
    // this is the rule. `streaming` is announced the moment startScreencast
    // returns, so a takeover in the window before the first frame could ask for
    // the blind period on a page nobody had seen — and a hand-made or
    // version-skewed client is not stopped by hiding a button.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    await c.startWatching('run-A', () => {});
    c.actorEnded('w1');
    await c.takeOver('run-A');

    expect(await c.setCapture('run-A', false), 'still showing').toBe(true);
    expect(cdp.sent, 'the picture was never stopped').not.toContain('Page.stopScreencast');

    // A frame arrives, and only now is there a page they have seen to hide.
    cdp.pushFrame(1);
    expect(await c.setCapture('run-A', false), 'now it is theirs to hide').toBe(false);
    expect(cdp.sent).toContain('Page.stopScreencast');
  });

  it('does not let one watcher\'s picture vouch for the next', async () => {
    // `framed` belongs to the STREAM, not to the run. A remount tears the
    // screencast down and builds another, and the client that comes back has an
    // empty panel however much the last one saw — so the new stream earns the
    // claim again rather than inheriting it. The re-attach already resets
    // `capturing` for the same reason.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    await c.stopWatching('run-A');
    await c.startWatching('run-A', () => {});
    c.actorEnded('w1');
    await c.takeOver('run-A');

    const stopped = cdp.sent.filter((m) => m === 'Page.stopScreencast').length;
    expect(await c.setCapture('run-A', false), 'the new stream has shown nothing').toBe(true);
    expect(
      cdp.sent.filter((m) => m === 'Page.stopScreencast'),
      'and nothing was stopped on its account',
    ).toHaveLength(stopped);

    cdp.pushFrame(1);
    expect(await c.setCapture('run-A', false), 'once it has, hiding is theirs again').toBe(false);
  });

  it('keeps a frame that arrived while the stream was still starting', async () => {
    // A CDP event does not wait for the command response. Chrome emits the
    // first frame as soon as the screencast is running, which can be before
    // `Page.startScreencast` resolves — so clearing `framed` after that await
    // erased the one picture the person is actually looking at. On an idle page
    // no second frame comes to correct it, which made the failure stick: the
    // client offered Hide because it really had a frame, and the server refused
    // every request as a page never shown.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const realSend = cdp.send;
    cdp.send = async (method: string, params?: Record<string, unknown>) => {
      const out = await realSend.call(cdp, method, params);
      // Delivered before the caller ever sees the start resolve.
      if (method === 'Page.startScreencast') cdp.pushFrame(1);
      return out;
    };

    const seen: unknown[] = [];
    await c.startWatching('run-A', (f) => seen.push(f));
    cdp.send = realSend;
    expect(seen, 'the person is looking at a picture').toHaveLength(1);

    c.actorEnded('w1');
    await c.takeOver('run-A');

    // And nothing else arrives, because the page is idle.
    expect(await c.setCapture('run-A', false), 'so it is theirs to hide').toBe(false);
    expect(cdp.sent).toContain('Page.stopScreencast');
  });

  it('brings the page back before the agent acts, after an explicit handback', async () => {
    // Hide the page, give it back, and the agent must not carry on against a
    // panel frozen on the last picture.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');
    await c.setCapture('run-A', false);
    expect(cdp.sent).toContain('Page.stopScreencast');
    c.handBack('run-A');

    const out = await c.controller({ kind: 'click', selector: '#after' }, ctx('run-A', 'w2'));

    expect(out.ok).toBe(true);
    expect(page.calls).toContain('click:#after');
    // Restarted before the click, not after it.
    const restarted = cdp.sent.lastIndexOf('Page.startScreencast');
    expect(restarted, 'the picture came back').toBeGreaterThan(cdp.sent.indexOf('Page.stopScreencast'));
  });

  it('does not let a handback slip past a capture that is still being suspended', async () => {
    // The window the sequential tests cannot see. Hiding the page awaits CDP,
    // and nothing used to record that the transition was in flight — so a
    // handback landing inside it found no action, released the hold, and the
    // agent reached the visibility gate while `capturing` was still true. It
    // passed, and entered the page as the suspension completed behind it.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    // Hold the suspension open inside CDP.
    const gate = deferred();
    const realSend = cdp.send;
    cdp.send = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.stopScreencast') await gate.promise;
      return realSend.call(cdp, method, params);
    };

    const hiding = c.setCapture('run-A', false);
    await new Promise((r) => setTimeout(r, 20));

    expect(c.handBack('run-A'), 'not while the picture is still going down').toBe(false);

    // The hold therefore still stands, so the agent is turned away rather than
    // slipping through the gate while `capturing` is mid-change.
    const during = await c.controller({ kind: 'click', selector: '#agent' }, ctx('run-A', 'w2'));
    expect(during.ok).toBe(false);
    expect(during.detail).toMatch(/taken control/i);
    expect(page.calls, 'nothing of the agent\'s reached the page').not.toContain('click:#agent');

    // Let the suspension land. The deferred handback then retries and releases.
    gate.resolve();
    cdp.send = realSend;
    expect(await hiding, 'the picture is off').toBe(false);
    // The handback was ASKED FOR, so the transition settling does not undo it —
    // even though hiding the page is itself activity that would otherwise
    // extend the hold.
    await new Promise((r) => setTimeout(r, 60));
    expect(c.humanHolds('run-A'), 'and only now does the hold end').toBe(false);

    // And when the agent finally does act, it acts with the picture back on.
    const after = await c.controller({ kind: 'click', selector: '#agent' }, ctx('run-A', 'w2'));
    expect(after.ok).toBe(true);
    expect(cdp.sent.filter((m) => m === 'Page.startScreencast'), 'hidden, then shown again')
      .toHaveLength(2);
    expect(page.calls).toContain('click:#agent');
  });

  it('brings the page back before the agent acts, after the hold lapses', async () => {
    // The same hole by the other route, and the one nobody clicks: the person
    // hides the page to type a password, then walks away.
    vi.useFakeTimers();
    try {
      const { provider } = fakeProvider();
      const c = new RemoteBrowserController({ provider });
      await watched(c);
      c.actorEnded('w1');
      await c.takeOver('run-A');
      await c.setCapture('run-A', false);

      await vi.advanceTimersByTimeAsync(150_000);
      expect(c.humanHolds('run-A'), 'the hold lapsed').toBe(false);

      const acting = c.controller({ kind: 'click', selector: '#after' }, ctx('run-A', 'w2'));
      await vi.advanceTimersByTimeAsync(100);
      expect((await acting).ok).toBe(true);

      expect(cdp.sent.filter((m) => m === 'Page.startScreencast'), 'hidden, then shown again')
        .toHaveLength(2);
      expect(page.calls).toContain('click:#after');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a takeover of a run with no browser, and of a stopped one', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });

    expect((await c.takeOver('never-opened')).ok).toBe(false);

    await watched(c);
    c.actorEnded('w1');
    c.stopRun('run-A');
    const out = await c.takeOver('run-A');
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/stopped/i);
  });

  it('says who has the browser, and stays quiet while nothing changes', async () => {
    // The lease reports every ownership change, and during ordinary work that
    // is one per action as workers take it and hand it back. A viewer does not
    // need a socket message on every click the agent makes.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    const seen: Array<{ human: boolean; capturing: boolean }> = [];
    c.onControlFor('run-A', (state) => seen.push(state));

    await watched(c);
    await c.controller({ kind: 'click', selector: '#b' }, ctx('run-A', 'w1'));
    await c.controller({ kind: 'click', selector: '#c' }, ctx('run-A', 'w1'));
    c.actorEnded('w1');
    expect(seen, 'the agent had it before and has it now').toEqual([
      { human: false, capturing: true },
    ]);

    await c.takeOver('run-A');
    await c.setCapture('run-A', false);
    expect(seen.slice(1)).toEqual([
      { human: true, capturing: true },
      { human: true, capturing: false },
    ]);
  });

  it('answers Take control again for a page that came back not knowing', async () => {
    // After a reload the client believes the agent has the browser while the
    // server still has the person holding it. Take control is the button
    // somebody presses when the panel looks wrong, so a takeover by the
    // existing holder has to ANSWER rather than dedupe itself into silence and
    // leave them pressing it.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await watched(c);
    c.actorEnded('w1');
    await c.takeOver('run-A');

    const seen: Array<{ human: boolean }> = [];
    c.onControlFor('run-A', (state) => seen.push({ human: state.human }));

    expect((await c.takeOver('run-A')).ok, 'still theirs').toBe(true);
    expect(seen, 'and it said so, unchanged though it is').toEqual([{ human: true }]);
  });

  it('tells the viewer when a hold lapses, rather than letting it find out', async () => {
    // A client left believing it still has control keeps sending input into a
    // lease it no longer holds: every event refused, nothing on screen saying
    // why, and the agent quietly driving again underneath.
    vi.useFakeTimers();
    try {
      const { provider } = fakeProvider();
      const c = new RemoteBrowserController({ provider });
      const seen: Array<{ human: boolean }> = [];
      c.onControlFor('run-A', (state) => seen.push({ human: state.human }));

      await watched(c);
      c.actorEnded('w1');
      await c.takeOver('run-A');
      await vi.advanceTimersByTimeAsync(180_000);

      expect(seen.map((s) => s.human)).toEqual([false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts hiding the page as being there', async () => {
    // Hide is an authorised action from the holder, so it extends the hold like
    // any other. Without that, the worst case is exact: hide at 119.9s to type
    // a password, the old deadline fires while CDP is still stopping capture,
    // and the hold lapses moments after a fresh interaction — with the picture
    // off, which is the worst moment for it to go.
    vi.useFakeTimers();
    try {
      const { provider } = fakeProvider();
      const c = new RemoteBrowserController({ provider });
      await watched(c);
      c.actorEnded('w1');
      await c.takeOver('run-A');

      await vi.advanceTimersByTimeAsync(119_000);
      expect(c.humanHolds('run-A')).toBe(true);

      await c.setCapture('run-A', false);

      // The old deadline comes and goes.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(c.humanHolds('run-A'), 'hiding the page was them being there').toBe(true);

      // And a fresh full interval from the interaction, not from before it.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(c.humanHolds('run-A')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an idle deadline outrank the event it interrupted', async () => {
    // The ordering the test above cannot reach, and the reason it could not:
    // `await c.setCapture(...)` completes within the same tick, so `touch()`
    // runs BEFORE the old deadline and the transition is never actually held
    // across it. Both `input` and `setCapture` touch the lease only after their
    // awaited CDP call, so a real event that takes longer than the second it
    // has left is still in flight when the deadline fires.
    //
    // The lapse used to record itself as a wanted handback, which is a flag
    // `touch()` deliberately refuses to clear — so the completed interaction
    // bought nothing and the deferred retry released the hold 25ms later,
    // moments after the person had just used it. An explicit "Give it back"
    // must survive activity that was already under way; an idle expiry must
    // not, because the event it interrupted is proof the person was there.
    vi.useFakeTimers();
    try {
      const { provider } = fakeProvider();
      const c = new RemoteBrowserController({ provider });
      await watched(c);
      c.actorEnded('w1');
      await c.takeOver('run-A');

      // Hold the person's own event open, inside CDP, across the deadline.
      const gate = deferred();
      const realSend = cdp.send;
      cdp.send = async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Input.dispatchMouseEvent') await gate.promise;
        return realSend.call(cdp, method, params);
      };

      await vi.advanceTimersByTimeAsync(119_000);
      const clicking = c.input('run-A', { kind: 'click', x: 0.5, y: 0.5 });
      await vi.advanceTimersByTimeAsync(1);

      // The old deadline comes round while the click is still going in.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(c.humanHolds('run-A'), 'the deadline landed on their own event').toBe(true);

      gate.resolve();
      cdp.send = realSend;
      expect((await clicking).ok).toBe(true);

      // THIS is the assertion the old code failed: the deferred retry found no
      // action and released, a fifth of a second after a click the person made.
      await vi.advanceTimersByTimeAsync(100);
      expect(c.humanHolds('run-A'), 'the finished click is not the moment to let go').toBe(true);

      // And what it bought is a full fresh interval measured from the click,
      // not the one the interrupted lapse re-armed for itself.
      await vi.advanceTimersByTimeAsync(119_000);
      expect(c.humanHolds('run-A'), 'a full interval, from the interaction').toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(c.humanHolds('run-A'), 'and then the silence after it ends the hold').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets go of a browser the person walked away from', async () => {
    // A person has no terminal signal — no worker end, no run completion. A
    // takeover nobody is using still holds a billed session and, at the default
    // of one, blocks every other run on the deployment.
    vi.useFakeTimers();
    try {
      const { provider } = fakeProvider();
      const c = new RemoteBrowserController({ provider });
      await watched(c);
      c.actorEnded('w1');
      await c.takeOver('run-A');
      expect(c.humanHolds('run-A')).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      await c.input('run-A', { kind: 'move', x: 0.1, y: 0.1 });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(c.humanHolds('run-A'), 'using it keeps it').toBe(true);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(c.humanHolds('run-A'), 'and not using it does not').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Watching is started by a client effect, and effects do not queue: a mount
// that runs, cleans up and runs again emits watch, unwatch, watch with nothing
// in between. Every test above awaits each call in turn, which is exactly the
// ordering that hides what happens when they overlap.
describe('two watches racing each other', () => {
  it('opens one CDP session, not one per asker', async () => {
    // The second used to overwrite the first, leaving a session attached,
    // streaming and unreachable — Chrome encoding a page nobody can stop.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const gate = deferred();
    cdpGate = gate.promise;
    const first = c.startWatching('run-A', () => {});
    const second = c.startWatching('run-A', () => {});
    gate.resolve();

    expect([await first, await second], 'both are streaming').toEqual([true, true]);
    expect(cdpCreated, 'but only one session was opened').toBe(1);
    expect(cdp.sent.filter((m) => m === 'Page.startScreencast')).toHaveLength(1);
  });

  it('stops a stream that was still attaching when the panel closed', async () => {
    // The stop used to find no session and return, and the attach finished
    // behind it: a stream running for a panel already gone, which nothing
    // afterwards would ever stop.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const gate = deferred();
    cdpGate = gate.promise;
    const watching = c.startWatching('run-A', () => {});
    const stopping = c.stopWatching('run-A');
    gate.resolve();
    await watching;
    await stopping;

    expect(cdp.sent).toContain('Page.stopScreencast');
    expect(cdp.detached, 'and the session goes with it').toBe(true);
  });

  it('tells a reconnecting client the truth about a stream that never stopped', async () => {
    // A transient socket drop sends no unwatch: the run and its transport
    // survive, so the screencast stays attached and its frames follow the
    // rebind. The reloaded client then asks to watch. Answering "nothing to
    // stream" left the panel saying it could not be watched — and because CDP
    // frames are adaptive, an idle page sends nothing to correct it, so the
    // panel could sit wrong indefinitely.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const before: string[] = [];
    expect(await c.startWatching('run-A', (f) => before.push(f.data))).toBe(true);

    // The page is idle across the reconnect — deliberately no frame here.
    const after: string[] = [];
    expect(await c.startWatching('run-A', (f) => after.push(f.data)), 'still streaming').toBe(true);
    expect(cdp.sent.filter((m) => m === 'Page.startScreencast'), 'and not restarted').toHaveLength(1);

    // And the reconnected client is the one that receives, not the dead one.
    cdp.pushFrame(1, 'AFTER-RECONNECT');
    expect(after).toEqual(['AFTER-RECONNECT']);
    expect(before, 'the connection that went away gets nothing').toEqual([]);
  });

  it('ends up watching after watch, unwatch, watch', async () => {
    // The sequence a StrictMode mount produces on its own, and the one the
    // pair-wise tests above cannot see. Treating an in-flight attach as a
    // failed second watch used to leave the panel mounted with no stream: the
    // second watch gave up, then the queued unwatch tore down the first.
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const gate = deferred();
    cdpGate = gate.promise;
    const first = c.startWatching('run-A', () => {});
    const stopping = c.stopWatching('run-A');
    const second = c.startWatching('run-A', () => {});
    gate.resolve();

    expect(await first, 'the first watch attached').toBe(true);
    await stopping;
    expect(await second, 'and the last one asked for wins').toBe(true);

    // Attached, torn down, attached again — in the order they were asked for.
    expect(cdp.sent.filter((m) => m === 'Page.startScreencast')).toHaveLength(2);
    expect(cdp.sent.filter((m) => m === 'Page.stopScreencast')).toHaveLength(1);
    expect(cdpCreated, 'a session per attach, not one shared or one leaked').toBe(2);
  });

  it('lets the run end while a stream is still attaching', async () => {
    const { provider } = fakeProvider();
    const c = new RemoteBrowserController({ provider });
    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    const gate = deferred();
    cdpGate = gate.promise;
    const watching = c.startWatching('run-A', () => {});
    const ending = c.endRun('run-A');
    gate.resolve();
    await watching;
    await ending;

    expect(cdp.detached, 'a run that is over leaves nothing encoding').toBe(true);
  });
});
