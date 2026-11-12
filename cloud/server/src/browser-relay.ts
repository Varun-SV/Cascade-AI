// ─────────────────────────────────────────────
//  Cascade Cloud — a run's browser is the user's own
// ─────────────────────────────────────────────
//
//  The server hosts no browser. A user's device (the CLI, the extension, the
//  desktop app) dials out to this server and serves its user's runs from a
//  browser on that device. This file is the server's end of that:
//
//    - the server's signing key, which devices pin when they register;
//    - which devices belong to which user (their PUBLIC keys only);
//    - the two public WebSocket endpoints a device dials, and one that only
//      this process can reach, for the run's own CDP client.
//
//  The rules that matter live in the hub (src/browser/relay/hub.ts). What this
//  file adds is the part only a deployment can supply: storage that survives a
//  restart and is shared by every instance, and who a connection belongs to.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Express, Response } from 'express';
import { WebSocketServer } from 'ws';
import {
  RELAY_MAX_LIFETIME_MS,
  RelayStoreOutcomeUnknown,
  RelayStoreUnavailable,
  authenticateControl,
  createRelayHub,
  generateRelayKey,
  relayIdentityFromPrivateKey,
  relayPublicKeyFromText,
  relayPublicKeyToText,
  type RelayHub,
  type RelayIdentity,
  type RelayNonceStore,
} from '#cascade-ai';
import { type AuthedRequest, sessionMiddleware } from './auth/session.js';
import type { CloudStore, RelayDevice, RelayDeviceKind } from './db.js';

export const RELAY_CONTROL_PATH = '/api/browser-relay/control';
export const RELAY_RUN_PATH = '/api/browser-relay/run';
/** Enough for a person's machines. A bound, so a stolen session can't fill the table. */
export const MAX_RELAY_DEVICES_PER_USER = 10;
const DEVICE_KINDS: readonly RelayDeviceKind[] = ['cli', 'extension', 'desktop'];
const KEY_FILE = 'relay-server-key.pem';
/** A frame on a public endpoint. CDP replies can be large; a page decides how large. */
const MAX_PUBLIC_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * The server's own key, made on first boot and kept beside the database.
 *
 * Its id is derived from the key, so a device that pinned this server can tell
 * a different key from the same one: a new key is a new server, and every
 * device has to be registered again. That is the intended effect of losing the
 * file, not a failure to recover from quietly.
 */
export function loadRelayIdentity(dataDir: string): RelayIdentity {
  const file = path.join(dataDir, KEY_FILE);
  let pem: string;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    pem = generateRelayKey().privateKeyPem;
    // Created exclusively: two instances booting together must agree on one key.
    try {
      fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
    } catch {
      pem = fs.readFileSync(file, 'utf8');
    }
  }
  const unnamed = relayIdentityFromPrivateKey('', pem);
  const fingerprint = createHash('sha256').update(relayPublicKeyToText(unnamed.publicKey)).digest('base64url').slice(0, 22);
  return { ...unnamed, id: `cascade-relay:${fingerprint}` };
}

/** The nonce store every instance shares: the database's primary key decides. */
export function sqliteNonceStore(store: CloudStore, now: () => number = Date.now): RelayNonceStore {
  return {
    async claimOnce(key, exp) {
      try {
        // Kept a full lifetime past expiry: a replay that arrives late still finds it.
        return store.claimRelayNonce(key, exp + RELAY_MAX_LIFETIME_MS, now());
      } catch (e) {
        // A lock that timed out wrote nothing. Anything else may have.
        const code = (e as { code?: string }).code ?? '';
        throw code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED') ? new RelayStoreUnavailable() : new RelayStoreOutcomeUnknown();
      }
    },
  };
}

export interface BrowserRelay {
  readonly hub: RelayHub;
  readonly identity: RelayIdentity;
  /** Registration and listing, for the signed-in user's own devices. */
  routes(app: Express, sessionSecret: string): void;
  /** Takes the two public WebSocket paths on this server. */
  attach(server: http.Server): void;
  /** Resolves once the loopback endpoint for runs is listening. */
  readonly ready: Promise<void>;
  /** Where the run's CDP client connects. Loopback only, and good once. Only after `ready`. */
  agentUrl(token: string): string;
  close(): Promise<void>;
}

/** What a client may see of a device. The public key is not secret, but nothing needs it. */
const publicDevice = (d: RelayDevice, online: boolean) => ({ id: d.id, name: d.name, kind: d.kind, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, online });

export function createBrowserRelay(opts: { dataDir: string; store: CloudStore; now?: () => number }): BrowserRelay {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  const identity = loadRelayIdentity(opts.dataDir);
  const hub = createRelayHub({
    server: identity,
    store: sqliteNonceStore(store, now),
    // Read at the moment of use: a device revoked a second ago has no key.
    deviceKey: (id) => { const d = store.getRelayDevice(id); return d ? relayPublicKeyFromText(d.publicKey) : null; },
    now,
  });

  // The run's own CDP client reaches its browser here. Bound to loopback on a
  // port of its own, so the token that drives a user's tab never exists on the
  // public listener, in a proxy's log, or anywhere a request from outside can ask.
  const agentHttp = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const agentWss = new WebSocketServer({ server: agentHttp, maxPayload: MAX_PUBLIC_FRAME_BYTES, perMessageDeflate: false });
  agentWss.on('connection', (ws, req) => {
    const token = (req.url ?? '').replace(/^\/agent\//, '');
    hub.attachAgent(token, ws);
  });
  const ready = new Promise<void>((resolve, reject) => { agentHttp.once('error', reject); agentHttp.listen(0, '127.0.0.1', resolve); });
  // A failure to listen is the caller's to see when it awaits; unawaited, it must not end the process.
  ready.catch(() => {});

  const publicWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PUBLIC_FRAME_BYTES, perMessageDeflate: false });
  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== RELAY_CONTROL_PATH && pathname !== RELAY_RUN_PATH) return; // someone else's
    publicWss.handleUpgrade(req, socket, head, (ws) => {
      if (pathname === RELAY_RUN_PATH) { hub.attachRun(ws); return; }
      void authenticateControl(ws, {
        serverId: identity.id,
        device: (id) => {
          const d = store.getRelayDevice(id);
          const key = d ? relayPublicKeyFromText(d.publicKey) : null;
          return d && key ? { userId: d.userId, key } : null;
        },
      }).then((who) => {
        if (!who) return;
        store.touchRelayDevice(who.deviceId, now());
        hub.attachDevice(who, ws);
      });
    });
  };
  let attached: http.Server | null = null;

  return {
    hub, identity, ready,
    agentUrl(token) {
      const address = agentHttp.address() as AddressInfo | null;
      if (!address) throw new Error('the relay is not listening yet');
      return `ws://127.0.0.1:${address.port}/agent/${token}`;
    },
    attach(server) { attached = server; server.on('upgrade', onUpgrade); },
    routes(app, sessionSecret) {
      const auth = sessionMiddleware(sessionSecret);
      const mine = (req: AuthedRequest) => req.session!.userId;
      const bad = (res: Response, error: string) => { res.status(400).json({ error }); };

      // What a device needs to pin before it trusts anything from this server.
      app.get('/api/browser-relay/server', (_req, res) => {
        res.json({ serverId: identity.id, serverKey: relayPublicKeyToText(identity.publicKey), controlPath: RELAY_CONTROL_PATH, runPath: RELAY_RUN_PATH });
      });

      app.get('/api/browser-relay/devices', auth, (req: AuthedRequest, res) => {
        res.json({ devices: store.listRelayDevices(mine(req)).map((d) => publicDevice(d, hub.deviceOnline(d.userId, d.id))) });
      });

      // Registers the key of a device the signed-in user is holding. The key pair
      // is made on the device, and only its public half is sent.
      app.post('/api/browser-relay/devices', auth, (req: AuthedRequest, res) => {
        const body = (req.body ?? {}) as { name?: unknown; kind?: unknown; publicKey?: unknown };
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
        if (!name) { bad(res, 'A device needs a name.'); return; }
        if (typeof body.kind !== 'string' || !DEVICE_KINDS.includes(body.kind as RelayDeviceKind)) { bad(res, 'Unknown kind of device.'); return; }
        if (typeof body.publicKey !== 'string' || body.publicKey.length > 200 || !relayPublicKeyFromText(body.publicKey)) { bad(res, 'That is not a device key.'); return; }
        const device = store.createRelayDevice(mine(req), { name, kind: body.kind as RelayDeviceKind, publicKey: body.publicKey }, MAX_RELAY_DEVICES_PER_USER, now());
        if (!device) { res.status(409).json({ error: `You have ${MAX_RELAY_DEVICES_PER_USER} devices already. Remove one first.` }); return; }
        res.status(201).json({ device: publicDevice(device, false), serverId: identity.id, serverKey: relayPublicKeyToText(identity.publicKey) });
      });

      app.delete('/api/browser-relay/devices/:id', auth, (req: AuthedRequest, res) => {
        const id = String(req.params['id']);
        // Only the owner's own: someone else's id reads as not found.
        if (!store.revokeRelayDevice(mine(req), id, now())) { res.status(404).json({ error: 'No such device.' }); return; }
        // And whatever it is serving ends now, not at its next connection.
        hub.dropDevice(id, 'the device was removed');
        res.json({ ok: true });
      });
    },
    async close() {
      hub.close();
      attached?.off('upgrade', onUpgrade);
      publicWss.close();
      agentWss.close();
      agentHttp.closeAllConnections();
      await new Promise<void>((r) => agentHttp.close(() => r()));
    },
  };
}
