// The server's side of the relay, over real sockets, with a device that signs for real.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  type ApprovalPayload, type GrantPayload, type Identity, type NonceStore, type Signed,
  StoreOutcomeUnknown, StoreUnavailable, createDeviceApprovals, createIdentity, createMemoryNonceStore,
} from './capability.js';
import { type ClaimReply, type ControlFrame, RelayRefused, type RelayHub, createRelayHub } from './hub.js';

const scope = { tabTargetId: 'tab-1', allowedOrigins: ['https://ok.test'], privateOrigins: [] };
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

/** The hub behind a real server, routed the way the cloud server routes it. */
async function world(over: { store?: NonceStore; offerTimeoutMs?: number; agentAttachTimeoutMs?: number; now?: () => number } = {}) {
  const server = createIdentity('server');
  const keys = new Map<string, Identity>();
  const device = (id: string): Identity => { const d = createIdentity(id); keys.set(id, d); return d; };
  const hub = createRelayHub({
    server, store: over.store ?? createMemoryNonceStore(over.now ?? Date.now), deviceKey: (id) => keys.get(id)?.publicKey ?? null,
    ...(over.now ? { now: over.now } : {}),
    ...(over.offerTimeoutMs ? { offerTimeoutMs: over.offerTimeoutMs } : {}),
    ...(over.agentAttachTimeoutMs ? { agentAttachTimeoutMs: over.agentAttachTimeoutMs } : {}),
  });
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/control') hub.attachDevice({ userId: url.searchParams.get('user')!, deviceId: url.searchParams.get('device')! }, ws);
    else if (url.pathname === '/run') hub.attachRun(ws);
    else if (url.pathname.startsWith('/agent/')) hub.attachAgent(url.pathname.slice('/agent/'.length), ws);
    else ws.close();
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  closers.push(() => { hub.close(); httpServer.closeAllConnections(); httpServer.close(); });
  const open = async (path: string): Promise<WebSocket> => {
    const ws = new WebSocket(base + path);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return ws;
  };
  return { hub, server, device, open, base };
}

const next = (ws: WebSocket): Promise<string> => new Promise((res) => ws.once('message', (d) => res(String(d))));
const closedWith = (ws: WebSocket): Promise<number> => new Promise((res) => (ws.readyState === ws.CLOSED ? res(0) : ws.once('close', (c) => res(c))));

/** A device: its control connection, and how it answers an offer. */
async function connectDevice(w: Awaited<ReturnType<typeof world>>, userId: string, id: Identity) {
  const control = await w.open(`/control?user=${userId}&device=${id.id}`);
  const offers: Signed<GrantPayload>[] = [];
  const waiters: ((g: Signed<GrantPayload>) => void)[] = [];
  const cancels: string[] = [];
  control.on('message', (d) => {
    const f = JSON.parse(String(d)) as ControlFrame;
    if (f.t === 'cancel') { cancels.push(f.nonce); return; }
    const w2 = waiters.shift();
    if (w2) w2(f.grant); else offers.push(f.grant);
  });
  const approvals = createDeviceApprovals({ device: id, serverId: w.server.id, serverKey: w.server.publicKey, now: Date.now });
  const offer = (): Promise<Signed<GrantPayload>> => (offers.length ? Promise.resolve(offers.shift()!) : new Promise((r) => waiters.push(r)));
  const approve = (grant: Signed<GrantPayload>): Signed<ApprovalPayload> => {
    const a = approvals.approve(grant, scope, 600_000);
    if ('refused' in a) throw new Error(a.refused);
    return a;
  };
  /** Opens the run connection and claims. Resolves with the socket and the server's reply. */
  const claim = async (grant: Signed<GrantPayload>, approval: Signed<ApprovalPayload>) => {
    const run = await w.open('/run');
    const reply = next(run);
    run.send(JSON.stringify({ v: 1, t: 'claim', grant, approval }));
    return { run, reply: JSON.parse(await reply) as ClaimReply };
  };
  return { control, offer, approve, claim, cancels, decline: (nonce: string) => control.send(JSON.stringify({ v: 1, t: 'decline', nonce })) };
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof RelayRefused) return e.reason; throw e; }
  throw new Error('was not refused');
};

async function leased(w: Awaited<ReturnType<typeof world>>, userId = 'user-a', deviceName = 'device-a', runId = 'run-1') {
  const id = w.device(deviceName);
  const d = await connectDevice(w, userId, id);
  const asked = w.hub.requestBrowser({ userId, deviceId: id.id, runId });
  const grant = await d.offer();
  const { run, reply } = await d.claim(grant, d.approve(grant));
  expect(reply).toEqual({ v: 1, t: 'claimed' });
  const browser = await asked;
  return { id, d, run, browser, grant };
}

describe('a run gets the browser of the device that approved it', () => {
  it('offer, approval and claim, then CDP frames pass both ways unchanged', async () => {
    const w = await world();
    const { run, browser } = await leased(w);
    const agent = await w.open(`/agent/${browser.token}`);
    const atDevice = next(run);
    agent.send('{"id":1,"method":"Browser.getVersion"}');
    expect(await atDevice).toBe('{"id":1,"method":"Browser.getVersion"}');
    const atAgent = next(agent);
    run.send('{"id":1,"result":{"product":"x"}}');
    expect(await atAgent).toBe('{"id":1,"result":{"product":"x"}}');
  });

  it('the grant names this server, user, device and run, and nothing more is sent to the device', async () => {
    const w = await world();
    const id = w.device('device-a');
    const d = await connectDevice(w, 'user-a', id);
    void w.hub.requestBrowser({ userId: 'user-a', deviceId: id.id, runId: 'run-9' }).catch(() => {});
    const grant = await d.offer();
    expect(grant.payload).toMatchObject({ iss: 'server', aud: 'device-a', userId: 'user-a', deviceId: 'device-a', runId: 'run-9' });
  });

  it('what the device sends before the run connects is kept in order, not lost', async () => {
    const w = await world();
    const { run, browser } = await leased(w);
    run.send('one'); run.send('two');
    await new Promise((r) => setTimeout(r, 50));
    const agent = new WebSocket(`${w.base}/agent/${browser.token}`);
    const got: string[] = [];
    agent.on('message', (d) => got.push(String(d)));
    await vi.waitFor(() => expect(got).toEqual(['one', 'two']));
  });
});

describe('routing is by grant, never by user alone', () => {
  it("user A's run is refused a device registered to user B, and that device is sent nothing", async () => {
    const w = await world();
    const b = await connectDevice(w, 'user-b', w.device('device-b'));
    let offered = false;
    void b.offer().then(() => { offered = true; });
    expect(await refusal(w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-b', runId: 'run-1' }))).toBe('the device is not connected');
    await new Promise((r) => setTimeout(r, 50));
    expect(offered).toBe(false);
    expect(w.hub.deviceOnline('user-a', 'device-b')).toBe(false);
    expect(w.hub.deviceOnline('user-b', 'device-b')).toBe(true);
  });

  it("another device's approval of A's grant is refused, and A's device can still claim", async () => {
    const w = await world();
    const a = await connectDevice(w, 'user-a', w.device('device-a'));
    const bId = w.device('device-b');
    const b = await connectDevice(w, 'user-b', bId);
    const asked = w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    const grant = await a.offer();
    // B saw the grant somehow, and signs an approval of it with its own key.
    const forged = createDeviceApprovals({ device: { ...bId, id: 'device-a' }, serverId: 'server', serverKey: w.server.publicKey, now: Date.now });
    const stolen = forged.approve(grant, scope, 600_000) as Signed<ApprovalPayload>;
    const theft = await b.claim(grant, stolen);
    expect(theft.reply).toEqual({ v: 1, t: 'refused', reason: 'bad approval signature' });
    const honest = await a.claim(grant, a.approve(grant));
    expect(honest.reply.t).toBe('claimed');
    await asked;
  });

  it('a claim for a grant nobody is waiting on is refused', async () => {
    const w = await world();
    const { d, grant } = await leased(w);
    // The same grant again, after it was claimed.
    const again = await d.claim(grant, d.approve(grant));
    expect(again.reply).toEqual({ v: 1, t: 'refused', reason: 'no such request' });
    expect(await closedWith(again.run)).toBe(1008);
  });

  it('two runs on two devices never cross', async () => {
    const w = await world();
    const one = await leased(w, 'user-a', 'device-a', 'run-1');
    const two = await leased(w, 'user-b', 'device-b', 'run-2');
    const agentOne = await w.open(`/agent/${one.browser.token}`);
    const agentTwo = await w.open(`/agent/${two.browser.token}`);
    const atOne = next(one.run);
    const atTwo = next(two.run);
    agentOne.send('for-one'); agentTwo.send('for-two');
    expect(await atOne).toBe('for-one');
    expect(await atTwo).toBe('for-two');
  });
});

describe('one capability, one connection', () => {
  it('the agent token works once', async () => {
    const w = await world();
    const { browser } = await leased(w);
    await w.open(`/agent/${browser.token}`);
    const second = await w.open(`/agent/${browser.token}`);
    expect(await closedWith(second)).toBe(1008);
  });

  it('a wrong token reaches nothing', async () => {
    const w = await world();
    await leased(w);
    const guess = await w.open('/agent/not-the-token');
    expect(await closedWith(guess)).toBe(1008);
  });

  for (const [name, drop] of [['the device', 'run'], ['the run', 'agent']] as const) {
    it(`${name} disconnecting ends the other side, and nothing resumes it`, async () => {
      const w = await world();
      const { run, browser, d, grant } = await leased(w);
      const agent = await w.open(`/agent/${browser.token}`);
      (drop === 'run' ? run : agent).close();
      await closedWith(drop === 'run' ? agent : run);
      expect(await browser.closed).toContain('disconnected');
      // Neither the old token nor the old grant gets back in.
      expect(await closedWith(await w.open(`/agent/${browser.token}`))).toBe(1008);
      expect((await d.claim(grant, d.approve(grant))).reply.t).toBe('refused');
    });
  }

  it('a run that never connects its agent loses the lease', async () => {
    const w = await world({ agentAttachTimeoutMs: 80 });
    const { run, browser } = await leased(w);
    expect(await browser.closed).toBe('the run never connected');
    await closedWith(run);
  });

  it('the lease ends when the grant expires, not only when it is claimed', async () => {
    const w = await world();
    const id = w.device('device-a');
    const d = await connectDevice(w, 'user-a', id);
    const asked = w.hub.requestBrowser({ userId: 'user-a', deviceId: id.id, runId: 'run-1', ttlMs: 400 });
    const grant = await d.offer();
    const { run, reply } = await d.claim(grant, d.approve(grant));
    expect(reply.t).toBe('claimed');
    const browser = await asked;
    const agent = await w.open(`/agent/${browser.token}`);
    expect(await browser.closed).toBe('the lease expired');
    await closedWith(run);
    await closedWith(agent);
  });
});

describe('a request that does not become a lease', () => {
  it('declined on the device', async () => {
    const w = await world();
    const d = await connectDevice(w, 'user-a', w.device('device-a'));
    const asked = w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    const grant = await d.offer();
    d.decline(grant.payload.nonce);
    expect(await refusal(asked)).toBe('the request was declined on the device');
    // And the grant is dead: approving it afterwards gets nothing.
    expect((await d.claim(grant, d.approve(grant))).reply.t).toBe('refused');
  });

  it("a device can't decline another device's offer", async () => {
    const w = await world();
    const a = await connectDevice(w, 'user-a', w.device('device-a'));
    const b = await connectDevice(w, 'user-b', w.device('device-b'));
    const asked = w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    const grant = await a.offer();
    b.decline(grant.payload.nonce);
    await new Promise((r) => setTimeout(r, 50));
    expect((await a.claim(grant, a.approve(grant))).reply.t).toBe('claimed');
    await asked;
  });

  it('nobody answers: the offer is withdrawn and the device is told', async () => {
    const w = await world({ offerTimeoutMs: 80 });
    const d = await connectDevice(w, 'user-a', w.device('device-a'));
    const asked = w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    const grant = await d.offer();
    expect(await refusal(asked)).toBe('the device did not answer in time');
    await vi.waitFor(() => expect(d.cancels).toEqual([grant.payload.nonce]));
  });

  it('the device goes offline before answering', async () => {
    const w = await world();
    const d = await connectDevice(w, 'user-a', w.device('device-a'));
    const asked = w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    await d.offer();
    d.control.close();
    expect(await refusal(asked)).toBe('the device went offline');
  });

  it('a device with no registered key is not asked', async () => {
    const w = await world();
    const stranger = createIdentity('device-x');
    await connectDevice(w, 'user-a', stranger);
    expect(await refusal(w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-x', runId: 'run-1' }))).toBe('the device is not registered');
  });

  it('a malformed or oversized claim is refused', async () => {
    const w = await world();
    for (const frame of ['not json', JSON.stringify({ v: 1, t: 'claim' }), JSON.stringify({ v: 2, t: 'claim', grant: {}, approval: {} }), 'x'.repeat(70_000)]) {
      const run = await w.open('/run');
      const reply = next(run);
      run.send(frame);
      expect(JSON.parse(await reply)).toEqual({ v: 1, t: 'refused', reason: 'malformed claim' });
    }
  });

  for (const [name, error, reason] of [
    ['is down', new StoreUnavailable(), 'nonce store unavailable'],
    ["can't say what happened", new StoreOutcomeUnknown(), 'claim outcome unknown'],
  ] as const) {
    it(`the nonce store ${name}: no lease, and the run is told why`, async () => {
      const w = await world({ store: { claimOnce: async () => { throw error; } } });
      const d = await connectDevice(w, 'user-a', w.device('device-a'));
      const asked = refusal(w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' }));
      const grant = await d.offer();
      const { reply } = await d.claim(grant, d.approve(grant));
      expect(reply).toEqual({ v: 1, t: 'refused', reason });
      expect(await asked).toBe(reason);
    });
  }
});

describe('what ends a lease from the server', () => {
  const cases: [string, (h: RelayHub) => void][] = [
    ['the run ending', (h) => h.endRun('run-1', 'the run ended')],
    ['the device being dropped (logout, token rotation, unregistered)', (h) => h.dropDevice('device-a', 'signed out')],
    ['the server closing', (h) => h.close()],
  ];
  for (const [name, act] of cases) {
    it(`${name} closes both sides`, async () => {
      const w = await world();
      const { run, browser } = await leased(w);
      const agent = await w.open(`/agent/${browser.token}`);
      act(w.hub);
      await closedWith(run);
      await closedWith(agent);
      await browser.closed;
    });
  }

  it('dropping a device also withdraws what it was offered and closes its control connection', async () => {
    const w = await world();
    const d = await connectDevice(w, 'user-a', w.device('device-a'));
    const asked = w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    await d.offer();
    w.hub.dropDevice('device-a', 'signed out');
    expect(await refusal(asked)).toBe('signed out');
    expect(await closedWith(d.control)).toBe(1008);
    expect(w.hub.deviceOnline('user-a', 'device-a')).toBe(false);
  });

  it('a device connecting again replaces its old control connection', async () => {
    const w = await world();
    const id = w.device('device-a');
    const first = await connectDevice(w, 'user-a', id);
    const second = await connectDevice(w, 'user-a', id);
    await closedWith(first.control);
    const asked = w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' });
    const grant = await second.offer();
    expect((await second.claim(grant, second.approve(grant))).reply.t).toBe('claimed');
    await asked;
  });
});
