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

const INTERCEPT_ALL = { patterns: [{ urlPattern: '*', requestStage: 'Request' }] };
const AUTO_ATTACH_PAUSED = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

export interface RequestDecision { allowed: boolean; url: string; resourceType: string; reason: string; where: string }

export interface RequestEnforcer {
  readonly decisions: readonly RequestDecision[];
  /** New pages the guard closed. */
  readonly closedPages: readonly string[];
  /** Dialogs the device dismissed, by type. */
  readonly dismissedDialogs: readonly string[];
  /**
   * Refuses a lease on a tab showing a page or holding a frame without consent:
   * what it already held never went through the request policy.
   */
  checkTabBeforeLease(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Ends what the agent left running, since detaching doesn't: script timers and
   * workers keep going. `close` closes the tab; `blank` keeps it open on about:blank.
   */
  endPageActivity(mode: PageEndMode): Promise<void>;
  /** Stops policing. Call only after endPageActivity. */
  close(): void;
}

/** CLI: `close`, as the tab is the run's. Desktop and extension: Varun's decision. */
export type PageEndMode = 'close' | 'blank';

async function policeChild(client: CdpClient, sessionId: string, type: string): Promise<boolean> {
  try { await client.send('Fetch.enable', INTERCEPT_ALL, sessionId); } catch {
    // A dedicated worker has no interception of its own: its requests go through
    // its parent frame, which is already policed. Nothing else gets this pass.
    if (type !== 'worker') return false;
  }
  await client.send('Target.setAutoAttach', AUTO_ATTACH_PAUSED, sessionId).catch(() => {});
  await client.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  return true;
}

export async function startRequestPolicy(opts: {
  browserWs: string; tabWs: string; tabTargetId: string; consent: Consent;
}): Promise<RequestEnforcer> {
  const { consent, tabTargetId } = opts;
  const decisions: RequestDecision[] = [];
  const closedPages: string[] = [];
  const dismissedDialogs: string[] = [];
  const tab = await connectCdp(opts.tabWs);
  const browser = await connectCdp(opts.browserWs);

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
    else if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params as { sessionId: string; targetInfo: { type: string; targetId: string } };
      void policeChild(tab, sessionId, targetInfo.type).then((policed) => {
        if (!policed) void browser.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
      });
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      // Dismissed by the device, never shown to the agent: a dialog would otherwise
      // block its command, and it can't accept one the user hasn't seen.
      dismissedDialogs.push(String(msg.params?.type));
      void tab.send('Page.handleJavaScriptDialog', { accept: false }, msg.sessionId).catch(() => {});
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
      if (!await policeChild(browser, sessionId, targetInfo.type)) {
        await browser.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
      }
    })();
  });
  // Browser-wide interception as a measured backstop: without it, some pop-ups in a
  // burst send a first request before they're paused. Why it helps isn't pinned down,
  // so the burst test stays a regression gate.
  await browser.send('Fetch.enable', INTERCEPT_ALL);
  await browser.send('Target.setAutoAttach', AUTO_ATTACH_PAUSED);

  return {
    decisions, closedPages, dismissedDialogs,
    async checkTabBeforeLease() {
      const info = await tab.send('Target.getTargetInfo') as { targetInfo?: { url?: string } };
      const url = info.targetInfo?.url ?? '';
      if (!onConsentedSite(url, consent)) return { ok: false, reason: 'the tab is on a site without consent' };
      const tree = await tab.send('Page.getFrameTree').catch(() => null) as { frameTree?: FrameNode } | null;
      if (!tree?.frameTree) return { ok: false, reason: 'frame tree unavailable' };
      const walk = (n: FrameNode): boolean => onConsentedSite(n.frame?.url ?? '', consent) && (n.childFrames ?? []).every(walk);
      return walk(tree.frameTree) ? { ok: true } : { ok: false, reason: 'a frame on a site without consent' };
    },
    async endPageActivity(mode) {
      // Workers outlive a navigation, so they go first, whichever the mode.
      const { targetInfos } = await browser.send('Target.getTargets') as { targetInfos?: { targetId: string; type: string }[] };
      const workers = (targetInfos ?? []).filter((t) => t.type === 'service_worker' || t.type === 'shared_worker');
      await Promise.all(workers.map((t) => browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {})));
      if (mode === 'close') await browser.send('Target.closeTarget', { targetId: tabTargetId }).catch(() => {});
      else await tab.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
    },
    close() { tab.close(); browser.close(); },
  };
}

interface FrameNode { frame?: { url?: string }; childFrames?: FrameNode[] }
