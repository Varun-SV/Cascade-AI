// ─────────────────────────────────────────────
//  Cascade AI — The machine's side of a workspace
// ─────────────────────────────────────────────
//
//  What runs on the user's machine (the desktop app). It dials out to the server
//  and listens on nothing. When the server offers a run, it checks the grant, asks
//  the user which tools the run may have, opens the folder they chose, and only
//  then claims: approve, claim at the server over a run connection of its own,
//  then serve the run's tool calls on it until the run, the user or the
//  connection ends it.
//
//  One run at a time: a second is refused without asking while one is served.
//  The control connection is the browser relay's (src/browser/relay/hub.ts): the
//  same hello, offers and cancels, under the workspace family's grants.

import type { KeyObject } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  type GrantPayload, type Identity, type Signed, createDeviceApprovals, identityFromPrivateKey, publicKeyFromText,
  signHello, verifyGrant,
} from '../browser/relay/capability.js';
import { readRunHint, type RunHint } from '../browser/relay/device.js';
import {
  type ClaimFrame, type ClaimReply, type ControlFrame, DEVICE_REJECTED_CLOSE, type DeviceControlFrame, HUB_PROTOCOL,
  SERVER_RESTART_CLOSE,
} from '../browser/relay/hub.js';
import type { WorkspaceExecutor } from './executor.js';
import {
  type DeviceRunFrame, MAX_IN_FLIGHT, WORKSPACE_FAMILY, WORKSPACE_PROTOCOL, isWorkspaceTool, readServerFrame,
} from './protocol.js';

const CLAIM_REPLY_TIMEOUT_MS = 15_000;
/** Frames the run may send before serving starts: none are expected before `ready`. */
const HELD_FRAMES_MAX = 64;
const OPEN = 1;

/** What the user agreed to for one run. */
export interface WorkspaceConsent {
  /** The tools the run may use: only workspace tools count. */
  tools: string[];
  /** What the run is shown for this workspace. Never the folder's path. */
  label: string;
}

export interface WorkspaceRunInfo { userId: string; runId: string; expiresAt: number }

export interface WorkspaceDeviceOptions {
  controlUrl: string;
  runUrl: string;
  device: Identity;
  serverId: string;
  serverKey: KeyObject;
  /** Ask the user. Null means no. `signal` fires if the offer is withdrawn first. */
  askUser(run: WorkspaceRunInfo & { signal: AbortSignal; hint?: RunHint }): Promise<WorkspaceConsent | null>;
  /** Opens the workspace the user agreed to: the folder, its registry, its checkpoints. */
  open(consent: WorkspaceConsent, run: WorkspaceRunInfo): Promise<WorkspaceExecutor>;
  /** A run started or stopped being served: for the app's own window. */
  onServing?(run: (WorkspaceRunInfo & { label: string }) | null): void;
  approvalTtlMs?: number;
  now?: () => number;
  /** For the device's own log. Never sent to the server. */
  log?(line: string): void;
}

export interface WorkspaceDeviceClient {
  /** Resolves once the server has accepted this device's proof of its key. */
  ready: Promise<void>;
  /** Resolves when the control connection has gone, with why. */
  closed: Promise<string>;
  /** The run being served now, if any. */
  serving(): WorkspaceRunInfo | null;
  /** The user's Stop: the run's access ends now, and it isn't offered the workspace again. */
  stop(reason?: string): void;
  /** Signing out, quitting, turning the workspace off: ends everything and disconnects. */
  close(): Promise<void>;
  /** The server turned this device away (as against the connection failing). */
  rejected(): boolean;
  /** The server closed the connection because it is restarting. */
  restarting(): boolean;
}

interface Session {
  nonce: string;
  run: WorkspaceRunInfo;
  withdrawn: AbortController;
  /** Ends the session: the run connection closes and every call in flight is cancelled. */
  end(reason: string): void;
  stopped: boolean;
}

export function connectWorkspaceDevice(opts: WorkspaceDeviceOptions): WorkspaceDeviceClient {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const approvals = createDeviceApprovals({
    device: opts.device, serverId: opts.serverId, serverKey: opts.serverKey, now, family: WORKSPACE_FAMILY,
  });
  const control = new WebSocket(opts.controlUrl, { perMessageDeflate: false });
  let session: Session | null = null;
  /** Runs the user stopped on this machine: offered again, they are refused without asking. */
  const stoppedRuns = new Set<string>();
  let closing = false;
  let authenticated = false;
  let finished!: (why: string) => void;
  const closed = new Promise<string>((r) => { finished = r; });
  let welcomed!: () => void;
  let notWelcomed!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { welcomed = resolve; notWelcomed = reject; });
  ready.catch(() => {});

  const tell = (frame: DeviceControlFrame): void => { if (control.readyState === OPEN) control.send(JSON.stringify(frame)); };
  const decline = (nonce: string, reason: string): void => { log(`declined: ${reason}`); tell({ v: HUB_PROTOCOL, t: 'decline', nonce, reason }); };

  /** One claim over a fresh run connection. Frames after the server's yes are held for serving. */
  const claimOverRun = (grant: Signed<GrantPayload>, approval: object): Promise<{ socket: WebSocket; held: string[] } | { refused: string }> =>
    new Promise((resolve) => {
      const socket = new WebSocket(opts.runUrl, { perMessageDeflate: false });
      let done = false;
      const held: string[] = [];
      const finish = (outcome: { socket: WebSocket; held: string[] } | { refused: string }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if ('refused' in outcome) { try { socket.close(); } catch { /* already closing */ } }
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ refused: 'the server did not answer the claim' }), CLAIM_REPLY_TIMEOUT_MS);
      socket.once('open', () => socket.send(JSON.stringify({ v: HUB_PROTOCOL, t: 'claim', grant, approval } as ClaimFrame)));
      socket.once('error', () => finish({ refused: 'could not reach the server' }));
      socket.once('close', () => finish({ refused: 'the server closed the claim' }));
      let replied = false;
      socket.on('message', (raw) => {
        if (replied) {
          // Held from the same step as the yes, until serving takes over.
          if (held.length < HELD_FRAMES_MAX) held.push(String(raw)); else socket.close(1009, 'too much before serving started');
          return;
        }
        replied = true;
        let reply: Partial<ClaimReply> | null = null;
        try { reply = JSON.parse(String(raw)) as Partial<ClaimReply>; } catch { /* below */ }
        if (reply?.v === HUB_PROTOCOL && reply.t === 'claimed') finish({ socket, held });
        else finish({ refused: reply?.t === 'refused' ? String((reply as { reason?: unknown }).reason ?? 'refused') : 'unexpected reply' });
      });
    });

  /** Serves the run's calls on its connection until it ends. */
  const serve = (s: Session, socket: WebSocket, held: string[], executor: WorkspaceExecutor, label: string): Promise<void> =>
    new Promise((resolve) => {
      const inFlight = new Map<string, AbortController>();
      const send = (frame: DeviceRunFrame): void => { if (socket.readyState === OPEN) socket.send(JSON.stringify(frame)); };
      let over = false;
      const end = (reason: string): void => {
        if (over) return;
        over = true;
        for (const c of inFlight.values()) c.abort(new Error(reason));
        inFlight.clear();
        try { socket.close(1000, reason.slice(0, 100)); } catch { /* already closing */ }
        log(`workspace session over: ${reason}`);
        void executor.finish().finally(() => resolve());
      };
      s.end = end;
      const onFrame = (raw: string): void => {
        if (over) return;
        const f = readServerFrame(raw);
        if (!f) { end('the run sent something that is not a workspace frame'); return; }
        if (f.t === 'cancel') { inFlight.get(f.id)?.abort(new Error('cancelled by the run')); return; }
        if (inFlight.has(f.id)) { send({ v: WORKSPACE_PROTOCOL, t: 'result', id: f.id, ok: false, error: 'a call with this id is already running' }); return; }
        if (inFlight.size >= MAX_IN_FLIGHT) { send({ v: WORKSPACE_PROTOCOL, t: 'result', id: f.id, ok: false, error: 'too many calls at once on this workspace' }); return; }
        const ac = new AbortController();
        inFlight.set(f.id, ac);
        void executor.run(f.tool, f.input, {
          signal: ac.signal,
          waiting: () => send({ v: WORKSPACE_PROTOCOL, t: 'status', id: f.id, waiting: 'approval' }),
        }).then((outcome) => {
          if (inFlight.get(f.id) !== ac) return;
          inFlight.delete(f.id);
          send(outcome.ok
            ? { v: WORKSPACE_PROTOCOL, t: 'result', id: f.id, ok: true, output: outcome.output }
            : { v: WORKSPACE_PROTOCOL, t: 'result', id: f.id, ok: false, error: outcome.error });
        });
      };
      socket.removeAllListeners('message');
      socket.on('message', (raw) => onFrame(String(raw)));
      socket.on('close', () => end('the run connection closed'));
      socket.on('error', () => end('the run connection failed'));
      // The run registers exactly these: it is never shown a tool this machine won't run.
      send({ v: WORKSPACE_PROTOCOL, t: 'ready', tools: executor.definitions(), label });
      for (const raw of held.splice(0)) onFrame(raw);
    });

  const onOffer = async (grant: Signed<GrantPayload>, hint?: RunHint): Promise<void> => {
    const nonce = grant?.payload?.nonce;
    if (typeof nonce !== 'string') return;
    // Checked before the user is asked anything.
    const g = verifyGrant(grant, opts.serverKey, { serverId: opts.serverId, deviceId: opts.device.id }, now(), WORKSPACE_FAMILY);
    if (!g.ok) { decline(nonce, g.reason); return; }
    if (session) { decline(nonce, 'the workspace is already serving a run'); return; }
    if (stoppedRuns.has(grant.payload.runId)) { decline(nonce, 'the run was stopped on this machine'); return; }
    const run: WorkspaceRunInfo = { userId: grant.payload.userId, runId: grant.payload.runId, expiresAt: grant.payload.exp };
    const s: Session = { nonce, run, withdrawn: new AbortController(), stopped: false, end: (reason) => { s.withdrawn.abort(new Error(reason)); } };
    session = s;
    let executor: WorkspaceExecutor | null = null;
    try {
      const answer = await Promise.race([
        opts.askUser({ ...run, signal: s.withdrawn.signal, ...(hint ? { hint } : {}) }).catch(() => null),
        new Promise<null>((r) => { if (s.withdrawn.signal.aborted) r(null); else s.withdrawn.signal.addEventListener('abort', () => r(null), { once: true }); }),
      ]);
      if (s.withdrawn.signal.aborted) return;
      const tools = [...new Set((answer?.tools ?? []).filter(isWorkspaceTool))];
      if (!answer || !tools.length) { decline(nonce, 'the user said no'); return; }
      const consent: WorkspaceConsent = { tools, label: answer.label };
      executor = await opts.open(consent, run);
      if (s.withdrawn.signal.aborted) return;
      const approval = approvals.approve(grant, { tools }, opts.approvalTtlMs ?? 30 * 60_000);
      if ('refused' in approval) { decline(nonce, approval.refused); return; }
      const admitted = approvals.admit(approval);
      if (!admitted.ok) { decline(nonce, admitted.reason); return; }
      // One claim per approval, whatever becomes of it.
      approvals.burn(approval.payload.nonce);
      const claimed = await claimOverRun(grant, approval);
      if ('refused' in claimed) { log(`no workspace session: ${claimed.refused}`); return; }
      if (s.withdrawn.signal.aborted) { claimed.socket.close(); return; }
      opts.onServing?.({ ...run, label: consent.label });
      const served = serve(s, claimed.socket, claimed.held, executor, consent.label);
      executor = null; // serve finishes it
      // Withdrawn while serving: the session ends.
      s.withdrawn.signal.addEventListener('abort', () => s.end('the request was withdrawn'), { once: true });
      await served;
    } catch (e) {
      log(`offer failed: ${e instanceof Error ? e.message : String(e)}`);
      decline(nonce, 'the machine could not open the workspace');
    } finally {
      await executor?.finish().catch(() => undefined);
      if (session === s) { session = null; opts.onServing?.(null); }
    }
  };

  control.once('error', (e) => notWelcomed(e));
  control.on('message', (raw) => {
    let f: Partial<ControlFrame> | null = null;
    try { f = JSON.parse(String(raw)) as Partial<ControlFrame>; } catch { return; }
    if (!f || f.v !== HUB_PROTOCOL) return;
    if (f.t === 'challenge') {
      if (authenticated || f.serverId !== opts.serverId || typeof f.challenge !== 'string') { control.close(); return; }
      tell({ v: HUB_PROTOCOL, t: 'hello', deviceId: opts.device.id, sig: signHello(opts.device, opts.serverId, f.challenge) });
      return;
    }
    if (f.t === 'welcome') { authenticated = true; welcomed(); return; }
    if (!authenticated) return;
    if (f.t === 'offer' && f.grant) void onOffer(f.grant, readRunHint((f as { hint?: unknown }).hint));
    else if (f.t === 'cancel' && session && session.nonce === f.nonce) session.end('the request was withdrawn');
  });
  let rejectedByServer = false;
  let serverRestarting = false;
  control.on('close', (code: number) => {
    rejectedByServer = !authenticated && code === DEVICE_REJECTED_CLOSE;
    serverRestarting = !closing && code === SERVER_RESTART_CLOSE;
    const why = closing ? 'closed' : rejectedByServer ? 'the server does not accept this device'
      : serverRestarting ? 'the server is restarting' : 'the connection to the server dropped';
    notWelcomed(new Error(why));
    session?.end(why);
    finished(why);
  });
  control.on('error', () => { /* 'close' follows */ });

  return {
    ready, closed,
    serving: () => session?.run ?? null,
    stop(reason = 'stopped on this machine') {
      if (!session) return;
      stoppedRuns.add(session.run.runId);
      session.stopped = true;
      session.end(reason);
    },
    rejected: () => rejectedByServer,
    restarting: () => serverRestarting,
    async close() {
      closing = true;
      session?.end('the machine stopped serving');
      try { control.close(); } catch { /* already closing */ }
      await closed;
    },
  };
}

/** What a device keeps once paired (the browser relay's pairing serves both). */
export interface PairedWorkspaceKey { deviceId: string; privateKeyPem: string; serverId: string; serverKey: string }

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Stays connected until the signal, reconnecting with backoff when the connection
 * drops; gives up when the server keeps refusing the device.
 */
export async function serveWorkspaceDevice(opts: {
  stored: PairedWorkspaceKey;
  endpoints: { controlUrl: string; runUrl: string };
  askUser: WorkspaceDeviceOptions['askUser'];
  open: WorkspaceDeviceOptions['open'];
  onServing?: WorkspaceDeviceOptions['onServing'];
  onClient?(client: WorkspaceDeviceClient | null): void;
  log(line: string): void;
  signal: AbortSignal;
  connect?: (o: WorkspaceDeviceOptions) => WorkspaceDeviceClient;
  sleep?: (ms: number) => Promise<void>;
  maxRefusals?: number;
}): Promise<'stopped' | 'refused'> {
  const connect = opts.connect ?? connectWorkspaceDevice;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const serverKey = publicKeyFromText(opts.stored.serverKey);
  if (!serverKey) throw new Error('The saved server key is not readable. Pair this machine again.');
  const device = identityFromPrivateKey(opts.stored.deviceId, opts.stored.privateKeyPem);
  let backoff = BACKOFF_START_MS;
  let refusals = 0;
  while (!opts.signal.aborted) {
    const client = connect({
      ...opts.endpoints, device, serverId: opts.stored.serverId, serverKey,
      askUser: opts.askUser, open: opts.open, log: opts.log,
      ...(opts.onServing ? { onServing: opts.onServing } : {}),
    });
    const stop = (): void => { void client.close(); };
    opts.signal.addEventListener('abort', stop, { once: true });
    opts.onClient?.(client);
    let welcomed = false;
    try {
      await client.ready;
      welcomed = true;
      refusals = 0;
      backoff = BACKOFF_START_MS;
      opts.log('connected: cloud runs can ask for this workspace');
    } catch { /* closed before the server accepted it */ }
    const why = await client.closed;
    opts.onClient?.(null);
    opts.signal.removeEventListener('abort', stop);
    if (opts.signal.aborted) return 'stopped';
    if (!welcomed && client.rejected() && ++refusals >= (opts.maxRefusals ?? 3)) return 'refused';
    opts.log(`disconnected (${why}); trying again in ${Math.round(backoff / 1000)}s`);
    await sleep(client.restarting() ? Math.max(backoff, 3000) : backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
  return 'stopped';
}
