// ─────────────────────────────────────────────
//  Cascade AI — The device's side of the relay
// ─────────────────────────────────────────────
//
//  What runs on the user's machine. It dials out to the server and waits. When the
//  server offers a run, it checks the grant, asks the user, starts the browser the
//  user agreed to, and only then claims: reserve the tab, claim at the server,
//  promote, serve (plan section 2). Everything that ends a lease ends it here, on
//  the device, whatever the server does.
//
//  The browser and the question put to the user are injected: the CLI, the desktop
//  app and the extension each have their own.

import type { KeyObject } from 'node:crypto';
import { WebSocket } from 'ws';
import { type ApprovalPayload, type GrantPayload, type Identity, type Signed, createDeviceApprovals, verifyGrant } from './capability.js';
import { type Consent, makeConsent } from './egress-rules.js';
import { type ClaimFrame, type ClaimReply, type ControlFrame, type DeviceControlFrame, HUB_PROTOCOL } from './hub.js';
import { type DeviceRelay, createDeviceRelay } from './relay.js';
import type { PageEndMode, RequestEnforcer } from './request-enforcer.js';
import { type ServerClaim, type TabLease, acquireLease, createTabLease } from './tab-lease.js';

const CLAIM_REPLY_TIMEOUT_MS = 15_000;

/** What the user agreed to for one run. */
export interface UserConsent { allowedOrigins: string[]; privateOrigins: string[] }

/** A browser started for one lease, with its policy already on. */
export interface LeasedBrowser {
  tabWs: string;
  tabTargetId: string;
  enforcer: RequestEnforcer;
  pageEnd: PageEndMode;
  /** Called once the egress path is gone for any reason. Revoke here. */
  onEgressDown(fn: () => void): void;
  /** After the lease is over: the policy, the browser and its profile go. */
  close(): Promise<void>;
}

export interface DeviceClientOptions {
  /** The control endpoint, and the run endpoint beside it. */
  controlUrl: string;
  runUrl: string;
  /** How this device proves itself on the control connection. Never sent on a run connection. */
  headers?: Record<string, string>;
  device: Identity;
  serverId: string;
  serverKey: KeyObject;
  /** Ask the user, showing what the grant names. Null means no. */
  askUser(run: { userId: string; runId: string; expiresAt: number }): Promise<UserConsent | null>;
  startBrowser(consent: Consent): Promise<LeasedBrowser>;
  /** How long an approval lasts. Never longer than the grant. */
  approvalTtlMs?: number;
  now?: () => number;
  /** For the device's own log. Never sent to the server. */
  log?(line: string): void;
}

export interface DeviceClient {
  /** Resolves once the control connection is open. */
  ready: Promise<void>;
  /** The lease being served now, if any. */
  lease(): TabLease | null;
  relay(): DeviceRelay | null;
  /** The user's Stop: ends the lease, on the device. */
  revoke(reason: string): void;
  /** Logout, quitting, the user turning the source off: ends everything and disconnects. */
  close(): Promise<void>;
  /** Resolves when the control connection has gone, with why. */
  closed: Promise<string>;
}

const OPEN = 1;

export function connectDeviceClient(opts: DeviceClientOptions): DeviceClient {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const approvals = createDeviceApprovals({ device: opts.device, serverId: opts.serverId, serverKey: opts.serverKey, now });
  const control = new WebSocket(opts.controlUrl, { perMessageDeflate: false, ...(opts.headers ? { headers: opts.headers } : {}) });
  let active: { nonce: string; lease: TabLease; relay: DeviceRelay | null; cancelled: boolean } | null = null;
  let closing = false;
  let finished!: (why: string) => void;
  const closed = new Promise<string>((r) => { finished = r; });
  const ready = new Promise<void>((resolve, reject) => { control.once('open', () => resolve()); control.once('error', reject); });
  ready.catch(() => {});

  const tell = (frame: DeviceControlFrame): void => { if (control.readyState === OPEN) control.send(JSON.stringify(frame)); };
  const decline = (nonce: string, reason: string): void => { log(`declined: ${reason}`); tell({ v: HUB_PROTOCOL, t: 'decline', nonce, reason }); };

  /** One claim over a fresh run connection. The socket is returned only on a win. */
  const claimOverRun = (grant: Signed<GrantPayload>, approval: Signed<ApprovalPayload>): Promise<{ result: ServerClaim; socket: WebSocket | null }> =>
    new Promise((resolve) => {
      const socket = new WebSocket(opts.runUrl, { perMessageDeflate: false });
      let done = false;
      const finish = (result: ServerClaim, keep = false): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!keep) { try { socket.close(); } catch { /* already closing */ } }
        resolve({ result, socket: keep ? socket : null });
      };
      // No answer: the server may or may not have recorded the claim.
      const timer = setTimeout(() => finish({ outcome: 'unknown' }), CLAIM_REPLY_TIMEOUT_MS);
      socket.once('open', () => socket.send(JSON.stringify({ v: HUB_PROTOCOL, t: 'claim', grant, approval } satisfies ClaimFrame)));
      // Never reached the server at all: nothing was claimed, so the approval is still good.
      socket.once('error', () => finish({ outcome: 'unavailable' }));
      socket.once('close', () => finish({ outcome: 'unknown' }));
      socket.once('message', (raw) => {
        let reply: Partial<ClaimReply> | null = null;
        try { reply = JSON.parse(String(raw)) as Partial<ClaimReply>; } catch { /* handled below */ }
        if (reply?.v !== HUB_PROTOCOL) { finish({ outcome: 'unknown' }); return; }
        if (reply.t === 'claimed') { finish({ outcome: 'claimed' }, true); return; }
        if (reply.t !== 'refused') { finish({ outcome: 'unknown' }); return; }
        const r = reply as Extract<ClaimReply, { t: 'refused' }>;
        finish(r.outcome === 'refused' ? { outcome: 'refused', reason: String(r.reason) } : { outcome: r.outcome === 'replay' || r.outcome === 'unavailable' ? r.outcome : 'unknown' });
      });
    });

  const onOffer = async (grant: Signed<GrantPayload>): Promise<void> => {
    const nonce = grant?.payload?.nonce;
    if (typeof nonce !== 'string') return;
    // Checked before the user is asked anything: a grant that isn't this server's, for
    // this device, and in date, never reaches them.
    const g = verifyGrant(grant, opts.serverKey, { serverId: opts.serverId, deviceId: opts.device.id }, now());
    if (!g.ok) { decline(nonce, g.reason); return; }
    // One tab, one lease. Refused without asking the user, and without touching the grant.
    if (active) { decline(nonce, 'the browser is already in use'); return; }
    const mine = { nonce, lease: createTabLease(), relay: null as DeviceRelay | null, cancelled: false };
    active = mine;
    let browser: LeasedBrowser | null = null;
    try {
      const answer = await opts.askUser({ userId: grant.payload.userId, runId: grant.payload.runId, expiresAt: grant.payload.exp });
      if (mine.cancelled) return;
      if (!answer) { decline(nonce, 'the user said no'); return; }
      const consent = makeConsent(answer.allowedOrigins, answer.privateOrigins);
      browser = await opts.startBrowser(consent);
      if (mine.cancelled) return;
      const approval = approvals.approve(grant, { tabTargetId: browser.tabTargetId, ...answer }, opts.approvalTtlMs ?? 30 * 60_000);
      if ('refused' in approval) { decline(nonce, approval.refused); return; }
      let runSocket: WebSocket | null = null;
      const claim = await acquireLease({
        lease: mine.lease,
        admit: () => approvals.admit(approval),
        claim: async () => { const c = await claimOverRun(grant, approval); runSocket = c.socket; return c.result; },
        burn: () => approvals.burn(approval.payload.nonce),
      });
      if (claim.outcome !== 'leased' || !runSocket) {
        log(`no lease: ${claim.outcome === 'refused' ? claim.reason : claim.outcome}`);
        (runSocket as WebSocket | null)?.close();
        if (claim.outcome === 'leased') mine.lease.revoke('no run connection');
        return;
      }
      if (mine.cancelled) { mine.lease.revoke('the request was withdrawn'); }
      const lease = mine.lease;
      browser.onEgressDown(() => lease.revoke('egress-proxy-down'));
      mine.relay = createDeviceRelay({ tabWs: browser.tabWs, consent, lease, enforcer: browser.enforcer, pageEnd: browser.pageEnd });
      // Resolves when the lease is over, page step included.
      await mine.relay.serve(runSocket);
      log(`lease over: ${mine.relay.refusals.filter((r) => r.startsWith('lease ended')).join('; ')}`);
    } catch (e) {
      log(`offer failed: ${e instanceof Error ? e.message : String(e)}`);
      mine.lease.revoke('the device could not serve the run');
      decline(nonce, 'the device could not start the browser');
    } finally {
      // The policy and the browser are this lease's alone. They go with it.
      await browser?.close().catch(() => {});
      if (active === mine) active = null;
    }
  };

  control.on('message', (raw) => {
    let f: Partial<ControlFrame> | null = null;
    try { f = JSON.parse(String(raw)) as Partial<ControlFrame>; } catch { return; }
    if (!f || f.v !== HUB_PROTOCOL) return;
    if (f.t === 'offer' && f.grant) void onOffer(f.grant);
    else if (f.t === 'cancel' && active && active.nonce === f.nonce) {
      active.cancelled = true;
      active.lease.revoke('the request was withdrawn');
    }
  });
  const gone = (why: string): void => {
    // A network drop: the lease ends here, without waiting to be told.
    if (active) { active.cancelled = true; active.lease.revoke(why); }
    finished(why);
  };
  control.on('close', () => gone(closing ? 'closed' : 'the connection to the server dropped'));
  control.on('error', () => { /* 'close' follows */ });

  return {
    ready, closed,
    lease: () => active?.lease ?? null,
    relay: () => active?.relay ?? null,
    revoke(reason) { if (active) { active.cancelled = true; active.lease.revoke(reason); } },
    async close() {
      closing = true;
      if (active) { active.cancelled = true; active.lease.revoke('the device signed out'); }
      try { control.close(); } catch { /* already closing */ }
      await closed;
    },
  };
}
