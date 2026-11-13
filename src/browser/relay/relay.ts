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
import { type CdpClient, type CdpMessage, connectCdp } from './cdp-client.js';
import { type CommandFrame, HIDDEN_HISTORY_URL, checkCommand, filterEvent, filterReply, filterTargetInfo, parseFrame } from './command-policy.js';
import { type Consent, onConsentedSite } from './egress-rules.js';
import { type PageEndMode, type RequestEnforcer, settlesWithin } from './request-enforcer.js';
import { CommandFenced, type CommandTransport, type TabLease, createFencedForwarder } from './tab-lease.js';

const TAB_SESSION = 'cascade-tab-1';
const SCRIPT_REMOVE_TIMEOUT_MS = 1000;
const TAB_READY_TIMEOUT_MS = 3000;
const TAB_CONNECT_TIMEOUT_MS = 3000;
// What may wait while the tab is reached and checked. A client's setup burst is far smaller.
const EARLY_FRAMES_MAX = 1000;
const EARLY_BYTES_MAX = 4 * 1024 * 1024;

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
  /**
   * Serves one agent connection under the lease already held. Resolves when it's over,
   * including the page step. One relay serves one lease generation: its enforcer and
   * browser are that lease's alone, so a later lease needs a fresh launch and relay.
   */
  serve(agent: WebSocket): Promise<void>;
}

/** The tab's connection, or null if it can't be had in time. One that opens late is closed. */
async function connectWithin(url: string, ms: number): Promise<CdpClient | null> {
  let timer!: NodeJS.Timeout;
  let late = false;
  const attempt = connectCdp(url).then((c) => { if (late) { c.close(); return null; } return c; }, () => null);
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => { late = true; r(null); }, ms); });
  try { return await Promise.race([attempt, timeout]); } finally { clearTimeout(timer); }
}

/** Why the tab can't be served yet, or null. A spinning page must not hold this up. */
async function tabReadyRefusal(enforcer: RequestEnforcer): Promise<string | null> {
  const check = async (): Promise<string | null> => {
    const tab = await enforcer.checkTabBeforeLease();
    if (!tab.ok) return tab.reason;
    return await enforcer.clearForeignHistory() ? null : 'the history of sites without consent could not be cleared';
  };
  let timer!: NodeJS.Timeout;
  const late = new Promise<string>((r) => { timer = setTimeout(() => r('the tab did not answer'), TAB_READY_TIMEOUT_MS); });
  try {
    return await Promise.race([check().catch(() => 'the tab could not be checked'), late]);
  } finally { clearTimeout(timer); }
}

export function createDeviceRelay(opts: DeviceRelayOptions): DeviceRelay {
  const { consent, lease, enforcer } = opts;
  const refusals: string[] = [];
  const refusedMethods = new Set<string>();
  const droppedEvents = new Set<string>();
  let servedGeneration: number | null = null;

  const serve = async (agent: WebSocket): Promise<void> => {
    // The lease this connection serves, pinned before anything is awaited. A later
    // grant on the same tab is another lease: this connection never runs under it.
    const generation = lease.generation();
    if (generation === null) {
      refusals.push('lease ended: the lease is no longer held');
      try { agent.close(1011, 'lease ended'); } catch { /* already closing */ }
      return;
    }
    if (servedGeneration === generation) {
      // One connection per lease. Refused without touching the lease, which another
      // connection of this relay is serving.
      refusals.push('refused: this lease already has a connection');
      try { agent.close(1011, 'lease already has a connection'); } catch { /* already closing */ }
      return;
    }
    if (servedGeneration !== null && servedGeneration !== generation) {
      // The enforcer ended the last lease's page and shut its proxy for good.
      refusals.push('lease ended: this browser has already served a lease; a fresh launch is needed');
      lease.revoke('this browser has already served a lease');
      try { agent.close(1011, 'lease ended'); } catch { /* already closing */ }
      return;
    }
    servedGeneration = generation;
    // Held until the page step below is over: until then the tab can't be leased again,
    // so nothing this teardown does can reach another lease's page.
    const releaseTeardown = lease.holdTeardown()!;
    let finish!: () => void;
    const done = new Promise<void>((r) => { finish = () => { releaseTeardown(); r(); }; });
    const ours = (): boolean => lease.generation() === generation;
    // Why the connection must end, recorded until `end` exists.
    let gone: string | null = null;
    let onGone = (why: string): void => { gone ??= why; };
    // Listen from the start: the agent speaks as soon as it connects.
    // Bounded: past the limit the connection ends rather than holding more in memory.
    const early: string[] = [];
    let earlyBytes = 0;
    let overflowed = false;
    let onFrame = (raw: string): void => {
      if (overflowed) return;
      earlyBytes += raw.length;
      if (early.length >= EARLY_FRAMES_MAX || earlyBytes > EARLY_BYTES_MAX) {
        overflowed = true;
        early.length = 0;
        onGone('too many commands before the tab was ready');
        return;
      }
      early.push(raw);
    };
    agent.on('message', (raw) => onFrame(String(raw)));
    // And for it going away: an 'error' with no listener would take the process down.
    agent.on('close', () => onGone('the connection dropped'));
    agent.on('error', () => onGone('the connection failed'));
    // And for the lease ending while the tab is still being reached.
    lease.onChange((why, state) => { if (state === 'ending' || state === 'idle') onGone(why); });
    const reached = await connectWithin(opts.tabWs, TAB_CONNECT_TIMEOUT_MS);
    if (!reached) {
      refusals.push('lease ended: could not reach the tab');
      if (ours()) lease.revoke('could not reach the tab');
      // Nothing ran, but the page step still ends the page and shuts the proxy.
      if (!await enforcer.endPageActivity(opts.pageEnd).catch(() => false)) refusals.push('the browser did not confirm the page ended');
      try { agent.close(1011, 'lease ended'); } catch { /* already closing */ }
      finish();
      return done;
    }
    const tab: CdpClient = reached;
    const knownSessions = new Set([TAB_SESSION]);
    const hiddenSessions = new Set<string>();
    const injected: { identifier: string; sessionId?: string }[] = [];
    // Registrations forwarded but not yet answered. A revoke can discard such a reply,
    // so its identifier is never known; the page step then closes the tab instead.
    let pendingScripts = 0;
    let targetInfo: Record<string, unknown> | null = null;
    let lastId = -1;
    let ended = false;

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
    const forwarder = createFencedForwarder<Outbound, { result?: Record<string, unknown>; error?: string }>(lease, transport, generation);
    const forward = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => {
      const key = nextKey++;
      return forwarder.dispatch({ key, method, params, ...(toTab(sessionId) ? { sessionId: toTab(sessionId)! } : {}) }, key);
    };

    const end = (why: string): void => {
      if (ended) return;
      ended = true;
      refusals.push(`lease ended: ${why}`);
      // The tab stays `ending` until finish(): no other lease can be granted meanwhile.
      if (ours()) lease.revoke(why);
      void (async () => {
        // In order: the fence has changed and the queue is rejected; now end what's
        // running, and only then let go. Policy and proxy stay on until this is done.
        // A spinning page answers neither call, so each is bounded. A script that's still
        // registered would run on about:blank too, so then the tab is closed instead.
        // Whatever happens here, the hold is released: a teardown can't keep the tab forever.
        try {
          const removed = await Promise.all(injected.splice(0).map(({ identifier, sessionId }) =>
            settlesWithin(tab.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId), SCRIPT_REMOVE_TIMEOUT_MS)));
          const accounted = removed.every(Boolean) && pendingScripts === 0;
          const ended = await enforcer.endPageActivity(accounted ? opts.pageEnd : 'close').catch(() => false);
          if (!ended) refusals.push('the browser did not confirm the page ended');
          tab.close();
          try { agent.close(1011, 'lease ended'); } catch { /* already closing */ }
        } finally { finish(); }
      })();
    };
    tab.onClose(() => end('the tab went away'));
    enforcer.onForeignDocument(() => end('the tab is showing a page without consent'));
    enforcer.onPolicyLost(() => end('the request policy lost its connection'));
    onGone = end;
    if (gone !== null) end(gone);
    if (!ours()) end('the lease is no longer held');

    // What happened to child sessions while the user had the tab, for the agent to be told
    // when it's handed back. Nothing is disclosed during the takeover itself.
    interface Missed { method: string; params: Record<string, unknown>; sessionId?: string }
    const missedAttach = new Map<string, Missed>();
    const missedDetach: Missed[] = [];
    const announce = (m: Missed): void => {
      const safe = filterEvent(m.method, m.params, consent);
      if (safe === null) { droppedEvents.add(m.method); return; }
      out({ method: m.method, params: safe, sessionId: m.sessionId ?? TAB_SESSION });
    };
    lease.onChange((_why, state) => {
      if (ended || state !== 'held' || lease.generation() !== generation) return;
      // Handed back. Detachments first, so a session that went and one that came never overlap.
      for (const m of missedDetach.splice(0)) announce(m);
      for (const m of [...missedAttach.values()]) announce(m);
      missedAttach.clear();
    });

    tab.on((msg: CdpMessage) => {
      if (ended || !msg.method) return;
      // Suspended: nothing reaches the agent. The bookkeeping below still runs, or a frame
      // that appeared during the takeover would be an unknown session for ever after.
      const suspended = lease.fence() === null;
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
        if (suspended) {
          // The agent can't resume it now, and the user's page needs it running.
          if (waitingForDebugger) void tab.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
          missedAttach.set(child, { method: msg.method, params: { ...params, waitingForDebugger: false }, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
          return;
        }
      }
      if (msg.method === 'Target.detachedFromTarget') {
        const child = (params as { sessionId: string }).sessionId;
        if (hiddenSessions.delete(child)) return;
        knownSessions.delete(child);
        // Came and went during the takeover: the agent never heard of it.
        if (missedAttach.delete(child)) return;
        if (suspended) { missedDetach.push({ method: msg.method, params, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }); return; }
      }
      if (suspended) return;
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
          out({ id: f.id, result: { targetInfo: (targetInfo && filterTargetInfo(targetInfo, consent)) ?? { targetId: 'browser', type: 'browser', url: '', attached: true } } });
          return;
        case 'Target.setAutoAttach': {
          // This asks the tab where it is, and its answer names the current URL. So it's
          // fenced like any forwarded command: refused while the lease is suspended for the
          // user, and an answer that comes back after the fence changed is dropped.
          const fence = lease.fence();
          if (!fence || fence.generation !== generation) {
            out({ id: f.id, error: { code: -32000, message: 'Denied by Cascade relay: the lease is not active' } });
            return;
          }
          // The tab is announced BEFORE the reply, as Chrome does: a client reads its pages
          // as soon as the reply arrives, and one that finds none opens a new page, which
          // the relay refuses. Replying first left that to the order of two network reads.
          const refused = (): void => out({ id: f.id, error: { code: -32000, message: 'Denied by Cascade relay: the lease is not active' } });
          void tab.send('Target.getTargetInfo').then((r) => {
            // Late: nothing about the tab, but still an answer, so the client isn't left waiting.
            if (ended || !lease.isCurrent(fence)) { refused(); return; }
            const info = (r as { targetInfo: Record<string, unknown> }).targetInfo;
            targetInfo = { ...info, attached: true, browserContextId: 'cascade-default' };
            const safe = filterEvent('Target.attachedToTarget', { sessionId: TAB_SESSION, targetInfo, waitingForDebugger: false }, consent);
            if (safe) out({ method: 'Target.attachedToTarget', params: safe });
            out({ id: f.id, result: {} });
          }).catch(() => { refused(); end('the tab went away'); });
          return;
        }
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
        const registering = method === 'Page.addScriptToEvaluateOnNewDocument';
        if (registering) pendingScripts += 1;
        let r: Awaited<ReturnType<typeof forward>>;
        try { r = await forward(method, params, sessionId); } catch (e) {
          // Fenced: whether it was written is unknown, so it stays counted as pending.
          if (registering && !(e instanceof CommandFenced)) pendingScripts -= 1;
          throw e;
        }
        if (registering) pendingScripts -= 1;
        if (r.error !== undefined) { replyError(id, sessionId, r.error); return; }
        const result = r.result ?? {};
        if (registering && typeof result.identifier === 'string') {
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
    const live = (raw: string): void => {
      if (ended) return;
      const f = parseFrame(raw);
      // Frame ids rise on one connection, so a replayed frame fails closed too.
      if (!f || f.id <= lastId) { refusals.push('malformed frame'); end('malformed frame'); return; }
      lastId = f.id;
      if (f.sessionId === undefined) { handleRoot(f); return; }
      void run(f).catch(() => end('relay error'));
    };
    // No command runs until the tab has been checked. Frames, including any that arrive
    // during the check, wait in `early`: the live handler is installed only after it.
    const refusal = await tabReadyRefusal(enforcer);
    if (refusal) end(refusal);
    if (!ours()) end('the lease is no longer held');
    if (ended) { early.length = 0; return done; }
    onFrame = live;
    for (const raw of early.splice(0)) onFrame(raw);
    return done;
  };

  return { refusals, refusedMethods, droppedEvents, serve };
}
