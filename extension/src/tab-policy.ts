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
//    address as typed. This is best effort and claimed as nothing more: the extension
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
  const rules: Rule[] = [
    // Every document not allowed below.
    { id: id++, priority: 1, action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType }, condition: { tabIds: [tabId], resourceTypes: DOCUMENTS } },
  ];
  for (const origin of consent.origins) {
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
  return rules;
}

const PAGE_END_TIMEOUT_MS = 5000;

export interface TabPolicyOptions {
  consent: Consent;
  /** Called once when the run must end for a reason the user should hear. */
  onStop(reason: string): void;
  /** Rule ids for this run start here. */
  firstRuleId: number;
}

/**
 * Opens the run's window and puts its rules in place before anything loads, then
 * attaches the debugger. A failure at any step takes down what came before it.
 */
export async function openRunTab(opts: TabPolicyOptions): Promise<LeasedBrowser & { tabId: number; windowId: number }> {
  if (opts.consent.privateOrigins.size > 0) {
    throw new Error("A run in your own Chrome can't use sites on your private network. Use the Cascade CLI or desktop app for those.");
  }
  const win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal' });
  const tabId = win?.tabs?.[0]?.id;
  const windowId = win?.id;
  if (tabId === undefined || windowId === undefined) throw new Error('Chrome did not open a window for the run.');
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

  const removeEverything = async (): Promise<void> => {
    if (attached) { attached = false; await chrome.debugger.detach({ tabId }).catch(() => {}); }
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds }).catch(() => {});
    await chrome.windows.remove(windowId).catch(() => {});
  };

  let own: CdpClient;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds, addRules: rules });
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    own = chromeTabCdp(tabId);
    await own.send('Page.enable');
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
  // first, then it's closed: closing it inside this event leaves the opener's
  // `window.open` waiting for ever (measured: the page's script stalls). What its first
  // request could carry, the consented page could already send by `fetch` to any public
  // site, and the agent never sees the page.
  const popupRule = opts.firstRuleId + 90;
  const onCreated = (tab: chrome.tabs.Tab): void => {
    if (tab.openerTabId !== tabId || tab.id === undefined) return;
    const popup = tab.id;
    closedPages.push(tab.pendingUrl ?? tab.url ?? '');
    void chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [popupRule],
      addRules: [{ id: popupRule, priority: 4, action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType }, condition: { tabIds: [popup], resourceTypes: EVERY_TYPE } }],
    }).catch(() => {}).then(() => chrome.tabs.remove(popup)).catch(() => {});
  };
  chrome.tabs.onCreated.addListener(onCreated);

  own.on((msg) => {
    if (msg.sessionId) return;
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
      chrome.tabs.onCreated.removeListener(onCreated);
      void removeEverything();
    },
  };

  return {
    tabId, windowId, tabWs: '', tabTargetId, enforcer,
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
