// ─────────────────────────────────────────────
//  Cascade AI — The server's side of the relay
// ─────────────────────────────────────────────
//
//  A run on the server has no browser. The user's device has one, and dials out
//  to the server: nothing on the device listens. This is the part of the server
//  those connections end at (design section 3.1 and 5).
//
//  Three kinds of socket, and the hub is told which is which by its caller:
//
//    control   device → server, authenticated by the caller as one user's one
//              device. The server sends grants down it. It never carries CDP.
//    run       device → server, one per lease. It proves itself with its first
//              frame: the grant and the device's approval of it. Once claimed
//              it carries CDP and nothing else.
//    agent     the run's own CDP client, on the server, reaching the run socket
//              through a one-time token. Never exposed off the server.
//
//  Routing is by grant, never by user alone: a run is piped to the device that
//  claimed the grant issued for that run, and to no other. A capability opens
//  one connection, and a dropped connection is never resumed.

import type { KeyObject } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  type ApprovalPayload, type GrantPayload, type Identity, type NonceStore, type Signed,
  MAX_LIFETIME_MS, claimAtServer, issueGrant,
} from './capability.js';

export const HUB_PROTOCOL = 1;
const OFFER_TIMEOUT_MS = 120_000;
const CLAIM_FRAME_TIMEOUT_MS = 10_000;
const AGENT_ATTACH_TIMEOUT_MS = 30_000;
/** A claim is two signed objects. Anything bigger isn't one. */
const CLAIM_FRAME_MAX_BYTES = 64 * 1024;
/** What may wait for the agent to attach. The device only answers, so this is normally nothing. */
const PENDING_FRAMES_MAX = 256;

export type ControlFrame =
  | { v: 1; t: 'offer'; grant: Signed<GrantPayload> }
  | { v: 1; t: 'cancel'; nonce: string };
export type DeviceControlFrame = { v: 1; t: 'decline'; nonce: string; reason?: string };
export type ClaimFrame = { v: 1; t: 'claim'; grant: Signed<GrantPayload>; approval: Signed<ApprovalPayload> };
export type ClaimReply = { v: 1; t: 'claimed' } | { v: 1; t: 'refused'; reason: string };

/** Why a run didn't get a browser. `reason` is safe to show the run's owner. */
export class RelayRefused extends Error {
  constructor(readonly reason: string) { super(`browser relay: ${reason}`); }
}

export interface RunRequest { userId: string; deviceId: string; runId: string; ttlMs?: number }

export interface RelayedBrowser {
  /** For `attachAgent`, once. Whoever holds it drives the tab, so it never leaves the server. */
  readonly token: string;
  /** When this lease's time is up. */
  readonly expiresAt: number;
  /** Resolves with the reason once the connection is over. It is never resumed. */
  readonly closed: Promise<string>;
  close(reason?: string): void;
}

export interface RelayHubOptions {
  server: Identity;
  store: NonceStore;
  /** The key registered for this device, or null. */
  deviceKey(deviceId: string): KeyObject | null;
  now?: () => number;
  offerTimeoutMs?: number;
  agentAttachTimeoutMs?: number;
}

export interface RelayHub {
  /** A control connection the caller has authenticated as this user's device. Replaces an older one. */
  attachDevice(who: { userId: string; deviceId: string }, socket: WebSocket): void;
  /** A run connection. Not authenticated by the caller: its first frame must be a valid claim. */
  attachRun(socket: WebSocket): void;
  /** The run's CDP client. True if the token was good and unused. */
  attachAgent(token: string, socket: WebSocket): boolean;
  /** Asks the device to serve this run. Resolves once the device has claimed the grant. */
  requestBrowser(run: RunRequest): Promise<RelayedBrowser>;
  deviceOnline(userId: string, deviceId: string): boolean;
  /** Logout, token rotation, device unregistered: its control connection and every lease it serves end. */
  dropDevice(deviceId: string, reason: string): void;
  /** A run ended: whatever it was offered or holds ends with it. */
  endRun(runId: string, reason: string): void;
  close(): void;
}

interface Pending {
  run: Required<Pick<RunRequest, 'userId' | 'deviceId' | 'runId'>>;
  grant: Signed<GrantPayload>;
  resolve(b: RelayedBrowser): void;
  reject(e: RelayRefused): void;
  timer: NodeJS.Timeout;
  claiming: boolean;
}

interface Session {
  run: Pending['run'];
  device: WebSocket;
  agent: WebSocket | null;
  token: string | null;
  waiting: string[];
  timers: NodeJS.Timeout[];
  end(reason: string): void;
}

const OPEN = 1;
const send = (ws: WebSocket, frame: object): void => { if (ws.readyState === OPEN) ws.send(JSON.stringify(frame)); };
const shut = (ws: WebSocket, code: number, reason: string): void => { try { ws.close(code, reason.slice(0, 100)); } catch { /* already closing */ } };

function parseClaim(raw: string): ClaimFrame | null {
  if (raw.length > CLAIM_FRAME_MAX_BYTES) return null;
  let f: unknown;
  try { f = JSON.parse(raw); } catch { return null; }
  const c = f as Partial<ClaimFrame> | null;
  if (!c || c.v !== HUB_PROTOCOL || c.t !== 'claim' || typeof c.grant !== 'object' || typeof c.approval !== 'object' || !c.grant || !c.approval) return null;
  return c as ClaimFrame;
}

export function createRelayHub(opts: RelayHubOptions): RelayHub {
  const now = opts.now ?? Date.now;
  const offerTimeoutMs = opts.offerTimeoutMs ?? OFFER_TIMEOUT_MS;
  const agentAttachTimeoutMs = opts.agentAttachTimeoutMs ?? AGENT_ATTACH_TIMEOUT_MS;
  const controls = new Map<string, { userId: string; socket: WebSocket }>();
  const pending = new Map<string, Pending>();
  const sessions = new Set<Session>();
  const byToken = new Map<string, Session>();
  let closed = false;

  const settle = (nonce: string, outcome: RelayedBrowser | RelayRefused): void => {
    const p = pending.get(nonce);
    if (!p) return;
    pending.delete(nonce);
    clearTimeout(p.timer);
    if (outcome instanceof RelayRefused) p.reject(outcome); else p.resolve(outcome);
  };

  const withdraw = (nonce: string, reason: string): void => {
    const p = pending.get(nonce);
    if (!p) return;
    const control = controls.get(p.run.deviceId);
    if (control) send(control.socket, { v: HUB_PROTOCOL, t: 'cancel', nonce } satisfies ControlFrame);
    settle(nonce, new RelayRefused(reason));
  };

  const attachDevice: RelayHub['attachDevice'] = (who, socket) => {
    if (closed) { shut(socket, 1001, 'server closing'); return; }
    const old = controls.get(who.deviceId);
    if (old) {
      // One control connection per device. Offers made over the old one were for it.
      for (const [nonce, p] of pending) if (p.run.deviceId === who.deviceId) settle(nonce, new RelayRefused('the device reconnected'));
      shut(old.socket, 1000, 'replaced');
    }
    const entry = { userId: who.userId, socket };
    controls.set(who.deviceId, entry);
    socket.on('message', (raw) => {
      let f: Partial<DeviceControlFrame> | null = null;
      try { f = JSON.parse(String(raw)) as Partial<DeviceControlFrame>; } catch { /* ignored below */ }
      if (!f || f.v !== HUB_PROTOCOL || f.t !== 'decline' || typeof f.nonce !== 'string') return;
      const p = pending.get(f.nonce);
      // Only for an offer made to this device: a device can't decline another's.
      if (p && p.run.deviceId === who.deviceId && !p.claiming) settle(f.nonce, new RelayRefused('the request was declined on the device'));
    });
    const gone = (): void => {
      if (controls.get(who.deviceId) !== entry) return;
      controls.delete(who.deviceId);
      for (const [nonce, p] of pending) if (p.run.deviceId === who.deviceId && !p.claiming) settle(nonce, new RelayRefused('the device went offline'));
    };
    socket.on('close', gone);
    socket.on('error', gone);
  };

  const openSession = (p: Pending, device: WebSocket): RelayedBrowser => {
    const token = randomBytes(32).toString('base64url');
    let over = false;
    let finish!: (reason: string) => void;
    const closedPromise = new Promise<string>((r) => { finish = r; });
    const session: Session = {
      run: p.run, device, agent: null, token, waiting: [], timers: [],
      end(reason) {
        if (over) return;
        over = true;
        for (const t of session.timers) clearTimeout(t);
        sessions.delete(session);
        if (session.token) byToken.delete(session.token);
        shut(device, 1000, reason);
        if (session.agent) shut(session.agent, 1000, reason);
        finish(reason);
      },
    };
    sessions.add(session);
    byToken.set(token, session);
    // Not only checked when claimed: a lease claimed just before expiry would otherwise keep control.
    session.timers.push(setTimeout(() => session.end('the lease expired'), Math.max(0, Math.min(p.grant.payload.exp - now(), MAX_LIFETIME_MS))));
    session.timers.push(setTimeout(() => { if (!session.agent) session.end('the run never connected'); }, agentAttachTimeoutMs));
    device.on('message', (raw) => {
      if (over) return;
      const frame = String(raw);
      if (session.agent) { if (session.agent.readyState === OPEN) session.agent.send(frame); return; }
      if (session.waiting.length >= PENDING_FRAMES_MAX) { session.end('the device sent too much before the run connected'); return; }
      session.waiting.push(frame);
    });
    device.on('close', () => session.end('the device disconnected'));
    device.on('error', () => session.end('the device connection failed'));
    return { token, expiresAt: p.grant.payload.exp, closed: closedPromise, close: (reason = 'the run released the browser') => session.end(reason) };
  };

  const attachRun: RelayHub['attachRun'] = (socket) => {
    if (closed) { shut(socket, 1001, 'server closing'); return; }
    let decided = false;
    const refuse = (reason: string): void => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      send(socket, { v: HUB_PROTOCOL, t: 'refused', reason } satisfies ClaimReply);
      shut(socket, 1008, reason);
    };
    const timer = setTimeout(() => refuse('no claim arrived'), CLAIM_FRAME_TIMEOUT_MS);
    socket.on('error', () => { /* 'close' follows */ });
    socket.on('close', () => { clearTimeout(timer); });
    socket.once('message', (raw) => {
      if (decided) return;
      const claim = parseClaim(String(raw));
      if (!claim) { refuse('malformed claim'); return; }
      const nonce = claim.grant.payload?.nonce;
      const p = typeof nonce === 'string' ? pending.get(nonce) : undefined;
      // Unknown, already settled, or another claim for it is being decided.
      if (!p || p.claiming) { refuse('no such request'); return; }
      p.claiming = true;
      clearTimeout(timer);
      void claimAtServer({
        server: opts.server, store: opts.store, grant: claim.grant, approval: claim.approval, now: now(),
        deviceKey: opts.deviceKey,
        // The server's own record, by grant: the run this nonce was issued for, and no other.
        issued: (n) => (n === nonce ? p.run : null),
      }).then((result) => {
        if (decided) return;
        if (result.outcome !== 'claimed') {
          const reason = result.outcome === 'refused' ? result.reason
            : result.outcome === 'replay' ? 'approval was already claimed'
              : result.outcome === 'unavailable' ? 'nonce store unavailable' : 'claim outcome unknown';
          refuse(reason);
          // A claim that failed its checks leaves the offer open for the real device.
          // Anything that may have used the nonce up ends it.
          if (result.outcome === 'refused') p.claiming = false;
          else settle(nonce!, new RelayRefused(reason));
          return;
        }
        if (!pending.has(nonce!) || socket.readyState !== OPEN) {
          // The run gave up, or the device left, while the store was being asked.
          decided = true;
          shut(socket, 1000, 'the request is over');
          settle(nonce!, new RelayRefused('the device disconnected'));
          return;
        }
        decided = true;
        const browser = openSession(p, socket);
        send(socket, { v: HUB_PROTOCOL, t: 'claimed' } satisfies ClaimReply);
        settle(nonce!, browser);
      }, () => { refuse('claim failed'); p.claiming = false; });
    });
  };

  const attachAgent: RelayHub['attachAgent'] = (token, socket) => {
    const session = byToken.get(token);
    if (!session || session.agent) { shut(socket, 1008, 'no such browser'); return false; }
    // One connection per capability: the token is spent the moment it's used.
    byToken.delete(token);
    session.token = null;
    session.agent = socket;
    for (const frame of session.waiting.splice(0)) socket.send(frame);
    socket.on('message', (raw) => { if (session.device.readyState === OPEN) session.device.send(String(raw)); });
    socket.on('close', () => session.end('the run disconnected'));
    socket.on('error', () => session.end('the run connection failed'));
    return true;
  };

  const requestBrowser: RelayHub['requestBrowser'] = (request) => new Promise((resolve, reject) => {
    if (closed) { reject(new RelayRefused('the server is shutting down')); return; }
    const control = controls.get(request.deviceId);
    // By device, then checked against the user: never a lookup by user alone.
    if (!control || control.userId !== request.userId || control.socket.readyState !== OPEN) {
      reject(new RelayRefused('the device is not connected'));
      return;
    }
    if (!opts.deviceKey(request.deviceId)) { reject(new RelayRefused('the device is not registered')); return; }
    const run = { userId: request.userId, deviceId: request.deviceId, runId: request.runId };
    const grant = issueGrant(opts.server, { ...run, ttlMs: request.ttlMs ?? MAX_LIFETIME_MS, now: now() });
    const nonce = grant.payload.nonce;
    const timer = setTimeout(() => withdraw(nonce, 'the device did not answer in time'), offerTimeoutMs);
    pending.set(nonce, { run, grant, resolve, reject, timer, claiming: false });
    send(control.socket, { v: HUB_PROTOCOL, t: 'offer', grant } satisfies ControlFrame);
  });

  return {
    attachDevice, attachRun, attachAgent, requestBrowser,
    deviceOnline: (userId, deviceId) => {
      const c = controls.get(deviceId);
      return !!c && c.userId === userId && c.socket.readyState === OPEN;
    },
    dropDevice(deviceId, reason) {
      for (const [nonce, p] of pending) if (p.run.deviceId === deviceId) withdraw(nonce, reason);
      for (const s of [...sessions]) if (s.run.deviceId === deviceId) s.end(reason);
      const c = controls.get(deviceId);
      if (c) { controls.delete(deviceId); shut(c.socket, 1008, reason); }
    },
    endRun(runId, reason) {
      for (const [nonce, p] of pending) if (p.run.runId === runId) withdraw(nonce, reason);
      for (const s of [...sessions]) if (s.run.runId === runId) s.end(reason);
    },
    close() {
      closed = true;
      for (const nonce of [...pending.keys()]) withdraw(nonce, 'the server is shutting down');
      for (const s of [...sessions]) s.end('the server is shutting down');
      for (const c of controls.values()) shut(c.socket, 1001, 'server closing');
      controls.clear();
    },
  };
}
