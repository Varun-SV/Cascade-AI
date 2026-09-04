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
  isClosed() { return this.closed; },
};

const browser = { closed: false, contexts: () => [{ pages: () => [page], newPage: async () => page }], newContext: async () => ({ pages: () => [page], newPage: async () => page }), close: async () => { browser.closed = true; } };

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

beforeEach(() => {
  page.closed = false;
  page.currentUrl = 'https://start.test/';
  page.calls = [];
  page.navHandlers = [];
  browser.closed = false;
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
    c.onLiveViewFor('run-A', (u) => seenA.push(u));
    c.onLiveViewFor('run-B', (u) => seenB.push(u));

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));

    expect(seenA).toEqual(['https://provider.test/live/abc']);
    expect(seenB, 'run B is not driving anything yet').toEqual([]);
  });

  it('stops telling a run about a browser once it has detached', async () => {
    const { provider } = fakeProvider('https://provider.test/live/abc');
    const c = new RemoteBrowserController({ provider });
    const seen: Array<string | undefined> = [];
    c.onLiveViewFor('run-A', (u) => seen.push(u));
    c.offLiveViewFor('run-A');

    await c.controller({ kind: 'click', selector: '#a' }, ctx('run-A', 'w1'));
    expect(seen).toEqual([]);
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
