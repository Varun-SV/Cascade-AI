// The server's side of the relay, over real sockets, with a device that signs for real.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  type ApprovalPayload, type GrantPayload, type Identity, type NonceStore, type Signed,
  StoreOutcomeUnknown, StoreUnavailable, createDeviceApprovals, createIdentity, createMemoryNonceStore, signHello,
} from './capability.js';
import { type ClaimReply, type ControlFrame, PENDING_BYTES_MAX, RelayRefused, type RelayHub, authenticateControl, createRelayHub } from './hub.js';

const scope = { tabTargetId: 'tab-1', allowedOrigins: ['https://ok.test'], privateOrigins: [] };
const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

/** The hub behind a real server, routed the way the cloud server routes it. */
async function world(over: { store?: NonceStore; offerTimeoutMs?: number; agentAttachTimeoutMs?: number; now?: () => number } = {}) {
  const server = createIdentity('server');
  const keys = new Map<string, Identity>();
  /** The server's own record of whose device each is. */
  const owners = new Map<string, string>();
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
    if (url.pathname === '/control') {
      void authenticateControl(ws, {
        serverId: server.id, timeoutMs: 500,
        device: (id) => (owners.has(id) && keys.has(id) ? { userId: owners.get(id)!, key: keys.get(id)!.publicKey } : null),
      }).then((who) => { if (who) hub.attachDevice(who, ws); });
    }
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
  return { hub, server, device, open, base, owners, forget: (id: string) => { keys.delete(id); } };
}

const next = (ws: WebSocket): Promise<string> => new Promise((res) => ws.once('message', (d) => res(String(d))));
const closedWith = (ws: WebSocket): Promise<number> => new Promise((res) => (ws.readyState === ws.CLOSED ? res(0) : ws.once('close', (c) => res(c))));

/** A device: its control connection, and how it answers an offer. */
async function connectDevice(w: Awaited<ReturnType<typeof world>>, userId: string, id: Identity) {
  w.owners.set(id.id, userId);
  const control = new WebSocket(`${w.base}/control`);
  const offers: Signed<GrantPayload>[] = [];
  const waiters: ((g: Signed<GrantPayload>) => void)[] = [];
  const cancels: string[] = [];
  let welcomed!: () => void;
  const welcome = new Promise<void>((r) => { welcomed = r; });
  control.on('message', (d) => {
    const f = JSON.parse(String(d)) as ControlFrame;
    if (f.t === 'challenge') { control.send(JSON.stringify({ v: 1, t: 'hello', deviceId: id.id, sig: signHello(id, f.serverId, f.challenge) })); return; }
    if (f.t === 'welcome') { welcomed(); return; }
    if (f.t === 'cancel') { cancels.push(f.nonce); return; }
    const w2 = waiters.shift();
    if (w2) w2(f.grant); else offers.push(f.grant);
  });
  await welcome;
  await vi.waitFor(() => expect(w.hub.deviceOnline(userId, id.id)).toBe(true));
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
    expect(theft.reply).toMatchObject({ v: 1, t: 'refused', reason: 'bad approval signature' });
    const honest = await a.claim(grant, a.approve(grant));
    expect(honest.reply.t).toBe('claimed');
    await asked;
  });

  it('a claim for a grant nobody is waiting on is refused', async () => {
    const w = await world();
    const { d, grant } = await leased(w);
    // The same grant again, after it was claimed.
    const again = await d.claim(grant, d.approve(grant));
    expect(again.reply).toMatchObject({ v: 1, t: 'refused', reason: 'no such request' });
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

  it('a device whose key was unregistered while it was connected is not asked', async () => {
    const w = await world();
    await connectDevice(w, 'user-a', w.device('device-x'));
    w.forget('device-x');
    expect(await refusal(w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-x', runId: 'run-1' }))).toBe('the device is not registered');
  });

  it('a malformed or oversized claim is refused', async () => {
    const w = await world();
    for (const frame of ['not json', JSON.stringify({ v: 1, t: 'claim' }), JSON.stringify({ v: 2, t: 'claim', grant: {}, approval: {} }), 'x'.repeat(70_000)]) {
      const run = await w.open('/run');
      const reply = next(run);
      run.send(frame);
      expect(JSON.parse(await reply)).toMatchObject({ v: 1, t: 'refused', reason: 'malformed claim' });
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
      expect(reply).toMatchObject({ v: 1, t: 'refused', reason });
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

describe('who is on a control connection', () => {
  /** A raw control connection that answers the challenge however it's told to. */
  async function raw(w: Awaited<ReturnType<typeof world>>, answer: (f: Extract<ControlFrame, { t: 'challenge' }>) => object | string | null) {
    const ws = new WebSocket(`${w.base}/control`);
    const frames: ControlFrame[] = [];
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as ControlFrame;
      frames.push(f);
      if (f.t !== 'challenge') return;
      const reply = answer(f);
      if (reply !== null) ws.send(typeof reply === 'string' ? reply : JSON.stringify(reply));
    });
    const code = await closedWith(ws);
    return { code, frames };
  }

  it("a device is its registered key, and the user is the server's record, not the device's word", async () => {
    const w = await world();
    const id = w.device('device-a');
    await connectDevice(w, 'user-a', id);
    expect(w.hub.deviceOnline('user-a', 'device-a')).toBe(true);
    expect(w.hub.deviceOnline('user-b', 'device-a')).toBe(false);
  });

  const bad: [string, (w: Awaited<ReturnType<typeof world>>, id: Identity) => (f: Extract<ControlFrame, { t: 'challenge' }>) => object | string | null][] = [
    ['a signature from another key', (w) => (f) => ({ v: 1, t: 'hello', deviceId: 'device-a', sig: signHello({ ...createIdentity('device-a') }, f.serverId, f.challenge) })],
    ['a signature over another challenge', (_w, id) => (f) => ({ v: 1, t: 'hello', deviceId: 'device-a', sig: signHello(id, f.serverId, 'another-challenge') })],
    ['a signature made for another server', (_w, id) => (f) => ({ v: 1, t: 'hello', deviceId: 'device-a', sig: signHello(id, 'another-server', f.challenge) })],
    ["another device's name on a good signature", (w) => (f) => { const b = w.device('device-b'); w.owners.set('device-b', 'user-b'); return { v: 1, t: 'hello', deviceId: 'device-a', sig: signHello(b, f.serverId, f.challenge) }; }],
    ['a device the server has no record of', () => (f) => { const x = createIdentity('device-x'); return { v: 1, t: 'hello', deviceId: 'device-x', sig: signHello(x, f.serverId, f.challenge) }; }],
    ['no signature', () => () => ({ v: 1, t: 'hello', deviceId: 'device-a' })],
    ['something that is not a hello', () => () => 'not json'],
    ['no answer at all', () => () => null],
  ];
  for (const [name, make] of bad) {
    it(`${name} is refused, and never becomes a device`, async () => {
      const w = await world();
      const id = w.device('device-a');
      w.owners.set('device-a', 'user-a');
      const { code, frames } = await raw(w, make(w, id));
      expect(code).toBe(1008);
      expect(frames.map((f) => f.t)).toEqual(['challenge']);
      expect(w.hub.deviceOnline('user-a', 'device-a')).toBe(false);
      await expect(w.hub.requestBrowser({ userId: 'user-a', deviceId: 'device-a', runId: 'run-1' })).rejects.toBeInstanceOf(RelayRefused);
    });
  }

  it('a signature seen on one connection is useless on the next', async () => {
    const w = await world();
    const id = w.device('device-a');
    w.owners.set('device-a', 'user-a');
    let captured: object | null = null;
    // A real device connects; someone on the path keeps what it sent.
    const ws = new WebSocket(`${w.base}/control`);
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as ControlFrame;
      if (f.t !== 'challenge') return;
      captured = { v: 1, t: 'hello', deviceId: 'device-a', sig: signHello(id, f.serverId, f.challenge) };
      ws.send(JSON.stringify(captured));
    });
    await vi.waitFor(() => expect(w.hub.deviceOnline('user-a', 'device-a')).toBe(true));
    ws.close();
    await vi.waitFor(() => expect(w.hub.deviceOnline('user-a', 'device-a')).toBe(false));
    const replay = await raw(w, () => captured);
    expect(replay.code).toBe(1008);
    expect(w.hub.deviceOnline('user-a', 'device-a')).toBe(false);
  });
});

describe('what waits for the run to connect is bounded in bytes (council review on 71cc8a1)', () => {
  it('a few small frames wait, and are counted', async () => {
    const w = await world();
    const { run } = await leased(w);
    run.send('x'.repeat(1000)); run.send('y'.repeat(1000));
    await vi.waitFor(() => expect(w.hub.waitingBytes()).toBe(2000));
  });

  it('one frame over the limit ends the lease, and nothing of it is kept', async () => {
    const w = await world();
    const { run, browser } = await leased(w);
    run.send('x'.repeat(PENDING_BYTES_MAX + 1));
    expect(await browser.closed).toBe('the device sent too much before the run connected');
    await closedWith(run);
    expect(w.hub.waitingBytes()).toBe(0);
  });

  it('frames that cross the limit together end the lease, with what was held released', async () => {
    const w = await world();
    const { run, browser } = await leased(w);
    const chunk = 'x'.repeat(Math.floor(PENDING_BYTES_MAX / 4));
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, w.hub.waitingBytes()); }, 1);
    for (let i = 0; i < 8; i++) run.send(chunk);
    expect(await browser.closed).toBe('the device sent too much before the run connected');
    clearInterval(watch);
    expect(peak).toBeLessThanOrEqual(PENDING_BYTES_MAX);
    expect(w.hub.waitingBytes()).toBe(0);
    // The token died with the lease.
    expect(await closedWith(await w.open(`/agent/${browser.token}`))).toBe(1008);
  });

  it('many small frames end the lease at the frame limit, well under the byte limit', async () => {
    const w = await world();
    const { run, browser } = await leased(w);
    for (let i = 0; i < 300; i++) run.send('x');
    expect(await browser.closed).toBe('the device sent too much before the run connected');
    expect(w.hub.waitingBytes()).toBe(0);
  });

  it('with no agent ever attaching, what is held stays bounded until the lease is taken back', async () => {
    const w = await world({ agentAttachTimeoutMs: 150 });
    const { run, browser } = await leased(w);
    run.send('x'.repeat(PENDING_BYTES_MAX - 10));
    await vi.waitFor(() => expect(w.hub.waitingBytes()).toBe(PENDING_BYTES_MAX - 10));
    expect(await browser.closed).toBe('the run never connected');
    expect(w.hub.waitingBytes()).toBe(0);
  });

  it('once the run is connected, frames pass straight through and nothing is held', async () => {
    const w = await world();
    const { run, browser } = await leased(w);
    const agent = await w.open(`/agent/${browser.token}`);
    const big = 'x'.repeat(PENDING_BYTES_MAX * 2);
    const got = next(agent);
    run.send(big);
    expect((await got).length).toBe(big.length);
    expect(w.hub.waitingBytes()).toBe(0);
  });
});
