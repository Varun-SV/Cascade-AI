// ─────────────────────────────────────────────
//  Cascade AI — Stopping requests before they leave the browser
// ─────────────────────────────────────────────
//
//  The policy's own CDP sessions, which the agent can neither see nor disable. A
//  blocked request is failed before it is sent, whatever started it: an agent
//  command, a click, a form, page script or a redirect hop. Out-of-process frames
//  and workers are their own targets, so each is attached paused, policed, and only
//  then resumed. A target the policy can't police never runs. New pages are closed.

import { type CdpClient, type CdpMessage, connectCdp } from './cdp-client.js';
import { type Consent, onConsentedSite, requestVerdict } from './egress-rules.js';
import { type LaunchedBrowser, claimFreshBrowser, isBrowserOwnUi } from './launch.js';

const INTERCEPT_ALL = { patterns: [{ urlPattern: '*', requestStage: 'Request' }] };
const PAGE_END_TIMEOUT_MS = 3000;
const AUTO_ATTACH_PAUSED = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

export interface RequestDecision { allowed: boolean; url: string; resourceType: string; reason: string; where: string }

export interface RequestEnforcer {
  readonly decisions: readonly RequestDecision[];
  /** New pages the guard closed. */
  readonly closedPages: readonly string[];
  /** Child targets, and how each was policed. */
  readonly children: readonly { type: string; coverage: ChildCoverage }[];
  /** Dialogs the device dismissed, by type. */
  readonly dismissedDialogs: readonly string[];
  /**
   * Refuses a lease on a tab showing a page or holding a frame without consent:
   * what it already held never went through the request policy.
   */
  checkTabBeforeLease(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Removes the tab's history if any entry is on a site without consent, because the
   * back-forward cache can restore one with no request for the policy to stop. False
   * means such an entry may remain. This costs the user their back history for the tab.
   */
  clearForeignHistory(): Promise<boolean>;
  /** Called when the tab's main frame shows a document without consent, however it got there. */
  onForeignDocument(listener: () => void): void;
  /**
   * Ends what the agent left running, since detaching doesn't: script timers and
   * workers keep going. `close` closes the tab; `blank` keeps it open on about:blank.
   * Always finishes in bounded time. False means the browser never confirmed it.
   */
  endPageActivity(mode: PageEndMode): Promise<boolean>;
  /** Stops policing. Call only after endPageActivity. */
  close(): void;
}

/** CLI: `close`, as the tab is the run's. Desktop and extension: Varun's decision. */
export type PageEndMode = 'close' | 'blank';

/** How a child target's requests are policed, or null if they can't be. */
export type ChildCoverage = 'own-interception' | 'parent-interception' | null;

/**
 * Puts the policy on one attached, paused target, and resumes it only if every step
 * succeeded. On null it stays paused for the caller to close: a target the policy
 * can't police never runs.
 *
 * Only a dedicated worker may lack interception of its own. Its requests go through
 * the frame that started it, which is policed, because children only attach through
 * policed sessions. Tests assert the block in the policy's own log for this case.
 */
export async function policeChild(client: Pick<CdpClient, 'send'>, sessionId: string, type: string): Promise<ChildCoverage> {
  let coverage: ChildCoverage = 'own-interception';
  try { await client.send('Fetch.enable', INTERCEPT_ALL, sessionId); } catch {
    if (type !== 'worker') return null;
    coverage = 'parent-interception';
  }
  try {
    await client.send('Target.setAutoAttach', AUTO_ATTACH_PAUSED, sessionId);
    await client.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  } catch { return null; }
  return coverage;
}

/** Whether a CDP call succeeded in time. A page spinning in a loop never answers. */
export function settlesWithin(call: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const finish = (ok: boolean): void => { clearTimeout(timer); resolve(ok); };
    call.then(() => finish(true), () => finish(false));
  });
}

/**
 * Whether a history reply is well formed and every entry may be kept: at least the
 * current entry, an index that points at one, and a URL on each. Anything else isn't safe.
 */
export function historyIsSafe(reply: unknown, consent: Consent): boolean {
  const h = reply as { currentIndex?: unknown; entries?: unknown } | null | undefined;
  if (!h || !Array.isArray(h.entries) || h.entries.length === 0) return false;
  if (!Number.isInteger(h.currentIndex) || (h.currentIndex as number) < 0 || (h.currentIndex as number) >= h.entries.length) return false;
  return (h.entries as { url?: unknown }[]).every((e) => typeof e?.url === 'string' && e.url !== '' && onConsentedSite(e.url, consent));
}

/**
 * The page step of a revoke. Nothing the page or the browser does can hold it up, and
 * a failure at one step doesn't skip the next: if the workers can't be listed, the
 * tab still ends. A page that won't leave is closed rather than left running.
 */
export async function endPageActivity(
  tab: Pick<CdpClient, 'send'>, browser: Pick<CdpClient, 'send'>, tabTargetId: string, mode: PageEndMode,
  ownedWorkers: ReadonlySet<string>, timeoutMs = PAGE_END_TIMEOUT_MS,
): Promise<boolean> {
  // Workers outlive a navigation, so they go first, whichever the mode.
  let targets: { targetId: string; type: string }[] = [];
  await settlesWithin(browser.send('Target.getTargets').then((r) => {
    targets = (r as { targetInfos?: typeof targets }).targetInfos ?? [];
  }), timeoutMs);
  // Only workers this lease saw start. Anything else in the browser isn't its to close.
  const workers = targets.filter((t) => (t.type === 'service_worker' || t.type === 'shared_worker') && ownedWorkers.has(t.targetId));
  await Promise.all(workers.map((t) => settlesWithin(browser.send('Target.closeTarget', { targetId: t.targetId }), timeoutMs)));
  if (mode === 'blank' && await settlesWithin(tab.send('Page.navigate', { url: 'about:blank' }), timeoutMs)) return true;
  return settlesWithin(browser.send('Target.closeTarget', { targetId: tabTargetId }), timeoutMs);
}

export async function startRequestPolicy(opts: {
  browser: LaunchedBrowser; consent: Consent;
}): Promise<RequestEnforcer> {
  const { consent } = opts;
  const { browserWs, tabWs, tabTargetId } = opts.browser;
  // This policy is browser-wide: it closes new pages and intercepts every request, and
  // whatever is already running would be judged under this lease's consent. So it needs
  // a freshly launched browser with nothing in it but the leased tab, used for one lease.
  // Desktop and the extension share a browser with the user and need their own scoped enforcer.
  const notDedicated = 'The request policy needs a dedicated browser with only the leased tab open.';
  if (!claimFreshBrowser(opts.browser)) throw new Error(`${notDedicated} This one is not freshly launched by this run.`);
  const decisions: RequestDecision[] = [];
  const closedPages: string[] = [];
  const dismissedDialogs: string[] = [];
  const children: { type: string; coverage: ChildCoverage }[] = [];
  const foreignListeners: (() => void)[] = [];
  let foreignDocument = false;
  const tab = await connectCdp(tabWs);
  const browser = await connectCdp(browserWs);

  const before = (((await browser.send('Target.getTargets')) as { targetInfos?: { targetId: string; type: string; url: string }[] }).targetInfos ?? [])
    .filter((t) => !isBrowserOwnUi(t));
  // Not only pages: a worker already running isn't this lease's, and a revoke wouldn't stop it.
  if (before.length !== 1 || before[0]!.targetId !== tabTargetId) {
    tab.close(); browser.close();
    throw new Error(notDedicated);
  }
  const ownedWorkers = new Set<string>();
  const noteWorker = (t: { targetId: string; type: string }): void => {
    if ((t.type === 'service_worker' || t.type === 'shared_worker')) ownedWorkers.add(t.targetId);
  };

  const decide = async (client: CdpClient, msg: CdpMessage, where: string): Promise<void> => {
    const p = msg.params as { requestId: string; request: { url: string }; resourceType: string };
    const v = requestVerdict(p.request.url, p.resourceType, consent);
    decisions.push({ allowed: v.allow, url: p.request.url, resourceType: p.resourceType, reason: v.allow ? '' : v.reason, where });
    try {
      if (v.allow) await client.send('Fetch.continueRequest', { requestId: p.requestId }, msg.sessionId);
      else await client.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, msg.sessionId);
    } catch { /* the request is already gone */ }
  };

  tab.on((msg) => {
    if (msg.method === 'Fetch.requestPaused') void decide(tab, msg, msg.sessionId ? 'child' : 'tab');
    else if (msg.method === 'Page.frameNavigated') {
      // The backstop for documents no request brought here. Only the main frame: a
      // restore replaces the whole page, and a failed navigation's error page is ours.
      const { frame } = msg.params as { frame: { parentId?: string; url?: string; unreachableUrl?: string } };
      if (frame.parentId || frame.unreachableUrl || onConsentedSite(frame.url ?? '', consent)) return;
      foreignDocument = true;
      for (const l of foreignListeners) l();
    } else if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params as { sessionId: string; targetInfo: { type: string; targetId: string } };
      noteWorker(targetInfo);
      void policeChild(tab, sessionId, targetInfo.type).then((coverage) => {
        children.push({ type: targetInfo.type, coverage });
        if (!coverage) void browser.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
      });
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      // Answered by the device, never shown to the agent: a dialog would otherwise block
      // its command, and it can't accept one the user hasn't seen. `beforeunload` is the
      // exception, because refusing it would keep the page, and any timer on it, alive
      // through revoke's own navigation.
      const type = String(msg.params?.type);
      dismissedDialogs.push(type);
      void tab.send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }, msg.sessionId).catch(() => {});
    }
  });
  await tab.send('Page.enable');
  await tab.send('Fetch.enable', INTERCEPT_ALL);
  await tab.send('Target.setAutoAttach', AUTO_ATTACH_PAUSED);

  const denyAll = new Set<string>();
  browser.on((msg) => {
    if (msg.method === 'Fetch.requestPaused') {
      const p = msg.params as { requestId: string };
      if (msg.sessionId && denyAll.has(msg.sessionId)) {
        void browser.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, msg.sessionId).catch(() => {});
      } else void decide(browser, msg, msg.sessionId ? 'worker' : 'browser');
      return;
    }
    if (msg.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = msg.params as { sessionId: string; targetInfo: { type: string; targetId: string; url: string } };
    noteWorker(targetInfo);
    void (async () => {
      if (targetInfo.targetId === tabTargetId) {
        // The leased tab has its own policy session.
        await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        return;
      }
      if (targetInfo.type === 'page') {
        // Deny everything first, then resume and close: closing it while paused
        // would leave the opener's window.open waiting.
        closedPages.push(targetInfo.url || '(not navigated)');
        denyAll.add(sessionId);
        await browser.send('Fetch.enable', INTERCEPT_ALL, sessionId).catch(() => {});
        await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        await browser.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
        return;
      }
      const coverage = await policeChild(browser, sessionId, targetInfo.type);
      children.push({ type: targetInfo.type, coverage });
      if (!coverage) await browser.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
    })();
  });
  // Browser-wide interception as a measured backstop: without it, some pop-ups in a
  // burst send a first request before they're paused. Why it helps isn't pinned down,
  // so the burst test stays a regression gate.
  await browser.send('Fetch.enable', INTERCEPT_ALL);
  await browser.send('Target.setAutoAttach', AUTO_ATTACH_PAUSED);
  // Only now: with no policy on, the proxy lets nothing out.
  opts.browser.openEgress();

  return {
    decisions, closedPages, children, dismissedDialogs,
    async checkTabBeforeLease() {
      const info = await tab.send('Target.getTargetInfo') as { targetInfo?: { url?: string } };
      const url = info.targetInfo?.url ?? '';
      if (!onConsentedSite(url, consent)) return { ok: false, reason: 'the tab is on a site without consent' };
      const tree = await tab.send('Page.getFrameTree').catch(() => null) as { frameTree?: FrameNode } | null;
      if (!tree?.frameTree) return { ok: false, reason: 'frame tree unavailable' };
      const walk = (n: FrameNode): boolean => onConsentedSite(n.frame?.url ?? '', consent) && (n.childFrames ?? []).every(walk);
      return walk(tree.frameTree) ? { ok: true } : { ok: false, reason: 'a frame on a site without consent' };
    },
    async clearForeignHistory() {
      const allConsented = async (): Promise<boolean> => historyIsSafe(await tab.send('Page.getNavigationHistory'), consent);
      try {
        if (await allConsented()) return true;
        await tab.send('Page.resetNavigationHistory');
        return await allConsented();
      } catch { return false; }
    },
    onForeignDocument(listener) {
      foreignListeners.push(listener);
      if (foreignDocument) listener();
    },
    endPageActivity: (mode) => endPageActivity(tab, browser, tabTargetId, mode, ownedWorkers),
    close() { tab.close(); browser.close(); },
  };
}

interface FrameNode { frame?: { url?: string }; childFrames?: FrameNode[] }
