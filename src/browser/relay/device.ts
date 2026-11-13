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
import { type ApprovalPayload, type GrantPayload, type Identity, type Signed, createDeviceApprovals, signHello, verifyGrant } from './capability.js';
import { type Consent, makeConsent } from './egress-rules.js';
import { type ClaimFrame, type ClaimReply, type ControlFrame, type DeviceControlFrame, HUB_PROTOCOL } from './hub.js';
import { type DeviceRelay, createDeviceRelay } from './relay.js';
import type { PageEndMode, RequestEnforcer } from './request-enforcer.js';
import { type ServerClaim, type TabLease, acquireLease, createTabLease } from './tab-lease.js';

const CLAIM_REPLY_TIMEOUT_MS = 15_000;
// What the run may send between the server accepting the claim and the relay listening.
const HELD_FRAMES_MAX = 1000;
const HELD_BYTES_MAX = 4 * 1024 * 1024;

/** A run connection that won its claim, with whatever arrived right behind the reply. */
interface ClaimedSocket {
  socket: WebSocket;
  /** Call in the same synchronous step as the relay starts listening: hands it what was held, in order. */
  release(): void;
}

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
  device: Identity;
  serverId: string;
  serverKey: KeyObject;
  /** Ask the user, showing what the grant names. Null means no. */
  /**
   * `signal` fires if the server withdraws the request, or it ends some other way,
   * before the user answers: take the question down. A later answer is ignored.
   */
  askUser(run: { userId: string; runId: string; expiresAt: number; signal: AbortSignal }): Promise<UserConsent | null>;
  startBrowser(consent: Consent): Promise<LeasedBrowser>;
  /** How long an approval lasts. Never longer than the grant. */
  approvalTtlMs?: number;
  now?: () => number;
  /** For the device's own log. Never sent to the server. */
  log?(line: string): void;
}

export interface DeviceClient {
  /** Resolves once the server has accepted this device's proof of its key. */
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
  const control = new WebSocket(opts.controlUrl, { perMessageDeflate: false });
  interface Active { nonce: string; lease: TabLease; relay: DeviceRelay | null; cancelled: boolean; withdrawn: AbortController }
  let active: Active | null = null;
  /** Ends whatever this offer has got to: the question, the browser starting, or the lease. */
  const withdraw = (a: Active, reason: string): void => {
    a.cancelled = true;
    a.withdrawn.abort(new Error(reason));
    a.lease.revoke(reason);
  };
  let closing = false;
  let finished!: (why: string) => void;
  const closed = new Promise<string>((r) => { finished = r; });
  let welcomed!: () => void;
  let notWelcomed!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { welcomed = resolve; notWelcomed = reject; });
  ready.catch(() => {});
  control.once('error', (e) => notWelcomed(e));
  let authenticated = false;

  const tell = (frame: DeviceControlFrame): void => { if (control.readyState === OPEN) control.send(JSON.stringify(frame)); };
  const decline = (nonce: string, reason: string): void => { log(`declined: ${reason}`); tell({ v: HUB_PROTOCOL, t: 'decline', nonce, reason }); };

  /** One claim over a fresh run connection. The socket is returned only on a win. */
  const claimOverRun = (grant: Signed<GrantPayload>, approval: Signed<ApprovalPayload>): Promise<{ result: ServerClaim; claimed: ClaimedSocket | null }> =>
    new Promise((resolve) => {
      const socket = new WebSocket(opts.runUrl, { perMessageDeflate: false });
      let done = false;
      const finish = (result: ServerClaim, keep = false): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!keep) { try { socket.close(); } catch { /* already closing */ } resolve({ result, claimed: null }); return; }
        // The server may send the run's first commands right behind its reply, in the same
        // read. The relay isn't listening yet: that takes several steps more. So they're
        // held from this very step, and handed over when it is. Bounded, like everything held.
        const held: unknown[] = [];
        let heldBytes = 0;
        const hold = (raw: unknown): void => {
          const size = Array.isArray(raw) ? raw.reduce((n: number, b: { byteLength: number }) => n + b.byteLength, 0) : (raw as { byteLength: number }).byteLength;
          if (held.length >= HELD_FRAMES_MAX || heldBytes + size > HELD_BYTES_MAX) { held.length = 0; try { socket.close(1009, 'too much before the relay was ready'); } catch { /* already closing */ } return; }
          heldBytes += size;
          held.push(raw);
        };
        socket.on('message', hold);
        resolve({
          result,
          claimed: {
            socket,
            release() {
              socket.off('message', hold);
              for (const raw of held.splice(0)) socket.emit('message', raw, false);
            },
          },
        });
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
    const mine: Active = { nonce, lease: createTabLease(), relay: null, cancelled: false, withdrawn: new AbortController() };
    // Settles as soon as the offer is withdrawn, so nothing waits on a question nobody needs answered.
    const unlessWithdrawn = <T>(p: Promise<T>): Promise<T | null> => Promise.race([
      p,
      new Promise<null>((resolve) => {
        if (mine.withdrawn.signal.aborted) resolve(null);
        else mine.withdrawn.signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
    ]);
    active = mine;
    let browser: LeasedBrowser | null = null;
    try {
      const answer = await unlessWithdrawn(opts.askUser({ userId: grant.payload.userId, runId: grant.payload.runId, expiresAt: grant.payload.exp, signal: mine.withdrawn.signal }));
      if (mine.cancelled) return;
      if (!answer) { decline(nonce, 'the user said no'); return; }
      const consent = makeConsent(answer.allowedOrigins, answer.privateOrigins);
      browser = await opts.startBrowser(consent);
      if (mine.cancelled) return;
      const approval = approvals.approve(grant, { tabTargetId: browser.tabTargetId, ...answer }, opts.approvalTtlMs ?? 30 * 60_000);
      if ('refused' in approval) { decline(nonce, approval.refused); return; }
      let claimed = null as ClaimedSocket | null;
      const claim = await acquireLease({
        lease: mine.lease,
        admit: () => approvals.admit(approval),
        claim: async () => { const c = await claimOverRun(grant, approval); claimed = c.claimed; return c.result; },
        burn: () => approvals.burn(approval.payload.nonce),
      });
      if (claim.outcome !== 'leased' || !claimed) {
        log(`no lease: ${claim.outcome === 'refused' ? claim.reason : claim.outcome}`);
        claimed?.socket.close();
        if (claim.outcome === 'leased') mine.lease.revoke('no run connection');
        return;
      }
      const run: ClaimedSocket = claimed;
      if (mine.cancelled) { mine.lease.revoke('the request was withdrawn'); }
      const lease = mine.lease;
      browser.onEgressDown(() => lease.revoke('egress-proxy-down'));
      mine.relay = createDeviceRelay({ tabWs: browser.tabWs, consent, lease, enforcer: browser.enforcer, pageEnd: browser.pageEnd });
      // The relay starts listening before its first await, so nothing arrives between
      // that and the hand-over on the next line.
      const served = mine.relay.serve(run.socket);
      run.release();
      // Resolves when the lease is over, page step included.
      await served;
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
    if (f.t === 'challenge') {
      // Signed only for the server this device was registered with: another server's
      // challenge gets no signature to use anywhere.
      if (authenticated || f.serverId !== opts.serverId || typeof f.challenge !== 'string') { control.close(); return; }
      tell({ v: HUB_PROTOCOL, t: 'hello', deviceId: opts.device.id, sig: signHello(opts.device, opts.serverId, f.challenge) });
      return;
    }
    if (f.t === 'welcome') { authenticated = true; welcomed(); return; }
    // Nothing is acted on before the server has accepted this device.
    if (!authenticated) return;
    if (f.t === 'offer' && f.grant) void onOffer(f.grant);
    else if (f.t === 'cancel' && active && active.nonce === f.nonce) withdraw(active, 'the request was withdrawn');
  });
  const gone = (why: string): void => {
    notWelcomed(new Error(why));
    // A network drop: the lease ends here, without waiting to be told.
    if (active) withdraw(active, why);
    finished(why);
  };
  control.on('close', () => gone(closing ? 'closed' : 'the connection to the server dropped'));
  control.on('error', () => { /* 'close' follows */ });

  return {
    ready, closed,
    lease: () => active?.lease ?? null,
    relay: () => active?.relay ?? null,
    revoke(reason) { if (active) withdraw(active, reason); },
    async close() {
      closing = true;
      if (active) withdraw(active, 'the device signed out');
      try { control.close(); } catch { /* already closing */ }
      await closed;
    },
  };
}
