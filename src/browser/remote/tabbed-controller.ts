// ─────────────────────────────────────────────
//  Cascade AI — Several tabs for one run, on the user's own browser
// ─────────────────────────────────────────────
//
//  A run whose workers browse in parallel used to take turns in one tab. Here
//  each worker that needs the browser gets a tab of its own, up to a limit, and
//  each tab is a whole RemoteBrowserController with one session: its own lease
//  on the device, its own fence, its own connection. None of the rules that
//  keep one tab safe is loosened to make several; there are just more of them.
//
//  Three rules sit on top:
//
//  - At most `maxTabs` at once. The device may allow fewer: an older device
//    refuses any tab past the first, and then the run shares the tabs it has,
//    workers taking turns as before. That is never an error to the model.
//  - At most `sameSiteTabs` (2) of the run's tabs on one site. Many signed-in
//    sites take several sessions acting at once for a bot and challenge or lock
//    the account. A worker heading for a site that already has that many is
//    put in one of those tabs, behind its worker, rather than opening another.
//  - The first tab is the run's: watching, taking over and handing back act on
//    it, as they did when it was the only one. The others show in the user's
//    own window.
//
//  Only for a provider that gives each session a tab of its own on the user's
//  device (the relay). A hosted provider bills every session, and keeps one per run.

import type { BrowserAction, BrowserActionContext, BrowserActionOutcome } from '../../tools/browser-control.js';
import type { RemoteBrowserController, BrowserStep } from './controller.js';
import type { RemoteBrowserProvider } from './provider.js';

/** What a run's host uses of its browser controller. Both the plain and the tabbed one have it. */
export type RunBrowserControl = Pick<RemoteBrowserController,
  | 'controller' | 'features' | 'actorEnded'
  | 'onStepFor' | 'offStepFor' | 'onLiveViewFor' | 'offLiveViewFor' | 'onControlFor' | 'offControlFor'
  | 'onBusyFor' | 'offBusyFor' | 'setAllowanceFor'
  | 'startWatching' | 'stopWatching' | 'setCapture' | 'humanHolds' | 'takeOver' | 'frameSeen' | 'handBack' | 'input'
  | 'stopRun' | 'endRun' | 'dispose'>;

/** At most this many of one run's tabs on one site at once, unless told otherwise. */
export const SAME_SITE_TABS = 2;

export interface TabbedControllerOptions {
  provider: RemoteBrowserProvider;
  /** Most tabs at once. The device may allow fewer. */
  maxTabs: number;
  /** Most of the run's tabs on one site at once. */
  sameSiteTabs?: number;
  /** One tab's controller, with the provider it opens its one session from. */
  makeTab(provider: RemoteBrowserProvider): RemoteBrowserController;
}

type Listener<T> = (runKey: string, listener: T) => void;
type StepListener = Parameters<RemoteBrowserController['onStepFor']>[1];
type LiveListener = Parameters<RemoteBrowserController['onLiveViewFor']>[1];
type ControlListener = Parameters<RemoteBrowserController['onControlFor']>[1];
type BusyListener = Parameters<RemoteBrowserController['onBusyFor']>[1];

interface Tab {
  /** 1, 2, 3… in the order opened. Shown to the person. */
  n: number;
  ctl: RemoteBrowserController;
  /** Its session was opened at least once. */
  opened: boolean;
  /** How many times opening its session failed. */
  failures: number;
  /** The workers using it. */
  actors: Set<string>;
  /** The site its page is on, as last reported. */
  site?: string;
  /** Whether its browser is open, as its live view last said. */
  active: boolean;
}

/**
 * The site a page is on, for the same-site rule: the host's last two labels, or
 * three under a two-letter country code with a short second level (`co.uk`).
 * Close enough for a limit that protects accounts; it is not a security boundary.
 */
export function siteOf(raw: string): string | undefined {
  let host: string;
  try { host = new URL(raw).hostname.toLowerCase().replace(/\.$/, ''); } catch { return undefined; }
  if (!host) return undefined;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const [second, last] = labels.slice(-2) as [string, string];
  const keep = last.length === 2 && second.length <= 3 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

export class TabbedBrowserController implements RunBrowserControl {
  private readonly tabs: Tab[] = [];
  private readonly byActor = new Map<string, Tab>();
  /** The device gave no tab past the ones open: the run shares them from now on. */
  private capped = false;
  private readonly maxTabs: number;
  private readonly sameSite: number;
  private readonly steps = new Map<string, StepListener>();
  private readonly lives = new Map<string, LiveListener>();
  private readonly controls = new Map<string, ControlListener>();
  private readonly busies = new Map<string, BusyListener>();
  private readonly allowances = new Map<string, Parameters<RemoteBrowserController['setAllowanceFor']>[1]>();
  /** What each run's host was last told about its live view, so a tab closing doesn't say the browser did. */
  private readonly liveShown = new Map<string, boolean>();

  constructor(private readonly opts: TabbedControllerOptions) {
    this.maxTabs = Math.max(1, Math.floor(opts.maxTabs));
    this.sameSite = Math.max(1, opts.sameSiteTabs ?? SAME_SITE_TABS);
    this.newTab();
  }

  /** The first tab: the one watched, taken over and handed back. */
  private get primary(): RemoteBrowserController { return this.tabs[0]!.ctl; }

  get features(): RemoteBrowserController['features'] { return this.primary.features; }

  /** How many tabs the run has now. For tests and the run's log. */
  tabCount(): number { return this.tabs.length; }

  private newTab(): Tab {
    const n = (this.tabs.at(-1)?.n ?? 0) + 1;
    const real = this.opts.provider;
    const tab = { n, opened: false, failures: 0, actors: new Set<string>(), active: false } as Tab;
    // The tab's own view of the provider: the same sessions, with a note of whether
    // its own ever opened. A plain object, not a copy of the provider, whose state
    // (its session ids) must stay one.
    const provider: RemoteBrowserProvider = {
      name: real.name,
      isolatesSessions: real.isolatesSessions,
      ...(real.allocatesSessions !== undefined ? { allocatesSessions: real.allocatesSessions } : {}),
      ...(real.guardsScreenshots !== undefined ? { guardsScreenshots: real.guardsScreenshots } : {}),
      createSession: async (signal, hint) => {
        try {
          const session = await real.createSession(signal, hint);
          tab.opened = true;
          return session;
        } catch (e) {
          tab.failures += 1;
          throw e;
        }
      },
      endSession: (id) => real.endSession(id),
    };
    tab.ctl = this.opts.makeTab(provider);
    this.tabs.push(tab);
    for (const [key, l] of this.steps) this.wireStep(tab, key, l);
    for (const [key, l] of this.lives) this.wireLive(tab, key, l);
    for (const [key, l] of this.busies) tab.ctl.onBusyFor(key, l);
    for (const [key, a] of this.allowances) tab.ctl.setAllowanceFor(key, a);
    return tab;
  }

  private wireStep(tab: Tab, key: string, listener: StepListener): void {
    tab.ctl.onStepFor(key, (step: BrowserStep) => {
      if (step.url) tab.site = siteOf(step.url) ?? tab.site;
      // Numbered once the run has more than one, so the person can tell them apart.
      listener(this.tabs.length > 1 || tab.n > 1 ? { ...step, tab: tab.n } : step);
    });
  }

  private wireLive(tab: Tab, key: string, listener: LiveListener): void {
    tab.ctl.onLiveViewFor(key, (info) => {
      tab.active = info.active;
      // The run's browser is open while any of its tabs is.
      const active = this.tabs.some((t) => t.active);
      if (this.liveShown.get(key) === active && tab.n !== 1) return;
      this.liveShown.set(key, active);
      return listener(tab.n === 1 ? { ...info, active } : { ...info, active, liveViewUrl: undefined });
    });
  }

  private assign(actor: string, tab: Tab): Tab {
    const was = this.byActor.get(actor);
    if (was && was !== tab) {
      was.actors.delete(actor);
      // Its hold on the old tab ends, or that tab's other workers would wait on it for good.
      was.ctl.actorEnded(actor);
    }
    tab.actors.add(actor);
    this.byActor.set(actor, tab);
    return tab;
  }

  private leastBusy(among: Tab[] = this.tabs): Tab {
    return among.reduce((a, b) => (b.actors.size < a.actors.size ? b : a));
  }

  /** The tab this worker's action runs in. */
  private tabFor(actor: string, action: BrowserAction): Tab {
    let mine = this.byActor.get(actor);
    if (mine && !this.tabs.includes(mine)) mine = undefined;
    const site = action.kind === 'navigate' && action.url ? siteOf(action.url) : undefined;
    if (site && mine?.site !== site) {
      const there = this.tabs.filter((t) => t !== mine && t.site === site);
      // Enough of the run's tabs are on that site already: this worker joins one of
      // them, and takes its turn there.
      if (there.length >= this.sameSite) return this.assign(actor, this.leastBusy(there));
    }
    if (mine) return mine;
    // A tab nobody is using: the first, before anyone has, or one whose worker finished.
    const free = this.tabs.find((t) => t.actors.size === 0);
    if (free) return this.assign(actor, free);
    if (!this.capped && this.tabs.length < this.maxTabs) return this.assign(actor, this.newTab());
    return this.assign(actor, this.leastBusy());
  }

  /** The controller to hand to `Cascade.setBrowserController`. */
  get controller(): (action: BrowserAction, context: BrowserActionContext) => Promise<BrowserActionOutcome> {
    return async (action, context) => {
      if (!context.sessionId) return this.primary.controller(action, context);
      const actor = context.actorId || context.sessionId;
      let tab = this.tabFor(actor, action);
      for (;;) {
        const failed = tab.failures;
        const outcome = await tab.ctl.controller(action, context);
        if (outcome.url) tab.site = siteOf(outcome.url) ?? tab.site;
        // Only a tab past the first that never opened is given up on: the device gave
        // no more (an older one, or its limit). The action never ran, so it runs again
        // in a tab the run has.
        if (outcome.ok || tab.n === 1 || tab.opened || tab.failures === failed) return outcome;
        this.capped = true;
        this.drop(tab);
        tab = this.assign(actor, this.leastBusy());
      }
    };
  }

  private drop(tab: Tab): void {
    const at = this.tabs.indexOf(tab);
    if (at > 0) this.tabs.splice(at, 1);
    for (const actor of tab.actors) if (this.byActor.get(actor) === tab) this.byActor.delete(actor);
    tab.actors.clear();
    void tab.ctl.dispose().catch(() => {});
  }

  actorEnded(actorId: string): void {
    const tab = this.byActor.get(actorId);
    if (tab) { tab.actors.delete(actorId); this.byActor.delete(actorId); }
    for (const t of this.tabs) t.ctl.actorEnded(actorId);
  }

  onStepFor: Listener<StepListener> = (key, listener) => {
    this.steps.set(key, listener);
    for (const t of this.tabs) this.wireStep(t, key, listener);
  };
  offStepFor(key: string): void { this.steps.delete(key); for (const t of this.tabs) t.ctl.offStepFor(key); }

  onLiveViewFor: Listener<LiveListener> = (key, listener) => {
    this.lives.set(key, listener);
    for (const t of this.tabs) this.wireLive(t, key, listener);
  };
  offLiveViewFor(key: string): void { this.lives.delete(key); this.liveShown.delete(key); for (const t of this.tabs) t.ctl.offLiveViewFor(key); }

  // Who holds the page is the first tab's: it is the one a person takes over.
  onControlFor: Listener<ControlListener> = (key, listener) => { this.controls.set(key, listener); this.primary.onControlFor(key, listener); };
  offControlFor(key: string): void { this.controls.delete(key); this.primary.offControlFor(key); }

  onBusyFor: Listener<BusyListener> = (key, listener) => {
    this.busies.set(key, listener);
    for (const t of this.tabs) t.ctl.onBusyFor(key, listener);
  };
  offBusyFor(key: string): void { this.busies.delete(key); for (const t of this.tabs) t.ctl.offBusyFor(key); }

  setAllowanceFor(key: string, allowance: Parameters<RemoteBrowserController['setAllowanceFor']>[1]): void {
    this.allowances.set(key, allowance);
    for (const t of this.tabs) t.ctl.setAllowanceFor(key, allowance);
  }

  startWatching(...a: Parameters<RemoteBrowserController['startWatching']>) { return this.primary.startWatching(...a); }
  stopWatching(...a: Parameters<RemoteBrowserController['stopWatching']>) { return this.primary.stopWatching(...a); }
  setCapture(...a: Parameters<RemoteBrowserController['setCapture']>) { return this.primary.setCapture(...a); }
  humanHolds(...a: Parameters<RemoteBrowserController['humanHolds']>) { return this.primary.humanHolds(...a); }
  takeOver(...a: Parameters<RemoteBrowserController['takeOver']>) { return this.primary.takeOver(...a); }
  frameSeen(...a: Parameters<RemoteBrowserController['frameSeen']>) { return this.primary.frameSeen(...a); }
  handBack(...a: Parameters<RemoteBrowserController['handBack']>) { return this.primary.handBack(...a); }
  input(...a: Parameters<RemoteBrowserController['input']>) { return this.primary.input(...a); }

  /** The person's Stop: every tab. */
  stopRun(runId: string): void { for (const t of this.tabs) t.ctl.stopRun(runId); }
  async endRun(runId: string): Promise<void> { await Promise.all(this.tabs.map((t) => t.ctl.endRun(runId))); }
  async dispose(): Promise<void> { await Promise.all(this.tabs.map((t) => t.ctl.dispose())); }
}
