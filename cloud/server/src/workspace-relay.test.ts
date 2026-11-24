// The server's end of the workspace relay: who may connect, what a client may see of
// a device, and a run working in a folder on a desktop. Real sockets, a real database
// file, and the SDK's own device client with a real tool registry on the "machine".

import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  Cascade, ToolRegistry, WORKSPACE_TOOLS, connectWorkspaceDevice, createWorkspaceExecutor, generateRelayKey,
  relayIdentityFromPrivateKey, type WorkspaceDeviceClient,
} from '#cascade-ai';
import { SESSION_COOKIE_NAME, createSessionToken } from './auth/session.js';
import { RELAY_CONTROL_PATH, createBrowserRelay } from './browser-relay.js';
import { CloudStore, type RelayDeviceKind } from './db.js';
import { loadEnv } from './env.js';
import { parseChatRunPayload, runChatTurn } from './runs.js';
import { startStubOpenAIServer, type StubOpenAIServer } from './test-support/stub-openai-server.js';
import {
  WORKSPACE_CONTROL_PATH, WORKSPACE_DEVICES_PATH, WORKSPACE_RUN_PATH, WorkspaceRunError, createWorkspaceRelay, openWorkspaceForRun,
} from './workspace-relay.js';

const SECRET = 'test-secret-test-secret-test-secret';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await Promise.resolve(c()).catch(() => {}); });

function tmpDir(prefix = 'cascade-ws-server-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class FakeSocket {
  events: Array<{ event: string; payload: unknown }> = [];
  emit(event: string, payload: unknown): boolean { this.events.push({ event, payload }); return true; }
  on(): this { return this; }
  off(): this { return this; }
  named(event: string) { return this.events.filter((e) => e.event === event).map((e) => e.payload as Record<string, unknown>); }
}

async function server(opts: { browserRelay?: boolean } = {}) {
  const dir = tmpDir();
  const store = new CloudStore(path.join(dir, 'cloud.db'));
  const relay = createWorkspaceRelay({ dataDir: dir, store });
  await relay.ready;
  const app = express();
  app.use(express.json());
  relay.routes(app, SECRET);
  const httpServer = http.createServer(app);
  relay.attach(httpServer);
  // Both relays on one server, as an operator who turns both on has: a browser connection and a workspace one.
  const browser = opts.browserRelay ? createBrowserRelay({ dataDir: dir, store }) : undefined;
  browser?.attach(httpServer);
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = (httpServer.address() as AddressInfo).port;
  cleanup.push(async () => { await relay.close(); await browser?.close(); httpServer.closeAllConnections(); httpServer.close(); store.close(); });
  const user = (name: string) => {
    const u = store.upsertUser({ provider: 'dev', providerId: name, email: null, name, avatar: null });
    return { id: u.id, cookie: `${SESSION_COOKIE_NAME}=${createSessionToken({ userId: u.id } as never, SECRET)}` };
  };
  const api = (pathname: string, cookie?: string) => fetch(`http://127.0.0.1:${port}${pathname}`, { headers: cookie ? { Cookie: cookie } : {} });
  /** A device as it would exist on a user's machine: its own key pair, registered to the user. */
  const register = (userId: string, name: string, kind: RelayDeviceKind = 'desktop') => {
    const key = generateRelayKey();
    const device = store.createRelayDevice(userId, { name, kind, publicKey: key.publicKey }, 10, Date.now())!;
    return { device, identity: relayIdentityFromPrivateKey(device.id, key.privateKeyPem) };
  };
  return { dir, store, relay, port, user, api, register, ws: `ws://127.0.0.1:${port}` };
}

type World = Awaited<ReturnType<typeof server>>;

/** A folder on "the machine" and the desktop app serving it. */
async function desktop(w: World, owner: { id: string }, name = 'Work PC') {
  const { device, identity } = w.register(owner.id, name);
  const dir = tmpDir('cascade-ws-folder-');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello from the machine\n');
  const asked: string[] = [];
  const client: WorkspaceDeviceClient = connectWorkspaceDevice({
    controlUrl: w.ws + WORKSPACE_CONTROL_PATH, runUrl: w.ws + WORKSPACE_RUN_PATH,
    device: identity, serverId: w.relay.identity.id, serverKey: w.relay.identity.publicKey,
    askUser: async (run) => { asked.push(run.runId); return { tools: ['file_read', 'file_list', 'file_write', 'file_delete'], label: 'my-project' }; },
    open: async (consent) => createWorkspaceExecutor({
      registry: new ToolRegistry({
        shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, processJail: 'off', enabledTools: [...WORKSPACE_TOOLS],
      } as never, dir),
      tools: consent.tools,
      // A risky call (a delete) waits for the person, who never answers here.
      ask: () => new Promise<boolean>(() => {}),
      checkpoints: { begin: async () => ({ n: 1 }), end: async () => undefined },
    }),
  });
  cleanup.push(() => client.close());
  await client.ready;
  await vi.waitFor(() => expect(w.relay.hub.deviceOnline(owner.id, device.id)).toBe(true));
  return { device, client, dir, asked };
}

/** Dials a control endpoint and answers the challenge as the device with this key. */
async function dial(base: string, pathname: string, identity: ReturnType<typeof relayIdentityFromPrivateKey>, serverId: string): Promise<{ ws: WebSocket; welcomed: boolean }> {
  const { signHello } = await import('../../../src/browser/relay/capability.js');
  const ws = new WebSocket(base + pathname);
  return await new Promise((resolve) => {
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as { t: string; challenge: string };
      if (f.t === 'challenge') ws.send(JSON.stringify({ v: 1, t: 'hello', deviceId: identity.id, sig: signHello(identity, serverId, f.challenge) }));
      if (f.t === 'welcome') resolve({ ws, welcomed: true });
    });
    ws.once('close', () => resolve({ ws, welcomed: false }));
    ws.once('error', () => resolve({ ws, welcomed: false }));
  });
}

describe('who may connect to the workspace relay', () => {
  it('a registered desktop proves its key and is welcomed; the same key serves the browser relay too', async () => {
    const w = await server({ browserRelay: true });
    const alice = w.user('alice');
    const { device, identity } = w.register(alice.id, 'Work PC');
    const ws = await dial(w.ws, WORKSPACE_CONTROL_PATH, identity, w.relay.identity.id);
    cleanup.push(() => ws.ws.close());
    expect(ws.welcomed).toBe(true);
    expect(w.relay.hub.deviceOnline(alice.id, device.id)).toBe(true);
    // The same registered key, at the browser relay's endpoint (same server identity): welcomed there too.
    const browser = await dial(w.ws, RELAY_CONTROL_PATH, identity, w.relay.identity.id);
    cleanup.push(() => browser.ws.close());
    expect(browser.welcomed).toBe(true);
  });

  it('refuses a device that is not a desktop: the CLI and an extension never serve a folder', async () => {
    const w = await server();
    const alice = w.user('alice');
    for (const kind of ['cli', 'extension'] as const) {
      const { device, identity } = w.register(alice.id, `a ${kind}`, kind);
      const ws = await dial(w.ws, WORKSPACE_CONTROL_PATH, identity, w.relay.identity.id);
      cleanup.push(() => ws.ws.close());
      expect(ws.welcomed, kind).toBe(false);
      expect(w.relay.hub.deviceOnline(alice.id, device.id)).toBe(false);
    }
  });

  it('refuses a key the server never registered', async () => {
    const w = await server();
    const stranger = relayIdentityFromPrivateKey('dev-unknown', generateRelayKey().privateKeyPem);
    const ws = await dial(w.ws, WORKSPACE_CONTROL_PATH, stranger, w.relay.identity.id);
    expect(ws.welcomed).toBe(false);
  });

  it('a browser-relay connection is not on the workspace relay: the paths are its own', async () => {
    const w = await server({ browserRelay: true });
    const alice = w.user('alice');
    const { device, identity } = w.register(alice.id, 'Work PC');
    const browser = await dial(w.ws, RELAY_CONTROL_PATH, identity, w.relay.identity.id);
    cleanup.push(() => browser.ws.close());
    expect(browser.welcomed).toBe(true);
    // Online at the browser hub only.
    expect(w.relay.hub.deviceOnline(alice.id, device.id)).toBe(false);
  });
});

describe('listing the desktops', () => {
  it('needs a signed-in user', async () => {
    const w = await server();
    expect((await w.api(WORKSPACE_DEVICES_PATH)).status).toBe(401);
  });

  it("shows the user's own desktops with whether each is serving now, and nothing secret", async () => {
    const w = await server();
    const alice = w.user('alice');
    const bob = w.user('bob');
    const online = await desktop(w, alice, 'Work PC');
    const offline = w.register(alice.id, 'Home PC');
    w.register(alice.id, 'A CLI', 'cli');
    w.register(bob.id, "Bob's PC");
    const res = await w.api(WORKSPACE_DEVICES_PATH, alice.cookie);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { devices: Array<Record<string, unknown>> };
    expect(body.devices.map((d) => [d.name, d.online]).sort()).toEqual([['Home PC', false], ['Work PC', true]]);
    expect(body.devices.every((d) => Object.keys(d).sort().join() === 'id,name,online')).toBe(true);
    expect(body.devices.map((d) => d.id).sort()).toEqual([online.device.id, offline.device.id].sort());
    expect(raw).not.toMatch(/publicKey|PRIVATE|path|folder/i);
  });

  it('is absent when the relay is off: no route exists to answer', async () => {
    const dir = tmpDir();
    const store = new CloudStore(path.join(dir, 'cloud.db'));
    cleanup.push(() => store.close());
    const app = express();
    const httpServer = http.createServer(app);
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    cleanup.push(() => { httpServer.closeAllConnections(); httpServer.close(); });
    const port = (httpServer.address() as AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${port}${WORKSPACE_DEVICES_PATH}`)).status).toBe(404);
    // And nothing listens for a device: the upgrade is not taken.
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WORKSPACE_CONTROL_PATH}`);
    expect(await new Promise<boolean>((r) => { ws.once('open', () => r(true)); ws.once('error', () => r(false)); ws.once('close', () => r(false)); })).toBe(false);
  });
});

describe('a run that asks for a workspace', () => {
  it("opens the desktop's tools for the run, and a call round-trips to the folder on that machine", async () => {
    const w = await server();
    const alice = w.user('alice');
    const m = await desktop(w, alice);
    const lease = await openWorkspaceForRun(w.relay, w.store, { userId: alice.id, deviceId: m.device.id, runId: 'run-1' });
    cleanup.push(() => lease.release());
    expect(lease.remote.label).toBe('my-project');
    expect(lease.remote.tools.map((t) => t.name).sort()).toEqual(['file_delete', 'file_list', 'file_read', 'file_write']);
    const run = (name: string, input: Record<string, unknown>) => lease.remote.tools.find((t) => t.name === name)!.execute(input, { tierId: 't3-1', sessionId: 's', requireApproval: false });
    expect(await run('file_read', { path: 'README.md' })).toContain('hello from the machine');
    await run('file_write', { path: 'out.txt', content: 'from the cloud run' });
    expect(fs.readFileSync(path.join(m.dir, 'out.txt'), 'utf8')).toBe('from the cloud run');
    // The change reporting reaches the run through the relay too.
    await run('file_read', { path: 'out.txt' });
    fs.writeFileSync(path.join(m.dir, 'out.txt'), 'edited on the machine, a longer text');
    expect(await run('file_list', { path: '.' })).toMatch(/changed since you read them: out\.txt/);
    expect(m.asked).toEqual(['run-1']);
  });

  it('an offline desktop is a clear error, not a run with no tools', async () => {
    const w = await server();
    const alice = w.user('alice');
    const { device } = w.register(alice.id, 'Home PC');
    await expect(openWorkspaceForRun(w.relay, w.store, { userId: alice.id, deviceId: device.id, runId: 'r' })).rejects.toThrow(/"Home PC" is not serving workspaces right now/);
  });

  it("another user's desktop, a CLI, and an unknown id all read the same: not one of your desktop devices", async () => {
    const w = await server();
    const alice = w.user('alice');
    const bob = w.user('bob');
    const theirs = await desktop(w, bob);
    const cli = w.register(alice.id, 'A CLI', 'cli');
    for (const id of [theirs.device.id, cli.device.id, 'nope']) {
      await expect(openWorkspaceForRun(w.relay, w.store, { userId: alice.id, deviceId: id, runId: 'r' })).rejects.toThrow(WorkspaceRunError);
    }
    expect(theirs.asked).toEqual([]);
  });

  it('a no on the machine fails the start with its reason', async () => {
    const w = await server();
    const alice = w.user('alice');
    const { device, identity } = w.register(alice.id, 'Work PC');
    const client = connectWorkspaceDevice({
      controlUrl: w.ws + WORKSPACE_CONTROL_PATH, runUrl: w.ws + WORKSPACE_RUN_PATH,
      device: identity, serverId: w.relay.identity.id, serverKey: w.relay.identity.publicKey,
      askUser: async () => null, open: async () => { throw new Error('unreachable'); },
    });
    cleanup.push(() => client.close());
    await client.ready;
    await vi.waitFor(() => expect(w.relay.hub.deviceOnline(alice.id, device.id)).toBe(true));
    await expect(openWorkspaceForRun(w.relay, w.store, { userId: alice.id, deviceId: device.id, runId: 'r' })).rejects.toThrow(/did not open a workspace for this run: .*declined/);
  });

  it('stopping the run while the machine is still asking withdraws the offer and ends the start at once', async () => {
    const w = await server();
    const alice = w.user('alice');
    const { device, identity } = w.register(alice.id, 'Work PC');
    let asked = 0;
    let cancelled = false;
    const client = connectWorkspaceDevice({
      controlUrl: w.ws + WORKSPACE_CONTROL_PATH, runUrl: w.ws + WORKSPACE_RUN_PATH,
      device: identity, serverId: w.relay.identity.id, serverKey: w.relay.identity.publicKey,
      // The user never answers; the offer being withdrawn is what closes the question.
      askUser: async ({ signal }) => {
        asked++;
        return new Promise((resolve) => signal.addEventListener('abort', () => { cancelled = true; resolve(null); }, { once: true }));
      },
      open: async () => { throw new Error('unreachable'); },
    });
    cleanup.push(() => client.close());
    await client.ready;
    await vi.waitFor(() => expect(w.relay.hub.deviceOnline(alice.id, device.id)).toBe(true));
    const stop = new AbortController();
    const started = openWorkspaceForRun(w.relay, w.store, { userId: alice.id, deviceId: device.id, runId: 'r-stop', signal: stop.signal });
    await vi.waitFor(() => expect(asked).toBe(1));
    const t0 = Date.now();
    stop.abort();
    await expect(started).rejects.toThrow(/stopped before its workspace opened/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('the workspace ends with the run: stopping it closes the machine\'s session, and the machine dropping ends the run\'s', async () => {
    const w = await server();
    const alice = w.user('alice');
    const m = await desktop(w, alice);
    const stop = new AbortController();
    const lease = await openWorkspaceForRun(w.relay, w.store, { userId: alice.id, deviceId: m.device.id, runId: 'r1', signal: stop.signal });
    await vi.waitFor(() => expect(m.client.serving()?.runId).toBe('r1'));
    stop.abort();
    await expect(lease.remote.closed).resolves.toMatch(/stopped/);
    await vi.waitFor(() => expect(m.client.serving()).toBeNull());
    // A call after it is a clear error.
    await expect(lease.remote.tools[0]!.execute({ path: '.' }, { tierId: 't', sessionId: 's', requireApproval: false })).rejects.toThrow(/no longer available/);

    // The machine's side going away mid-run ends the run's workspace, and pending calls fail.
    const again = await openWorkspaceForRun(w.relay, w.store, { userId: alice.id, deviceId: m.device.id, runId: 'r2' });
    await vi.waitFor(() => expect(m.client.serving()?.runId).toBe('r2'));
    m.client.stop('closed on the machine');
    await expect(again.remote.closed).resolves.toBeTruthy();
  });
});

describe('a run started with workspaceDeviceId', () => {
  /** Runs a turn against the stub model with this server's relay (or none). */
  async function runTurn(w: World, userId: string, deviceId: string, opts: { relay?: boolean; stub: StubOpenAIServer; signal?: AbortSignal; socket?: FakeSocket }) {
    const env = loadEnv({
      PORT: '8787', SESSION_SECRET: 'x'.repeat(20), DATA_DIR: w.dir, WEB_ORIGIN: 'http://localhost:5173',
      OAUTH_REDIRECT_BASE_URL: 'http://localhost:8787', MAX_COST_PER_RUN_USD: '1', ...(opts.relay === false ? {} : { WORKSPACE_RELAY: '1' }),
    });
    const socket = opts.socket ?? new FakeSocket();
    const payload = parseChatRunPayload({
      prompt: 'hello', runId: 'client-run-1', workspaceDeviceId: deviceId,
      providers: [{ type: 'openai-compatible', baseUrl: opts.stub.url, apiKey: 'test-key', model: 'stub-model' }],
    });
    return { socket, result: runChatTurn(payload, {
      env, store: w.store, userId, socket: socket as unknown as import('socket.io').Socket,
      ...(opts.relay === false ? {} : { workspaceRelay: w.relay }), ...(opts.signal ? { signal: opts.signal } : {}),
    }) };
  }

  it('registers the desktop\'s tools in the run, tells the web app, and closes the workspace when the run is over', async () => {
    const w = await server();
    const alice = w.user('alice');
    const m = await desktop(w, alice);
    const stub = await startStubOpenAIServer();
    cleanup.push(() => stub.close());
    const registered: string[][] = [];
    const original = Cascade.prototype.addRemoteTools;
    const spy = vi.spyOn(Cascade.prototype, 'addRemoteTools').mockImplementation(function (this: InstanceType<typeof Cascade>, tools) {
      registered.push(tools.map((t) => t.name).sort());
      return original.call(this, tools);
    });
    cleanup.push(() => spy.mockRestore());
    const { socket, result } = await runTurn(w, alice.id, m.device.id, { stub });
    expect((await result).output).toContain('Hello from the stub model.');
    expect(registered).toEqual([['file_delete', 'file_list', 'file_read', 'file_write']]);
    const attached = socket.named('workspace:attached');
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ runId: 'client-run-1', label: 'my-project', device: { id: m.device.id, name: 'Work PC' } });
    expect(JSON.stringify(socket.events)).not.toContain(m.dir);
    // Over with the run: the machine's session ended, and the web app was told.
    await vi.waitFor(() => expect(m.client.serving()).toBeNull());
    await vi.waitFor(() => expect(socket.named('workspace:detached')).toHaveLength(1));
  }, 30_000);

  it('stopping the run mid-flight closes the workspace', async () => {
    const w = await server();
    const alice = w.user('alice');
    const m = await desktop(w, alice);
    const stub = await startStubOpenAIServer({ delayMs: 3000 });
    cleanup.push(() => stub.close());
    const stop = new AbortController();
    const { socket, result } = await runTurn(w, alice.id, m.device.id, { stub, signal: stop.signal });
    await vi.waitFor(() => expect(m.client.serving()).not.toBeNull(), { timeout: 10_000 });
    await vi.waitFor(() => expect(socket.named('workspace:attached')).toHaveLength(1));
    stop.abort();
    await result.catch(() => undefined);
    await vi.waitFor(() => expect(m.client.serving()).toBeNull());
    await vi.waitFor(() => expect(socket.named('workspace:detached')).toHaveLength(1));
  }, 30_000);

  it('forwards "waiting for approval on the machine" to the web app, with the tool and no input', async () => {
    const w = await server();
    const alice = w.user('alice');
    const m = await desktop(w, alice);
    const stub = await startStubOpenAIServer({ delayMs: 3000 });
    cleanup.push(() => stub.close());
    const original = Cascade.prototype.addRemoteTools;
    let tools: Parameters<typeof original>[0] = [];
    const spy = vi.spyOn(Cascade.prototype, 'addRemoteTools').mockImplementation(function (this: InstanceType<typeof Cascade>, t) { tools = t; return original.call(this, t); });
    cleanup.push(() => spy.mockRestore());
    const stop = new AbortController();
    const { socket, result } = await runTurn(w, alice.id, m.device.id, { stub, signal: stop.signal });
    await vi.waitFor(() => expect(tools.length).toBeGreaterThan(0), { timeout: 10_000 });
    // A delete is risky: the machine asks its person, and the web app is told it is waiting.
    const pending = tools.find((t) => t.name === 'file_delete')!.execute({ path: 'README.md' }, { tierId: 't', sessionId: 's', requireApproval: false, signal: stop.signal });
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(socket.named('workspace:waiting')).toHaveLength(1), { timeout: 10_000 });
    expect(socket.named('workspace:waiting')[0]).toMatchObject({ runId: 'client-run-1', tool: 'file_delete', label: 'my-project' });
    expect(JSON.stringify(socket.named('workspace:waiting'))).not.toContain('README');
    stop.abort();
    await result.catch(() => undefined);
    expect(fs.existsSync(path.join(m.dir, 'README.md'))).toBe(true);
  }, 30_000);

  it('an offline desktop fails the start with a clear message, before anything is saved', async () => {
    const w = await server();
    const alice = w.user('alice');
    const { device } = w.register(alice.id, 'Home PC');
    const stub = await startStubOpenAIServer();
    cleanup.push(() => stub.close());
    const { result } = await runTurn(w, alice.id, device.id, { stub });
    await expect(result).rejects.toThrow(/"Home PC" is not serving workspaces right now/);
    expect(w.store.listConversations(alice.id)).toHaveLength(0);
    expect(stub.requestLog.filter((l) => l.includes('chat/completions'))).toHaveLength(0);
  }, 30_000);

  it('with the relay off, the run is refused with a clear message, not started with no tools', async () => {
    const w = await server();
    const alice = w.user('alice');
    const stub = await startStubOpenAIServer();
    cleanup.push(() => stub.close());
    const { result } = await runTurn(w, alice.id, 'any-device', { stub, relay: false });
    await expect(result).rejects.toThrow(/not turned on for this server/);
    expect(w.store.listConversations(alice.id)).toHaveLength(0);
  }, 30_000);
});

describe('what the server logs', () => {
  it('nothing of a call: no file contents, paths or output reach the console while a run works', async () => {
    const w = await server();
    const alice = w.user('alice');
    const m = await desktop(w, alice);
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); }));
    cleanup.push(() => spies.forEach((s) => s.mockRestore()));
    const lease = await openWorkspaceForRun(w.relay, w.store, { userId: alice.id, deviceId: m.device.id, runId: 'r' });
    cleanup.push(() => lease.release());
    await lease.remote.tools.find((t) => t.name === 'file_read')!.execute({ path: 'README.md' }, { tierId: 't', sessionId: 's', requireApproval: false });
    await lease.remote.tools.find((t) => t.name === 'file_read')!.execute({ path: 'missing.txt' }, { tierId: 't', sessionId: 's', requireApproval: false }).catch(() => undefined);
    const text = logs.join('\n');
    expect(text).not.toContain('hello from the machine');
    expect(text).not.toContain('README.md');
    expect(text).not.toContain('missing.txt');
    expect(text).not.toContain(m.dir);
  });
});
