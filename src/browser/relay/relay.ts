// ─────────────────────────────────────────────
//  Cascade AI — The device relay
// ─────────────────────────────────────────────
//
//  One agent connection to one leased tab. Presents a browser-level CDP endpoint,
//  which is what Playwright expects, over the tab's session. Every command goes
//  through the policy and the fence; every event and URL-bearing reply goes through
//  the filter. The agent's connection dropping, a bad frame, or anything ending the
//  lease fails closed: there is no resume.

import type { WebSocket } from 'ws';
import { type CdpMessage, connectCdp } from './cdp-client.js';
import { type CommandFrame, HIDDEN_HISTORY_URL, checkCommand, filterEvent, filterReply, parseFrame } from './command-policy.js';
import { type Consent, onConsentedSite } from './egress-rules.js';
import type { PageEndMode, RequestEnforcer } from './request-enforcer.js';
import { CommandFenced, type CommandTransport, type TabLease, createFencedForwarder } from './tab-lease.js';

const TAB_SESSION = 'cascade-tab-1';

export interface RelayEvents {
  /** Why a command was refused or the lease ended, for the device's log. Never sent to the server. */
  refusals: string[];
  /** Commands refused for not being on the list, and events dropped for the same reason. */
  refusedMethods: Set<string>;
  droppedEvents: Set<string>;
}

export interface DeviceRelayOptions {
  tabWs: string;
  consent: Consent;
  lease: TabLease;
  enforcer: RequestEnforcer;
  /** What revoke does to the tab. See RequestEnforcer.endPageActivity. */
  pageEnd: PageEndMode;
  /** Test seam only: a barrier between dispatch and forward. */
  beforeForward?: CommandTransport<unknown>['beforeForward'];
}

export interface DeviceRelay extends RelayEvents {
  /** Serves one agent connection under the lease already held. Resolves when it's over. */
  serve(agent: WebSocket): Promise<void>;
}

export function createDeviceRelay(opts: DeviceRelayOptions): DeviceRelay {
  const { consent, lease, enforcer } = opts;
  const refusals: string[] = [];
  const refusedMethods = new Set<string>();
  const droppedEvents = new Set<string>();

  const serve = async (agent: WebSocket): Promise<void> => {
    // Listen from the start: the agent speaks as soon as it connects.
    const early: string[] = [];
    let onFrame = (raw: string): void => { early.push(raw); };
    agent.on('message', (raw) => onFrame(String(raw)));
    const tab = await connectCdp(opts.tabWs);
    const knownSessions = new Set([TAB_SESSION]);
    const hiddenSessions = new Set<string>();
    const injected: { identifier: string; sessionId?: string }[] = [];
    let targetInfo: Record<string, unknown> | null = null;
    let lastId = -1;
    let ended = false;
    let finish!: () => void;
    const done = new Promise<void>((r) => { finish = r; });

    const out = (m: object): void => { if (agent.readyState === agent.OPEN) agent.send(JSON.stringify(m)); };
    const replyError = (id: number, sessionId: string | undefined, message: string): void => {
      out({ id, ...(sessionId ? { sessionId } : {}), error: { code: -32000, message } });
    };
    const toTab = (sessionId: string | undefined): string | undefined => (sessionId === TAB_SESSION ? undefined : sessionId);

    interface Outbound { key: number; method: string; params: Record<string, unknown>; sessionId?: string }
    let nextKey = 1;
    const transport: CommandTransport<Outbound> = {
      ...(opts.beforeForward ? { beforeForward: opts.beforeForward as (c: Outbound) => Promise<void> } : {}),
      write(c) {
        tab.send(c.method, c.params, c.sessionId).then(
          (result) => forwarder.deliver(c.key, { result }),
          (e: Error) => forwarder.deliver(c.key, { error: e.message }),
        );
      },
    };
    const forwarder = createFencedForwarder<Outbound, { result?: Record<string, unknown>; error?: string }>(lease, transport);
    const forward = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => {
      const key = nextKey++;
      return forwarder.dispatch({ key, method, params, ...(toTab(sessionId) ? { sessionId: toTab(sessionId)! } : {}) }, key);
    };

    const end = (why: string): void => {
      if (ended) return;
      ended = true;
      refusals.push(`lease ended: ${why}`);
      lease.revoke(why);
      void (async () => {
        // In order: the fence has changed and the queue is rejected; now end what's
        // running, and only then let go. Policy and proxy stay on until this is done.
        for (const { identifier, sessionId } of injected.splice(0)) {
          await tab.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId).catch(() => {});
        }
        await enforcer.endPageActivity(opts.pageEnd).catch(() => {});
        tab.close();
        try { agent.close(1011, 'lease ended'); } catch { /* already closing */ }
        finish();
      })();
    };
    lease.onChange((why, state) => { if (state === 'idle') end(why); });
    tab.onClose(() => end('the tab went away'));
    agent.on('close', () => end('the connection dropped'));
    agent.on('error', () => end('the connection failed'));
    if (lease.state() === 'idle') end('the lease is no longer held');

    tab.on((msg: CdpMessage) => {
      if (ended || !msg.method) return;
      if (lease.fence() === null) return; // Suspended: nothing reaches the agent.
      if (msg.sessionId && (hiddenSessions.has(msg.sessionId) || !knownSessions.has(msg.sessionId))) return;
      const params = msg.params ?? {};
      if (msg.method === 'Target.attachedToTarget') {
        const { sessionId: child, targetInfo: info, waitingForDebugger } = params as { sessionId: string; targetInfo?: { url?: string }; waitingForDebugger?: boolean };
        // A frame or worker on a site without consent is never given to the agent.
        if (!onConsentedSite(info?.url ?? '', consent)) {
          hiddenSessions.add(child);
          if (waitingForDebugger) void tab.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
          return;
        }
        knownSessions.add(child);
      }
      if (msg.method === 'Target.detachedFromTarget') {
        const child = (params as { sessionId: string }).sessionId;
        if (hiddenSessions.delete(child)) return;
        knownSessions.delete(child);
      }
      const safe = filterEvent(msg.method, params, consent);
      if (safe === null) { droppedEvents.add(msg.method); return; }
      out({ method: msg.method, params: safe, sessionId: msg.sessionId ?? TAB_SESSION });
    });

    const handleRoot = (f: CommandFrame): void => {
      switch (f.method) {
        case 'Browser.getVersion':
          out({ id: f.id, result: { protocolVersion: '1.3', product: 'Chrome/Cascade-Relay', revision: '', userAgent: 'Cascade-Relay', jsVersion: '' } });
          return;
        // Answered and never applied: the agent doesn't choose where downloads go.
        case 'Browser.setDownloadBehavior':
          out({ id: f.id, result: {} });
          return;
        case 'Target.getTargetInfo':
          out({ id: f.id, result: { targetInfo: targetInfo ?? { targetId: 'browser', type: 'browser', title: '', url: '', attached: true } } });
          return;
        case 'Target.setAutoAttach':
          out({ id: f.id, result: {} });
          void tab.send('Target.getTargetInfo').then((r) => {
            const info = (r as { targetInfo: Record<string, unknown> }).targetInfo;
            targetInfo = { ...info, attached: true, browserContextId: 'cascade-default' };
            const safe = filterEvent('Target.attachedToTarget', { sessionId: TAB_SESSION, targetInfo, waitingForDebugger: false }, consent);
            if (safe) out({ method: 'Target.attachedToTarget', params: safe });
          }).catch(() => end('the tab went away'));
          return;
        default:
          out({ id: f.id, error: { code: -32601, message: `Relay: browser-level ${f.method} not supported` } });
      }
    };

    const run = async (f: CommandFrame): Promise<void> => {
      const { id, method, params, sessionId } = f;
      const decision = checkCommand(f, { knownSessions });
      if (!decision.forward) {
        refusals.push(decision.reason);
        if (decision.reason.includes('not on the allowlist')) refusedMethods.add(method);
        replyError(id, sessionId, decision.reason);
        return;
      }
      if (method === 'Log.enable') { out({ id, sessionId, result: {} }); return; }
      try {
        if (method === 'Page.navigateToHistoryEntry') {
          // A page restored from the back-forward cache sends no request, so the
          // request policy alone would never see it.
          const h = await forward('Page.getNavigationHistory', {}, sessionId);
          const entries = (h.result?.entries ?? []) as { id: unknown; url?: string }[];
          const entry = entries.find((e) => e.id === params.entryId);
          if (!entry?.url || entry.url === HIDDEN_HISTORY_URL || !onConsentedSite(entry.url, consent)) {
            replyError(id, sessionId, 'Denied by Cascade relay policy: that history entry is not on a consented site');
            return;
          }
        }
        const r = await forward(method, params, sessionId);
        if (r.error !== undefined) { replyError(id, sessionId, r.error); return; }
        const result = r.result ?? {};
        if (method === 'Page.addScriptToEvaluateOnNewDocument' && typeof result.identifier === 'string') {
          const s = toTab(sessionId);
          injected.push({ identifier: result.identifier, ...(s ? { sessionId: s } : {}) });
        }
        out({ id, sessionId, result: filterReply(method, result, consent) });
      } catch (e) {
        if (e instanceof CommandFenced) { replyError(id, sessionId, e.message); return; }
        throw e;
      }
    };

    // Replies may finish out of order, as CDP allows; forwarding stays in arrival order.
    onFrame = (raw) => {
      if (ended) return;
      const f = parseFrame(raw);
      // Frame ids rise on one connection, so a replayed frame fails closed too.
      if (!f || f.id <= lastId) { refusals.push('malformed frame'); end('malformed frame'); return; }
      lastId = f.id;
      if (f.sessionId === undefined) { handleRoot(f); return; }
      void run(f).catch(() => end('relay error'));
    };
    for (const raw of early.splice(0)) onFrame(raw);
    return done;
  };

  return { refusals, refusedMethods, droppedEvents, serve };
}
