// ─────────────────────────────────────────────
//  Cascade extension — the run's own tab, and the rules around it
// ─────────────────────────────────────────────
//
//  A run gets a new window with one blank tab, in the user's own Chrome. Never a tab
//  the user already has open. Around that tab, on the device and out of the agent's
//  reach:
//
//  - Documents (the page and every frame in it, whatever started the navigation or
//    redirect) load only from the sites the user consented to. A tab-scoped
//    declarativeNetRequest block for every other document, with an allow per consented
//    site. These act on requests before they're sent, in every frame and process of
//    the tab.
//  - Requests from the tab to private-network addresses are blocked too, by name and
//    address as typed, and so are those of service and shared workers the consented
//    sites run (see `tabRules`). This is best effort and claimed as nothing more: the extension
//    can't resolve names, so a public name pointing at a private address isn't caught.
//    A run that needs a private site uses the CLI or the desktop app.
//  - A page this tab opens is closed. A dialog is dismissed.
//  - A download the tab starts ends the run. It is never cancelled or deleted: Chrome
//    can't tell the extension which download is the tab's, and the user's own must
//    never be touched. The file stays in Downloads for the user to keep or delete.
//  - The main frame showing a document from any other site ends the run.
//  - The debugger detaching, for any reason (the user pressing Cancel on Chrome's
//    banner, the tab closing, the worker restarting), ends the run, and nothing
//    reattaches without a new approval.

import type { CdpClient } from '../../src/browser/relay/cdp-client.js';
import type { LeasedBrowser } from '../../src/browser/relay/device.js';
import { type Consent, onConsentedSite } from '../../src/browser/relay/egress-rules.js';
import type { RequestEnforcer } from '../../src/browser/relay/request-enforcer.js';
import { settlesWithin } from '../../src/browser/relay/settles.js';
import { chromeTabCdp } from './chrome-cdp.js';

type Rule = chrome.declarativeNetRequest.Rule;
const DOCUMENTS = ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[];
const EVERY_TYPE = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
] as chrome.declarativeNetRequest.ResourceType[];

/**
 * Private-network destinations as a URL is written: loopback, RFC 1918, link-local,
 * CGNAT, unspecified, IPv6 loopback, unique-local, link-local and IPv4-mapped. Several
 * small patterns: Chrome refuses a rule whose regex compiles past 2 KB. `localhost` and
 * `*.local(host)` are matched by domain instead. Best effort, see the file header.
 */
const HOST_START = '^[a-z][a-z0-9+.-]*://(?:[^/@]*@)?';
const HOST_END = '\\.?(?::[0-9]+)?(?:[/?#]|$)';
export const PRIVATE_URL_PATTERNS: readonly string[] = [
  `${HOST_START}(?:127|10|0)(?:\\.[0-9]+){3}${HOST_END}`,
  `${HOST_START}(?:169\\.254|192\\.168)(?:\\.[0-9]+){2}${HOST_END}`,
  `${HOST_START}172\\.(?:1[6-9]|2[0-9]|3[01])(?:\\.[0-9]+){2}${HOST_END}`,
  `${HOST_START}100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(?:\\.[0-9]+){2}${HOST_END}`,
  `${HOST_START}\\[(?:::1?|f[cd][0-9a-f]*:[^\\]]*|fe[89ab][0-9a-f]*:[^\\]]*|::ffff:[^\\]]*)\\]`,
];
export const PRIVATE_DOMAINS: readonly string[] = ['localhost', 'local'];

/** The session rules for one run's tab. Ids from `firstId`, so runs never share one. */
export function tabRules(tabId: number, consent: Consent, firstId: number): Rule[] {
  let id = firstId;
  const rules: Rule[] = consent.anyPublic ? [] : [
    // Every document not allowed below. With any public site allowed there is no such
    // block: only the private-network ones further down.
    { id: id++, priority: 1, action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType }, condition: { tabIds: [tabId], resourceTypes: DOCUMENTS } },
  ];
  for (const origin of consent.anyPublic ? [] : consent.origins) {
    // `|https://example.com/` matches that origin's URLs and nothing whose host only
    // starts with it: the slash ends the host.
    rules.push({ id: id++, priority: 2, action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType }, condition: { tabIds: [tabId], resourceTypes: DOCUMENTS, urlFilter: `|${origin}/` } });
  }
  // Above the allows: a consented origin never makes a private address reachable here.
  const block = { type: 'block' as chrome.declarativeNetRequest.RuleActionType };
  rules.push({ id: id++, priority: 3, action: block, condition: { tabIds: [tabId], resourceTypes: EVERY_TYPE, requestDomains: [...PRIVATE_DOMAINS] } });
  for (const regexFilter of PRIVATE_URL_PATTERNS) {
    rules.push({ id: id++, priority: 3, action: block, condition: { tabIds: [tabId], resourceTypes: EVERY_TYPE, regexFilter, isUrlFilterCaseSensitive: false } });
  }
  rules.push(...workerRules(consentedHosts(consent), id));
  return rules;
}

/** The hosts of the consented origins, as `initiatorDomains` writes them. */
export function consentedHosts(consent: Consent): string[] {
  return [...new Set([...consent.origins].map((o) => new URL(o).hostname.replace(/^\[|\]$/g, '')))];
}

/**
 * Workers. A service or shared worker a consented page starts sends its requests
 * with no tab (TAB_ID_NONE), so no tab rule sees them, and it could reach a private
 * address the tab itself can't. These match requests from no tab whose initiator is
 * one of `hosts`: as close to "the run's workers" as Chrome lets a rule get. The
 * cost: the user's own workers on those same sites can't reach private-network
 * addresses either. Nothing else of theirs changes, and public destinations are
 * untouched.
 */
export function workerRules(hosts: readonly string[], firstId: number): Rule[] {
  if (!hosts.length) return [];
  let id = firstId;
  const block = { type: 'block' as chrome.declarativeNetRequest.RuleActionType };
  const workers = { tabIds: [TAB_ID_NONE], initiatorDomains: [...hosts], resourceTypes: EVERY_TYPE };
  const rules: Rule[] = [{ id: id++, priority: 3, action: block, condition: { ...workers, requestDomains: [...PRIVATE_DOMAINS] } }];
  for (const regexFilter of PRIVATE_URL_PATTERNS) {
    rules.push({ id: id++, priority: 3, action: block, condition: { ...workers, regexFilter, isUrlFilterCaseSensitive: false } });
  }
  return rules;
}

/** `chrome.tabs.TAB_ID_NONE`: a request from no tab, such as a service or shared worker's. */
const TAB_ID_NONE = -1;

/**
 * Rule ids below this are the extension's own, kept across runs and restarts of its
 * worker; a run's rules are numbered from here up (see background.ts).
 */
export const RUN_RULE_IDS_FROM = 1000;
/** Where the lasting worker rules live: ids 1 to 1 + PRIVATE_URL_PATTERNS.length. */
const LASTING_WORKER_RULES_FROM = 1;

let lasting: Promise<void> = Promise.resolve();
/**
 * A service worker outlives the tab that started it, and the run's own rules go when
 * the run ends: a worker a consented page left running could then reach private
 * addresses. So the worker rules for every site a run has been allowed stay until
 * Chrome itself restarts, which clears session rules and session storage together.
 * Serialized: two runs starting at once each add their sites, and neither's is lost.
 */
export function keepWorkersOffPrivateNetwork(hosts: readonly string[]): Promise<void> {
  const next = lasting.then(async () => {
    const { workerHosts = [] } = await chrome.storage.session.get('workerHosts') as { workerHosts?: string[] };
    const all = [...new Set([...workerHosts, ...hosts])];
    const rules = workerRules(all, LASTING_WORKER_RULES_FROM);
    if (!rules.length) return;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id), addRules: rules });
    await chrome.storage.session.set({ workerHosts: all });
  });
  lasting = next.catch(() => {});
  return next;
}

const PAGE_END_TIMEOUT_MS = 5000;

export interface TabPolicyOptions {
  consent: Consent;
  /** Called once when the run must end for a reason the user should hear. */
  onStop(reason: string): void;
  /** Rule ids for this run start here. */
  firstRuleId: number;
  /** A private (incognito) window: signed out of everything, its cookies gone when it closes. */
  incognito?: boolean;
  /**
   * The run's window, for its second tab and later ones: the tab is made in a window
   * of its own, its rules and debugger put in place there, and only then moved in. So
   * it never appears in the run's window as a new tab, which the run's other tabs
   * would take for a popup and close.
   */
  joinWindow?: number;
}

/** The run tabs in each window: a window goes when its last one does. */
const runTabsIn = new Map<number, Set<number>>();
const noteRunTab = (windowId: number, tabId: number, add: boolean): number => {
  const tabs = runTabsIn.get(windowId) ?? new Set<number>();
  if (add) tabs.add(tabId); else tabs.delete(tabId);
  if (tabs.size) runTabsIn.set(windowId, tabs); else runTabsIn.delete(windowId);
  return tabs.size;
};

// ── WebRTC ──────────────────────────────────
//
// WebRTC sends its own packets, which no declarativeNetRequest rule sees: a page could
// reach a private address over a STUN or TURN server it names. Two layers, both only
// while a run is open:
//
// - Chrome-wide, WebRTC sends no UDP except through a proxy (there is none), so STUN
//   and TURN over UDP go nowhere. The user's other tabs feel it too: a call there falls
//   back to TCP relays, or fails, until the run ends. Chosen by Varun.
// - In the run's tab, RTCPeerConnection is taken away, which leaves TURN over TCP (the
//   setting above doesn't stop it) with no way in from the page or the agent. Best
//   effort: a cross-origin frame in a process of its own starts with its own copy.

const WEBRTC_UDP_OFF = 'disable_non_proxied_udp';
let webRtcHolds = 0;
let webRtcChain: Promise<unknown> = Promise.resolve();
const serially = <T>(f: () => Promise<T>): Promise<T> => {
  const next = webRtcChain.then(f);
  webRtcChain = next.catch(() => {});
  return next;
};

/** Turns WebRTC's direct UDP off for as long as any run holds it; the returned call lets go. */
export async function holdWebRtcUdpOff(): Promise<() => Promise<void>> {
  await serially(async () => {
    const policy = chrome.privacy.network.webRTCIPHandlingPolicy;
    if (webRtcHolds === 0) await policy.set({ value: WEBRTC_UDP_OFF as chrome.privacy.IPHandlingPolicy });
    const now = await policy.get({});
    if (now.value !== WEBRTC_UDP_OFF) {
      if (webRtcHolds === 0) await policy.clear({}).catch(() => {});
      throw new Error("Chrome's WebRTC setting is managed by something else here, so Cascade can't keep a run's WebRTC off your private network. Use the Cascade CLI for this run.");
    }
    webRtcHolds += 1;
  });
  let released = false;
  return () => serially(async () => {
    if (released) return;
    released = true;
    webRtcHolds -= 1;
    if (webRtcHolds === 0) await chrome.privacy.network.webRTCIPHandlingPolicy.clear({}).catch(() => {});
  });
}

/** After the extension's worker restarts, no run is open: the setting goes back to the user's. */
export async function releaseWebRtcAfterRestart(): Promise<void> {
  await serially(async () => {
    webRtcHolds = 0;
    await chrome.privacy.network.webRTCIPHandlingPolicy.clear({}).catch(() => {});
  });
}

/** Run in every document of the run's tab before its own scripts. */
export const NO_WEBRTC_SCRIPT = `(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceTransport']) {
    try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
})();`;

/**
 * Opens the run's window and puts its rules in place before anything loads, then
 * attaches the debugger. A failure at any step takes down what came before it.
 */
export async function openRunTab(opts: TabPolicyOptions): Promise<LeasedBrowser & { tabId: number; windowId: number }> {
  if (opts.consent.privateOrigins.size > 0) {
    throw new Error("A run in your own Chrome can't use sites on your private network. Use the Cascade CLI or desktop app for those.");
  }
  const win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal', ...(opts.incognito ? { incognito: true } : {}) });
  const tabId = win?.tabs?.[0]?.id;
  // The window it is in: its own until it joins the run's.
  let windowId = win?.id;
  if (tabId === undefined || windowId === undefined) throw new Error('Chrome did not open a window for the run.');
  noteRunTab(windowId, tabId, true);
  const rules = tabRules(tabId, opts.consent, opts.firstRuleId);
  // The run's rules, and the one its pop-ups get.
  const ruleIds = [...rules.map((r) => r.id), opts.firstRuleId + 90];
  let attached = false;
  let ended = false;
  const foreign: (() => void)[] = [];
  const lost: (() => void)[] = [];
  const egressDown: (() => void)[] = [];
  const decisions: RequestEnforcer['decisions'] = [];
  const closedPages: string[] = [];
  const dismissedDialogs: string[] = [];

  let releaseWebRtc: (() => Promise<void>) | undefined;
  /** Popups the run opened that aren't closed yet: their block rule must outlive them. */
  const openPopups = new Set<number>();
  const closeOpenPopups = (): Promise<unknown> => Promise.all([...openPopups].map((id) => chrome.tabs.remove(id).catch(() => {})));
  let stopWatchingPopups: () => void = () => {};
  const removeEverything = async (): Promise<void> => {
    if (attached) { attached = false; await chrome.debugger.detach({ tabId }).catch(() => {}); }
    // Every page the run has goes before any protection does: popups first (one in a
    // window of its own outlives the run's window), then the run's window, then any
    // popup opened in the meantime. Only then the rules, and WebRTC back to the user.
    await closeOpenPopups();
    // This tab, and its window once no other tab of a run is left in it.
    const left = noteRunTab(windowId!, tabId, false);
    if (left) await chrome.tabs.remove(tabId).catch(() => {});
    else await chrome.windows.remove(windowId!).catch(() => {});
    stopWatchingPopups();
    await closeOpenPopups();
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds }).catch(() => {});
    await releaseWebRtc?.();
  };

  let own: CdpClient;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules: rules });
    // Before anything loads: what this run's sites start may outlive the run.
    await keepWorkersOffPrivateNetwork(consentedHosts(opts.consent));
    releaseWebRtc = await holdWebRtcUdpOff();
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    own = chromeTabCdp(tabId);
    await own.send('Page.enable');
    // Any public site: the sites aren't known ahead, so each one the run loads a page
    // from joins the lasting worker rules as its request goes out, before its scripts
    // can start a worker.
    if (opts.consent.anyPublic) await own.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    await own.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_WEBRTC_SCRIPT, runImmediately: true });
    await own.send('Runtime.evaluate', { expression: NO_WEBRTC_SCRIPT });
    // Policed from here on: now it may join the run's window. Its own empty window
    // closes as it leaves.
    if (opts.joinWindow !== undefined && opts.joinWindow !== windowId) {
      await chrome.tabs.move(tabId, { windowId: opts.joinWindow, index: -1 });
      noteRunTab(windowId, tabId, false);
      windowId = opts.joinWindow;
      noteRunTab(windowId, tabId, true);
    }
  } catch (e) {
    await removeEverything();
    throw e;
  }

  const stop = (reason: string): void => {
    if (ended) return;
    ended = true;
    opts.onStop(reason);
  };

  // A page this tab opens is the run's, and runs nowhere. Its requests are blocked
  // first, then it's closed. What its first request could carry, the consented page
  // could already send by `fetch` to any public site, and the agent never sees the page.
  //
  // Closed only once Chrome has finished making it. `onCreated` fires while the
  // opener's `window.open` is still waiting on the browser for its answer, and a tab
  // removed before that answer goes leaves the opener's script stalled for good
  // (measured: with the CPU busy, 5 runs in 8 still hung after 30 s when the close
  // followed only the rules update). The popup's first `onUpdated` comes after it is
  // attached; the timer is a backstop, and the block rule holds meanwhile.
  const popupRule = opts.firstRuleId + 90;
  const POPUP_SETTLE_MS = 3000;
  // One rule for every popup not yet closed: a second popup must not take the first's
  // block away while the first is still open. Each update carries the whole set and
  // goes at once: Chrome applies an extension's calls in the order they're made, so
  // the last one has every open popup in it, and nothing waits behind an earlier call
  // while a new popup's first request is on its way (measured: queueing them let the
  // second of two popups through).
  const syncPopupRule = (): Promise<unknown> => chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [popupRule],
    addRules: openPopups.size
      ? [{ id: popupRule, priority: 4, action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType }, condition: { tabIds: [...openPopups], resourceTypes: EVERY_TYPE } }]
      : [],
  }).catch(() => {});
  // Which new tabs are the run's: any in the run's own window (Chrome puts a page's
  // popups there as tabs), any the run's tab opened, and any one of its popups opened.
  // The opener alone isn't enough: with several opened at once, Chrome names each one's
  // opener as the tab before it (measured), so only the first pointed at the run's tab.
  const runPopups = new Set<number>();
  const onCreated = (tab: chrome.tabs.Tab): void => {
    if (tab.id === undefined || tab.id === tabId) return;
    const opener = tab.openerTabId;
    const ours = tab.windowId === windowId || opener === tabId || (opener !== undefined && runPopups.has(opener));
    if (!ours) return;
    const popup = tab.id;
    runPopups.add(popup);
    closedPages.push(tab.pendingUrl ?? tab.url ?? '');
    const settled = new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); };
      const onUpdated = (id: number): void => { if (id === popup) done(); };
      const timer = setTimeout(done, POPUP_SETTLE_MS);
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    openPopups.add(popup);
    const blocked = syncPopupRule();
    // Its block goes only once the tab has: until then it stays covered.
    void Promise.all([blocked, settled])
      .then(() => chrome.tabs.remove(popup))
      .catch(() => {})
      .then(() => { openPopups.delete(popup); return syncPopupRule(); });
  };
  chrome.tabs.onCreated.addListener(onCreated);
  stopWatchingPopups = () => chrome.tabs.onCreated.removeListener(onCreated);

  own.on((msg) => {
    if (msg.sessionId) return;
    if (msg.method === 'Network.requestWillBeSent' && opts.consent.anyPublic) {
      const host = documentHost(msg.params);
      if (host) void keepWorkersOffPrivateNetwork([host]).catch(() => {});
      return;
    }
    if (msg.method === 'Page.frameNavigated') {
      const { frame } = (msg.params ?? {}) as { frame?: { parentId?: string; url?: string; unreachableUrl?: string } };
      // Only the main frame; a blocked navigation's error page is the rules working.
      if (!frame || frame.parentId || frame.unreachableUrl || frame.url === 'about:blank' || onConsentedSite(frame.url ?? '', opts.consent)) return;
      for (const l of foreign) l();
    } else if (msg.method === 'Page.downloadWillBegin') {
      stop('A page in the run started a download. The run stopped; the file is in your Downloads to keep or delete.');
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      dismissedDialogs.push(String((msg.params as { type?: unknown } | undefined)?.type ?? 'dialog'));
      void own.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    }
  });
  own.onClose(() => {
    // The debugger is gone: whatever the reason, nothing is policed any more.
    attached = false;
    for (const l of lost) l();
    for (const l of egressDown) l();
  });

  const targets = await chrome.debugger.getTargets();
  const tabTargetId = targets.find((t) => t.tabId === tabId && t.type === 'page')?.id;
  if (!tabTargetId) { await removeEverything(); throw new Error('Chrome did not report the run tab as a target.'); }

  const enforcer: RequestEnforcer = {
    decisions, closedPages, children: [], dismissedDialogs,
    async checkTabBeforeLease() {
      const tree = await own.send('Page.getFrameTree').catch(() => null) as { frameTree?: { frame?: { url?: string }; childFrames?: unknown[] } } | null;
      const url = tree?.frameTree?.frame?.url;
      if (url !== 'about:blank' || tree?.frameTree?.childFrames?.length) return { ok: false, reason: 'the run tab is not blank' };
      return { ok: true };
    },
    // A tab opened for this run has no history to clear.
    clearForeignHistory: async () => true,
    onForeignDocument: (l) => { foreign.push(l); },
    onPolicyLost: (l) => { lost.push(l); },
    async endPageActivity(mode) {
      if (mode === 'blank') return settlesWithin(own.send('Page.navigate', { url: 'about:blank' }), PAGE_END_TIMEOUT_MS);
      return settlesWithin(chrome.tabs.remove(tabId), PAGE_END_TIMEOUT_MS);
    },
    close() {
      // The popup listener stays until the run's window has gone: see removeEverything.
      void removeEverything();
    },
  };

  return {
    tabId, windowId: windowId!, tabWs: '', tabTargetId, enforcer,
    connectTab: async () => chromeTabCdp(tabId),
    // The run's window is the run's: it closes with it.
    pageEnd: 'close',
    onEgressDown: (fn) => { egressDown.push(fn); },
    async close() {
      ended = true;
      enforcer.close();
    },
  };
}

/** The host a page or frame is about to be loaded from, from a `Network.requestWillBeSent`. */
export function documentHost(params: unknown): string | null {
  const p = (params ?? {}) as { type?: unknown; request?: { url?: unknown } };
  if (p.type !== 'Document' || typeof p.request?.url !== 'string') return null;
  try {
    const u = new URL(p.request.url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^\[|\]$/g, '') : null;
  } catch { return null; }
}
