// ─────────────────────────────────────────────
//  Cascade Cloud — a run's coding tools are the user's own machine's
// ─────────────────────────────────────────────
//
//  The server hosts no shell, no files and no git. A user's desktop app (or `cascade workspace serve`) dials out
//  to this server and serves a folder the user chose; a run started with that
//  device runs its coding tools there (docs/design/workspace-env.md).
//
//  This is the browser relay's machinery under a family of its own: the same
//  server key, the same device table (a desktop's registered key serves both), the
//  same hub rules, but grants and approvals signed under the workspace domains, two
//  endpoints of its own, and only `desktop` and `cli` devices admitted. The server relays
//  frames. It reads nothing of them beyond the protocol's own checks and logs
//  nothing of their content: no file contents, no paths, no command output.

import type http from 'node:http';
import type { Express } from 'express';
import rateLimit from 'express-rate-limit';
import { WebSocket } from 'ws';
import {
  RelayRefused,
  WORKSPACE_FAMILY,
  WorkspaceUnavailable,
  openRemoteWorkspace,
  type RelayHub,
  type RelayIdentity,
  type RemoteWorkspace,
} from '#cascade-ai';
import { type AuthedRequest, sessionMiddleware } from './auth/session.js';
import { createBrowserRelay } from './browser-relay.js';
import type { CloudStore, RelayDeviceKind } from './db.js';

export const WORKSPACE_CONTROL_PATH = '/api/workspace-relay/control';
export const WORKSPACE_RUN_PATH = '/api/workspace-relay/run';
export const WORKSPACE_DEVICES_PATH = '/api/workspace-relay/devices';
/** The desktop app and the CLI (`cascade workspace serve`) serve a folder: a browser extension can't. */
const WORKSPACE_KINDS: readonly RelayDeviceKind[] = ['desktop', 'cli'];

export interface WorkspaceRelay {
  readonly hub: RelayHub;
  readonly identity: RelayIdentity;
  /** The signed-in user's own desktop and CLI devices, and whether each is serving workspaces now. */
  routes(app: Express, sessionSecret: string): void;
  /** Takes the two public WebSocket paths on this server. */
  attach(server: http.Server): void;
  /** Resolves once the loopback endpoint for runs is listening. */
  readonly ready: Promise<void>;
  /** Where the run's tool client connects. Loopback only, and good once. Only after `ready`. */
  agentUrl(token: string): string;
  close(): Promise<void>;
}

export function createWorkspaceRelay(opts: { dataDir: string; store: CloudStore; now?: () => number }): WorkspaceRelay {
  const { store } = opts;
  const base = createBrowserRelay({
    dataDir: opts.dataDir, store, ...(opts.now ? { now: opts.now } : {}),
    family: WORKSPACE_FAMILY, controlPath: WORKSPACE_CONTROL_PATH, runPath: WORKSPACE_RUN_PATH, kinds: WORKSPACE_KINDS,
  });
  return {
    hub: base.hub, identity: base.identity, ready: base.ready, agentUrl: base.agentUrl, attach: base.attach, close: base.close,
    routes(app, sessionSecret) {
      const limited = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
      const auth = sessionMiddleware(sessionSecret);
      // Registering a desktop, and the key and server it pins, is the browser relay's
      // (it exists only when that relay is on, or the desktop was paired earlier). What a
      // client may see here: a name and whether it is serving. No key, no path.
      app.get(WORKSPACE_DEVICES_PATH, limited, auth, (req: AuthedRequest, res) => {
        const userId = req.session!.userId;
        res.json({
          devices: store.listRelayDevices(userId)
            .filter((d) => WORKSPACE_KINDS.includes(d.kind))
            .map((d) => ({ id: d.id, name: d.name, online: base.hub.deviceOnline(userId, d.id) })),
        });
      });
    },
  };
}

/** Why a run could not have its workspace. The message is for the run's owner. */
export class WorkspaceRunError extends Error {}

export interface RunWorkspace {
  readonly remote: RemoteWorkspace;
  readonly device: { id: string; name: string };
  /** Ends the lease and the connection. Safe to call twice. */
  release(reason?: string): void;
}

/**
 * The workspace of one of the user's desktops, for a run: asks the device (which asks
 * its user), waits for it to claim, and opens the run's side over the claimed connection.
 * Throws a WorkspaceRunError saying what to do when it cannot: never falls back to a run
 * with no tools.
 */
export async function openWorkspaceForRun(
  relay: Pick<WorkspaceRelay, 'hub' | 'ready' | 'agentUrl'>,
  store: Pick<CloudStore, 'getRelayDevice'>,
  req: { userId: string; deviceId: string; runId: string; signal?: AbortSignal },
): Promise<RunWorkspace> {
  const device = store.getRelayDevice(req.deviceId);
  // Only the user's own desktop and CLI devices: another user's id reads the same as none.
  if (!device || device.userId !== req.userId || !WORKSPACE_KINDS.includes(device.kind)) {
    throw new WorkspaceRunError('That computer is not one of your devices that can serve a workspace. Pick one from your devices, or run without a workspace.');
  }
  const named = `"${device.name}"`;
  if (!relay.hub.deviceOnline(req.userId, device.id)) {
    throw new WorkspaceRunError(`Your computer ${named} is not serving workspaces right now. Open the Cascade desktop app on it and turn workspace serving on (or run \`cascade workspace serve\` there), then try again.`);
  }
  const stopped = (): WorkspaceRunError => new WorkspaceRunError('The run was stopped before its workspace opened.');
  if (req.signal?.aborted) throw stopped();
  // Listened for from here on: a run stopped while the user is still being asked
  // withdraws the offer (the desktop's prompt closes) and closes what has opened.
  let socket: WebSocket | null = null;
  const onEarlyAbort = (): void => {
    relay.hub.endRun(req.runId, 'the run was stopped');
    socket?.close();
  };
  req.signal?.addEventListener('abort', onEarlyAbort, { once: true });
  let lease: Awaited<ReturnType<RelayHub['requestBrowser']>>;
  let remote: RemoteWorkspace;
  try {
    await relay.ready;
    if (req.signal?.aborted) throw stopped();
    try {
      lease = await relay.hub.requestBrowser({ userId: req.userId, deviceId: device.id, runId: req.runId });
    } catch (e) {
      if (req.signal?.aborted) throw stopped();
      const why = e instanceof RelayRefused ? e.reason : 'it could not be reached';
      throw new WorkspaceRunError(`Your computer ${named} did not open a workspace for this run: ${why}.`);
    }
    if (req.signal?.aborted) { lease.close('the run was stopped'); throw stopped(); }
    // Made before it opens, and handed over at once: the machine's first frame can arrive in the read that opens it.
    socket = new WebSocket(relay.agentUrl(lease.token), { perMessageDeflate: false });
    try {
      remote = await openRemoteWorkspace(socket);
    } catch (e) {
      lease.close('the workspace did not open');
      if (req.signal?.aborted) throw stopped();
      const why = e instanceof WorkspaceUnavailable ? e.message : 'it could not be opened';
      throw new WorkspaceRunError(`Your computer ${named} did not open a workspace for this run: ${why}.`);
    }
  } finally {
    req.signal?.removeEventListener('abort', onEarlyAbort);
  }
  // Either end going ends both: the lease ends the hub's sockets, which ends the remote.
  let released = false;
  const release = (reason = 'the run is over'): void => {
    if (released) return;
    released = true;
    remote.close(reason);
    lease.close(reason);
  };
  void remote.closed.then((why) => release(why));
  void lease.closed.then((why) => release(why));
  const onAbort = (): void => release('the run was stopped');
  req.signal?.addEventListener('abort', onAbort, { once: true });
  void remote.closed.then(() => req.signal?.removeEventListener('abort', onAbort));
  if (req.signal?.aborted) { onAbort(); throw stopped(); }
  return { remote, device: { id: device.id, name: device.name }, release };
}
