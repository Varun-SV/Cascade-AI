import { describe, it, expect } from 'vitest';
import type { BrowserAction, BrowserActionContext, BrowserActionOutcome } from '../../tools/browser-control.js';
import type { RemoteBrowserController, BrowserStep } from './controller.js';
import type { RemoteBrowserProvider, RemoteBrowserSession } from './provider.js';
import { TabbedBrowserController, siteOf } from './tabbed-controller.js';

/**
 * A tab's controller, as far as the tabbed one can tell: opens its session on the
 * first action, holds it, and reports each step. `gate` lets a test hold an action open.
 */
class FakeTab {
  session: RemoteBrowserSession | null = null;
  url = '';
  ended: string[] = [];
  stopped = 0;
  disposed = false;
  actions: Array<{ actor: string; action: BrowserAction }> = [];
  step?: (s: BrowserStep) => void;
  live?: (i: { active: boolean; liveViewUrl?: string }) => void;
  gate: Promise<void> = Promise.resolve();
  constructor(readonly provider: RemoteBrowserProvider) {}
  readonly features = { pageView: true, screenshots: true, marked: true };
  get controller() {
    return async (action: BrowserAction, ctx: BrowserActionContext): Promise<BrowserActionOutcome> => {
      if (!this.session) {
        try { this.session = await this.provider.createSession(); } catch (e) { return { ok: false, detail: `no browser: ${(e as Error).message}` }; }
        this.live?.({ active: true });
      }
      this.actions.push({ actor: ctx.actorId, action });
      await this.gate;
      if (action.kind === 'navigate' && action.url) this.url = action.url;
      this.step?.({ kind: action.kind, summary: action.kind, ok: true, url: this.url, at: 0 });
      return { ok: true, detail: 'done', url: this.url };
    };
  }
  actorEnded(a: string) { this.ended.push(a); }
  onStepFor(_k: string, l: (s: BrowserStep) => void) { this.step = l; }
  offStepFor() { this.step = undefined; }
  onLiveViewFor(_k: string, l: (i: { active: boolean; liveViewUrl?: string }) => void) { this.live = l; }
  offLiveViewFor() { this.live = undefined; }
  onControlFor() {}
  offControlFor() {}
  onBusyFor() {}
  offBusyFor() {}
  setAllowanceFor() {}
  stopRun() { this.stopped += 1; }
  async endRun() { if (this.session) await this.provider.endSession(this.session.id); this.session = null; this.live?.({ active: false }); }
  async dispose() { this.disposed = true; }
}

/** A device that gives `allow` tabs, then refuses as an older device does. */
function device(allow: number) {
  let open = 0;
  let next = 1;
  const provider: RemoteBrowserProvider = {
    name: 'your own browser', isolatesSessions: true, allocatesSessions: false, guardsScreenshots: true,
    async createSession() {
      if (open >= allow) throw new Error('the browser is already in use');
      open += 1;
      return { id: `relay-${next++}`, cdpUrl: 'ws://x' };
    },
    async endSession() { open -= 1; },
  };
  return { provider, open: () => open };
}

function setup(allow: number, maxTabs = 4) {
  const d = device(allow);
  const tabs: FakeTab[] = [];
  const ctl = new TabbedBrowserController({
    provider: d.provider, maxTabs,
    makeTab: (p) => { const t = new FakeTab(p); tabs.push(t); return t as unknown as RemoteBrowserController; },
  });
  const act = (actor: string, action: BrowserAction) => ctl.controller(action, { sessionId: 'run-1', actorId: actor } as BrowserActionContext);
  return { ctl, tabs, act, device: d };
}

const go = (url: string): BrowserAction => ({ kind: 'navigate', url });

describe('TabbedBrowserController', () => {
  it('gives each worker a tab of its own, up to the limit, and then shares', async () => {
    const { ctl, tabs, act } = setup(8, 3);
    await act('w1', go('https://a.com'));
    await act('w2', go('https://b.com'));
    await act('w3', go('https://c.com'));
    expect(ctl.tabCount()).toBe(3);
    expect(tabs.map((t) => t.actions[0]!.actor)).toEqual(['w1', 'w2', 'w3']);
    // Past the limit: the least busy tab, taking turns there.
    await act('w4', go('https://d.com'));
    expect(ctl.tabCount()).toBe(3);
    expect(tabs.flatMap((t) => t.actions.map((a) => a.actor))).toContain('w4');
    // A worker keeps its own tab.
    await act('w2', { kind: 'extract_text' });
    expect(tabs[1]!.actions.at(-1)!.actor).toBe('w2');
  });

  it('runs workers in parallel, each in its own tab', async () => {
    const { tabs, act } = setup(8);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const first = act('w1', go('https://a.com'));
    await new Promise((r) => setTimeout(r, 0));
    tabs[0]!.gate = held;
    const slow = act('w1', { kind: 'extract_text' });
    // w2 is not held up behind w1's slow action.
    const quick = await act('w2', go('https://b.com'));
    expect(quick.ok).toBe(true);
    release();
    await Promise.all([first, slow]);
  });

  it('an older device that gives one tab: the run shares it, and the model never hears of it', async () => {
    const { ctl, tabs, act } = setup(1);
    expect((await act('w1', go('https://a.com'))).ok).toBe(true);
    const second = await act('w2', go('https://b.com'));
    expect(second.ok).toBe(true);
    expect(ctl.tabCount()).toBe(1);
    expect(tabs[0]!.actions.map((a) => a.actor)).toEqual(['w1', 'w2']);
    expect(tabs[1]!.disposed).toBe(true);
    // Not asked again for this run.
    await act('w3', go('https://c.com'));
    expect(tabs).toHaveLength(2);
  });

  it('a failure to open the FIRST tab is the action\'s, as before', async () => {
    const { act } = setup(0);
    const out = await act('w1', go('https://a.com'));
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/no browser/);
  });

  it('no more than two of the run\'s tabs on one site: a third worker joins one of them', async () => {
    const { ctl, tabs, act } = setup(8);
    await act('w1', go('https://shop.example.com/a'));
    await act('w2', go('https://www.example.com/b'));
    await act('w3', go('https://example.com/c'));
    expect(ctl.tabCount()).toBe(2);
    expect(tabs[0]!.actions.map((a) => a.actor).concat(tabs[1]!.actions.map((a) => a.actor))).toContain('w3');
    // Another site still gets its own tab.
    await act('w4', go('https://other.org'));
    expect(ctl.tabCount()).toBe(3);
  });

  it('workers heading for one site together open no more than two tabs there (Codex on fb05b5d)', async () => {
    const { ctl, tabs, act } = setup(8);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // Every tab's first action waits, so none has reported its page yet.
    const go4 = ['w1', 'w2', 'w3', 'w4'].map((w) => {
      const p = act(w, go('https://example.com/' + w));
      for (const t of tabs) t.gate = held;
      return p;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(ctl.tabCount()).toBe(2);
    release();
    await Promise.all(go4);
    expect(ctl.tabCount()).toBe(2);
  });

  it('after Stop, no action runs and no new tab is opened for the run (Codex on fb05b5d)', async () => {
    const { ctl, act, tabs } = setup(8);
    await act('w1', go('https://a.com'));
    ctl.stopRun('run-1');
    const out = await act('w2', go('https://b.com'));
    expect(out).toEqual({ ok: false, detail: 'The user stopped browser control for this run.' });
    expect(ctl.tabCount()).toBe(1);
    expect(tabs).toHaveLength(1);
  });

  it('moving a worker to another tab ends its hold on the old one', async () => {
    const { tabs, act } = setup(8);
    await act('w1', go('https://a.com'));
    await act('w2', go('https://a.com/x'));
    await act('w3', go('https://b.com'));
    // w3 now heads for a.com, where two tabs already are.
    await act('w3', go('https://a.com/y'));
    expect(tabs[2]!.ended).toContain('w3');
  });

  it('a finished worker\'s tab is reused by the next', async () => {
    const { ctl, tabs, act } = setup(8);
    await act('w1', go('https://a.com'));
    await act('w2', go('https://b.com'));
    ctl.actorEnded('w1');
    await act('w3', go('https://c.com'));
    expect(ctl.tabCount()).toBe(2);
    expect(tabs[0]!.actions.at(-1)!.actor).toBe('w3');
    expect(tabs.every((t) => t.ended.includes('w1'))).toBe(true);
  });

  it('steps say which tab, once there is more than one; Stop and end reach every tab', async () => {
    const { ctl, tabs, act, device } = setup(8);
    const steps: BrowserStep[] = [];
    ctl.onStepFor('run-1', (s) => steps.push(s));
    await act('w1', go('https://a.com'));
    await act('w2', go('https://b.com'));
    expect(steps[0]!.tab).toBeUndefined();
    expect(steps[1]!.tab).toBe(2);
    ctl.stopRun('run-1');
    expect(tabs.every((t) => t.stopped === 1)).toBe(true);
    await ctl.endRun('run-1');
    expect(device.open()).toBe(0);
  });

  it('the live view stays on while any tab is open', async () => {
    const { ctl, act, tabs } = setup(8);
    const seen: boolean[] = [];
    ctl.onLiveViewFor('run-1', (i) => { seen.push(i.active); });
    await act('w1', go('https://a.com'));
    await act('w2', go('https://b.com'));
    await tabs[1]!.endRun();
    expect(seen.at(-1)).toBe(true);
    await tabs[0]!.endRun();
    expect(seen.at(-1)).toBe(false);
  });
});

describe('siteOf', () => {
  it('groups a site\'s hosts, and keeps country second levels', () => {
    expect(siteOf('https://shop.example.com/x')).toBe('example.com');
    expect(siteOf('https://www.example.com')).toBe('example.com');
    expect(siteOf('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(siteOf('https://a.b.amazon.de')).toBe('amazon.de');
    expect(siteOf('http://127.0.0.1:3000')).toBe('127.0.0.1');
    expect(siteOf('not a url')).toBeUndefined();
  });
});
