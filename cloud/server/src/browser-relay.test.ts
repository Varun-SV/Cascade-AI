// The server's end of the browser relay: its key, its record of devices, and the
// endpoints a device dials. Real sockets and a real database file.

import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { generateRelayKey, relayIdentityFromPrivateKey, RelayRefused } from '#cascade-ai';
import { SESSION_COOKIE_NAME, createSessionToken } from './auth/session.js';
import { MAX_RELAY_DEVICES_PER_USER, RELAY_CONTROL_PATH, RELAY_RUN_PATH, createBrowserRelay, loadRelayIdentity, sqliteNonceStore } from './browser-relay.js';
import { CloudStore } from './db.js';

const SECRET = 'test-secret-test-secret-test-secret';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await Promise.resolve(c()).catch(() => {}); });

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-relay-server-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function server() {
  const dir = tmpDir();
  const store = new CloudStore(path.join(dir, 'cloud.db'));
  const relay = createBrowserRelay({ dataDir: dir, store });
  await relay.ready;
  const app = express();
  app.use(express.json());
  relay.routes(app, SECRET);
  const httpServer = http.createServer(app);
  relay.attach(httpServer);
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = (httpServer.address() as AddressInfo).port;
  cleanup.push(async () => { await relay.close(); httpServer.closeAllConnections(); httpServer.close(); });
  const user = (name: string) => {
    const u = store.upsertUser({ provider: 'dev', providerId: name, email: null, name, avatar: null });
    return { id: u.id, cookie: `${SESSION_COOKIE_NAME}=${createSessionToken({ userId: u.id } as never, SECRET)}` };
  };
  const api = (pathname: string, init: { method?: string; cookie?: string; body?: unknown } = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  /** A device as it would exist on a user's machine: its own key pair, registered once. */
  const register = async (cookie: string, name = 'My laptop', kind = 'cli') => {
    const key = generateRelayKey();
    const res = await api('/api/browser-relay/devices', { method: 'POST', cookie, body: { name, kind, publicKey: key.publicKey } });
    const body = await res.json() as { device?: { id: string }; serverId?: string; serverKey?: string; error?: string };
    return { res, body, key };
  };
  return { store, relay, port, user, api, register, dir, ws: `ws://127.0.0.1:${port}` };
}

const closed = (ws: WebSocket): Promise<number> => new Promise((res) => ws.once('close', (c) => res(c)));

/** Dials the control endpoint and answers the challenge as the device with this key. */
async function dial(base: string, deviceId: string, privateKeyPem: string, serverId: string): Promise<{ ws: WebSocket; welcomed: boolean }> {
  const { signHello } = await import('../../../src/browser/relay/capability.js');
  const id = relayIdentityFromPrivateKey(deviceId, privateKeyPem);
  const ws = new WebSocket(base + RELAY_CONTROL_PATH);
  return await new Promise((resolve) => {
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as { t: string; serverId: string; challenge: string };
      if (f.t === 'challenge') ws.send(JSON.stringify({ v: 1, t: 'hello', deviceId, sig: signHello(id, serverId, f.challenge) }));
      if (f.t === 'welcome') resolve({ ws, welcomed: true });
    });
    ws.once('close', () => resolve({ ws, welcomed: false }));
  });
}

describe("the server's own key", () => {
  it('is made once and is the same after a restart', () => {
    const dir = tmpDir();
    const first = loadRelayIdentity(dir);
    const again = loadRelayIdentity(dir);
    expect(again.id).toBe(first.id);
    expect(first.id).toMatch(/^cascade-relay:[\w-]{22}$/);
    expect(fs.statSync(path.join(dir, 'relay-server-key.pem')).mode & 0o077).toBe(0);
  });

  it('leaves nothing but the key behind', () => {
    const dir = tmpDir();
    loadRelayIdentity(dir);
    expect(fs.readdirSync(dir)).toEqual(['relay-server-key.pem']);
  });

  it('several processes booting at once agree on one key, and none reads a partial one', async () => {
    const dir = tmpDir();
    const script = path.join(dir, 'boot.mts');
    fs.writeFileSync(script, `
      import { loadRelayIdentity } from ${JSON.stringify(path.join(process.cwd(), 'src/browser-relay.ts'))};
      try { process.send({ id: loadRelayIdentity(${JSON.stringify(path.join(dir, 'data'))}).id }); }
      catch (e) { process.send({ error: String(e) }); }
    `);
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, () => new Promise<{ id?: string; error?: string }>((resolve, reject) => {
      const child = fork(script, { stdio: 'ignore', execArgv: ['--import', 'tsx'] });
      child.once('message', (m) => resolve(m as { id?: string; error?: string }));
      child.once('error', reject);
    })));
    expect(results.map((r) => r.error).filter(Boolean)).toEqual([]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'data'))).toEqual(['relay-server-key.pem']);
  }, 60_000);

  it('a different key is a different server', () => {
    expect(loadRelayIdentity(tmpDir()).id).not.toBe(loadRelayIdentity(tmpDir()).id);
  });

  it('is what a device is told to pin, without signing in', async () => {
    const s = await server();
    const body = await (await s.api('/api/browser-relay/server')).json() as { serverId: string; serverKey: string };
    expect(body.serverId).toBe(s.relay.identity.id);
    expect(body.serverKey.length).toBeGreaterThan(20);
  });
});

describe('registering a device', () => {
  it('needs a signed-in user', async () => {
    const s = await server();
    expect((await s.api('/api/browser-relay/devices', { method: 'POST', body: { name: 'x', kind: 'cli', publicKey: generateRelayKey().publicKey } })).status).toBe(401);
    expect((await s.api('/api/browser-relay/devices')).status).toBe(401);
  });

  it('stores the public key only, and tells the device which server it joined', async () => {
    const s = await server();
    const alice = s.user('alice');
    const { res, body } = await s.register(alice.cookie);
    expect(res.status).toBe(201);
    expect(body.serverId).toBe(s.relay.identity.id);
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
    const raw = fs.readFileSync(path.join(s.dir, 'cloud.db'));
    expect(raw.includes(Buffer.from('PRIVATE KEY'))).toBe(false);
  });

  it.each([
    ['no name', { name: '  ', kind: 'cli' }],
    ['an unknown kind', { name: 'x', kind: 'toaster' }],
    ['something that is not a key', { name: 'x', kind: 'cli', publicKey: 'not-a-key' }],
    ['a key of another type', { name: 'x', kind: 'cli', publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' }],
  ])('refuses %s', async (_name, fields) => {
    const s = await server();
    const alice = s.user('alice');
    const body = { publicKey: generateRelayKey().publicKey, ...fields };
    expect((await s.api('/api/browser-relay/devices', { method: 'POST', cookie: alice.cookie, body })).status).toBe(400);
  });

  it('a user sees and removes only their own devices', async () => {
    const s = await server();
    const alice = s.user('alice');
    const bob = s.user('bob');
    const a = await s.register(alice.cookie, "Alice's laptop");
    await s.register(bob.cookie, "Bob's laptop");
    const list = async (cookie: string) => ((await (await s.api('/api/browser-relay/devices', { cookie })).json()) as { devices: { name: string }[] }).devices.map((d) => d.name);
    expect(await list(alice.cookie)).toEqual(["Alice's laptop"]);
    expect(await list(bob.cookie)).toEqual(["Bob's laptop"]);
    // Bob can't remove Alice's, and can't tell it exists.
    expect((await s.api(`/api/browser-relay/devices/${a.body.device!.id}`, { method: 'DELETE', cookie: bob.cookie })).status).toBe(404);
    expect(await list(alice.cookie)).toEqual(["Alice's laptop"]);
    expect((await s.api(`/api/browser-relay/devices/${a.body.device!.id}`, { method: 'DELETE', cookie: alice.cookie })).status).toBe(200);
    expect(await list(alice.cookie)).toEqual([]);
  });

  it('has a limit per user', async () => {
    const s = await server();
    const alice = s.user('alice');
    for (let i = 0; i < MAX_RELAY_DEVICES_PER_USER; i++) expect((await s.register(alice.cookie, `d${i}`)).res.status).toBe(201);
    expect((await s.register(alice.cookie, 'one too many')).res.status).toBe(409);
    // Another user is not affected.
    expect((await s.register(s.user('bob').cookie)).res.status).toBe(201);
  });
});

describe('the routes are rate-limited by themselves', () => {
  it('a burst past the limit is refused, signed in or not', async () => {
    const s = await server();
    const alice = s.user('alice');
    const codes: number[] = [];
    for (let i = 0; i < 70; i++) codes.push((await s.api('/api/browser-relay/devices', { cookie: alice.cookie })).status);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes.slice(60).every((c) => c === 429)).toBe(true);
  });
});

describe('a device connecting', () => {
  it('with its registered key is online for its own user, and for no one else', async () => {
    const s = await server();
    const alice = s.user('alice');
    const bob = s.user('bob');
    const { body, key } = await s.register(alice.cookie);
    const { ws, welcomed } = await dial(s.ws, body.device!.id, key.privateKeyPem, body.serverId!);
    cleanup.push(() => ws.close());
    expect(welcomed).toBe(true);
    await vi.waitFor(() => expect(s.relay.hub.deviceOnline(alice.id, body.device!.id)).toBe(true));
    expect(s.relay.hub.deviceOnline(bob.id, body.device!.id)).toBe(false);
    const listed = ((await (await s.api('/api/browser-relay/devices', { cookie: alice.cookie })).json()) as { devices: { online: boolean; lastSeenAt: number | null }[] }).devices[0]!;
    expect(listed.online).toBe(true);
    expect(listed.lastSeenAt).not.toBeNull();
  });

  it('with another key is refused', async () => {
    const s = await server();
    const { body } = await s.register(s.user('alice').cookie);
    const { welcomed } = await dial(s.ws, body.device!.id, generateRelayKey().privateKeyPem, body.serverId!);
    expect(welcomed).toBe(false);
  });

  it('removing a device disconnects it at once, and it cannot come back', async () => {
    const s = await server();
    const alice = s.user('alice');
    const { body, key } = await s.register(alice.cookie);
    const { ws } = await dial(s.ws, body.device!.id, key.privateKeyPem, body.serverId!);
    const gone = closed(ws);
    await s.api(`/api/browser-relay/devices/${body.device!.id}`, { method: 'DELETE', cookie: alice.cookie });
    expect(await gone).toBe(1008);
    expect(s.relay.hub.deviceOnline(alice.id, body.device!.id)).toBe(false);
    expect((await dial(s.ws, body.device!.id, key.privateKeyPem, body.serverId!)).welcomed).toBe(false);
    await expect(s.relay.hub.requestBrowser({ userId: alice.id, deviceId: body.device!.id, runId: 'r' })).rejects.toBeInstanceOf(RelayRefused);
  });

  it('the run endpoint takes no one without a claim', async () => {
    const s = await server();
    const ws = new WebSocket(s.ws + RELAY_RUN_PATH);
    await new Promise((r) => ws.once('open', r));
    ws.send('hello');
    expect(await closed(ws)).toBe(1008);
  });

  it("the run's own endpoint is not on the public listener, and is loopback only", async () => {
    const s = await server();
    const url = new URL(s.relay.agentUrl('some-token'));
    expect(url.hostname).toBe('127.0.0.1');
    expect(Number(url.port)).not.toBe(s.port);
    // The same path on the public listener is nothing.
    const ws = new WebSocket(`${s.ws}/agent/some-token`);
    // Nothing here takes it. (In production socket.io then destroys the request.)
    const opened = await new Promise<boolean>((r) => { ws.once('error', () => r(false)); ws.once('open', () => r(true)); setTimeout(() => r(false), 500); });
    ws.terminate();
    expect(opened).toBe(false);
  });
});

describe('the nonce store every instance shares', () => {
  it('in one process: exactly one of many concurrent claims wins', async () => {
    const dir = tmpDir();
    const nonces = sqliteNonceStore(new CloudStore(path.join(dir, 'cloud.db')));
    const results = await Promise.all(Array.from({ length: 50 }, () => nonces.claimOnce('n1', Date.now() + 60_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await nonces.claimOnce('n2', Date.now() + 60_000)).toBe(true);
  });

  it('a claimed nonce stays claimed after a restart', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'cloud.db');
    expect(await sqliteNonceStore(new CloudStore(file)).claimOnce('n1', Date.now() + 60_000)).toBe(true);
    expect(await sqliteNonceStore(new CloudStore(file)).claimOnce('n1', Date.now() + 60_000)).toBe(false);
  });

  it('is still refused after its grant expired, and is forgotten only a lifetime later', async () => {
    const dir = tmpDir();
    let t = 1_000_000;
    const nonces = sqliteNonceStore(new CloudStore(path.join(dir, 'cloud.db')), () => t);
    expect(await nonces.claimOnce('n1', t + 1000)).toBe(true);
    t += 60_000;
    expect(await nonces.claimOnce('n1', t + 1000)).toBe(false);
  });

  it('across processes sharing the database: exactly one of N wins', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'cloud.db');
    new CloudStore(file);
    const script = path.join(dir, 'claim.mjs');
    // Each process opens the database itself and claims the same key.
    fs.writeFileSync(script, `
      import Database from ${JSON.stringify(path.join(process.cwd(), '../../node_modules/better-sqlite3/lib/index.js'))};
      const db = new Database(${JSON.stringify(file)}, { timeout: 5000 });
      const won = db.prepare('INSERT OR IGNORE INTO relay_nonces (key, expires_at) VALUES (?, ?)').run('shared', Date.now() + 60000).changes === 1;
      process.send(won);
    `);
    const N = 6;
    const results = await Promise.all(Array.from({ length: N }, () => new Promise<boolean>((resolve, reject) => {
      const child = fork(script, { stdio: 'ignore' });
      child.once('message', (m) => resolve(Boolean(m)));
      child.once('error', reject);
    })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
