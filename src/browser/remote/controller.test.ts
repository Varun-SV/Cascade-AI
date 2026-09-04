// ─────────────────────────────────────────────
//  Cascade AI — driving a remote browser
// ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RemoteBrowserProvider } from './provider.js';

/** The fake page every test drives, and the record of what it was asked. */
const page = {
  closed: false,
  currentUrl: 'https://start.test/',
  navHandlers: [] as Array<() => void>,
  calls: [] as string[],
  url() { return this.currentUrl; },
  async title() { return 'Title'; },
  async goto(u: string) { this.calls.push(`goto:${u}`); this.currentUrl = u; this.navHandlers.forEach((h) => h()); },
  async click(s: string) { this.calls.push(`click:${s}`); },
  async fill(s: string, v: string) { this.calls.push(`fill:${s}=${v}`); },
  async press(s: string, k: string) { this.calls.push(`press:${s}:${k}`); },
  keyboard: { press: async (k: string) => { page.calls.push(`key:${k}`); } },
  async waitForSelector(s: string) { this.calls.push(`wait:${s}`); },
  async innerText(s: string) { this.calls.push(`text:${s}`); return 'page text'; },
  on(event: string, handler: () => void) { if (event === 'framenavigated') this.navHandlers.push(handler); },
  async close() { this.closed = true; },
  isClosed() { return this.closed; },
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
    close: async () => { c.closed = true; },
  };
  return c;
}

/** The context a shared endpoint already had. Belongs to the operator. */
const defaultContext = fakeContext(page);
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
  page.currentUrl = 'https://start.test/';
  page.calls = [];
  page.navHandlers = [];
  browser.closed = false;
  browser.contexts = () => [defaultContext];
  defaultContext.closed = false;
  createdContexts.length = 0;
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

    expect(page.closed, 'nothing is in flight, so nothing should be closed').toBe(false);
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
