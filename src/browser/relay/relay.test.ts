// The relay's setup, before there's a browser to test against.

import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { makeConsent } from './egress-rules.js';
import { createDeviceRelay } from './relay.js';
import type { RequestEnforcer } from './request-enforcer.js';
import { createTabLease } from './tab-lease.js';

const enforcer = {
  decisions: [], closedPages: [], children: [], dismissedDialogs: [],
  checkTabBeforeLease: async () => ({ ok: true as const }),
  clearForeignHistory: async () => true,
  onForeignDocument: () => {},
  endPageActivity: async () => true,
  close: () => {},
} satisfies RequestEnforcer;

function fakeAgent() {
  const agent = new EventEmitter() as EventEmitter & { closed?: number; close(code: number): void; readyState: number; OPEN: number };
  agent.readyState = 1;
  agent.OPEN = 1;
  agent.close = (code) => { agent.closed = code; };
  return agent;
}

function setup(tabWs: string, over: Partial<RequestEnforcer> = {}) {
  const lease = createTabLease();
  lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 });
  const relay = createDeviceRelay({ tabWs, consent: makeConsent(['https://a.test']), lease, enforcer: { ...enforcer, ...over }, pageEnd: 'close' });
  return { lease, relay, agent: fakeAgent() };
}

async function tabServer(): Promise<{ url: string; close(): void }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, close: () => wss.close() };
}

describe('the relay while it connects to the tab', () => {
  for (const event of ['close', 'error']) {
    it(`an agent ${event} during connecting ends the lease, and doesn't go unheard`, async () => {
      const tab = await tabServer();
      try {
        const { lease, relay, agent } = setup(tab.url);
        const served = relay.serve(agent as unknown as WebSocket);
        // Emitting 'error' with no listener would throw here.
        agent.emit(event, new Error('gone'));
        await served;
        expect(lease.state()).toBe('idle');
      } finally { tab.close(); }
    });
  }

  it('a tab that cannot be reached ends the lease and closes the agent', async () => {
    const tab = await tabServer();
    tab.close();
    const { lease, relay, agent } = setup(tab.url);
    await relay.serve(agent as unknown as WebSocket);
    expect(lease.state()).toBe('idle');
    expect(agent.closed).toBe(1011);
  });
});

describe('the relay before it serves any command', () => {
  const cases: [string, Partial<RequestEnforcer>, string][] = [
    ['history it could not clear', { clearForeignHistory: async () => false }, 'could not be cleared'],
    ['a check that fails', { checkTabBeforeLease: async () => { throw new Error('no'); } }, 'could not be checked'],
    ['a tab that never answers', { clearForeignHistory: () => new Promise(() => {}) }, 'did not answer'],
  ];
  for (const [name, over, why] of cases) {
    it(`${name} ends the lease`, async () => {
      const tab = await tabServer();
      try {
        const { lease, relay, agent } = setup(tab.url, over);
        await relay.serve(agent as unknown as WebSocket);
        expect(lease.state()).toBe('idle');
        expect(relay.refusals.join()).toContain(why);
      } finally { tab.close(); }
    });
  }
});

/** A tab that holds each handshake until let go, logs every frame and answers each command. */
async function heldTab(): Promise<{ url: string; frames: string[]; arrived: Promise<void>; letGo(accept?: boolean): void; close(): void }> {
  const frames: string[] = [];
  const holds: (() => void)[] = [];
  let arrivedOnce!: () => void;
  const arrived = new Promise<void>((r) => { arrivedOnce = r; });
  let held = true;
  let accepting = true;
  const wss = new WebSocketServer({
    port: 0, host: '127.0.0.1',
    verifyClient: (_info, cb) => { if (!held) { cb(true); return; } holds.push(() => cb(accepting, 503)); arrivedOnce(); },
  });
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    frames.push(String(raw));
    const { id } = JSON.parse(String(raw)) as { id: number };
    ws.send(JSON.stringify({ id, result: { result: { type: 'number', value: 1 } } }));
  }));
  await new Promise((r) => wss.once('listening', r));
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, frames, arrived,
    letGo: (accept = true) => { held = false; accepting = accept; for (const h of holds.splice(0)) h(); },
    close: () => wss.close(),
  };
}

const evaluate = (id: number) => JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'cascade-tab-1' });
const sent = (agent: ReturnType<typeof fakeAgent>) => {
  const out: string[] = [];
  (agent as unknown as { send(s: string): void }).send = (s) => { out.push(s); };
  return out;
};
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('a connection is pinned to the lease it started under', () => {
  it('a revoke and a new grant while the tab is being reached: the old connection never runs under the new lease', async () => {
    const tab = await heldTab();
    try {
      const { lease, relay, agent } = setup(tab.url);
      const served = relay.serve(agent as unknown as WebSocket);
      await tab.arrived;
      lease.revoke('user revoked');
      const fenceB = lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 })!;
      agent.emit('message', evaluate(1));
      tab.letGo();
      await served;
      agent.emit('message', evaluate(2));
      await settle();
      expect(tab.frames).toEqual([]);
      expect(agent.closed).toBe(1011);
      expect(lease.isCurrent(fenceB)).toBe(true);

      // B is untouched and usable on the same tab.
      const relayB = createDeviceRelay({ tabWs: tab.url, consent: makeConsent(['https://a.test']), lease, enforcer, pageEnd: 'close' });
      const agentB = fakeAgent();
      const outB = sent(agentB);
      void relayB.serve(agentB as unknown as WebSocket);
      agentB.emit('message', evaluate(1));
      await vi.waitFor(() => expect(outB.some((s) => (JSON.parse(s) as { id?: number }).id === 1)).toBe(true));
      expect(tab.frames.map((f) => (JSON.parse(f) as { method: string }).method)).toEqual(['Runtime.evaluate']);
      expect(agentB.closed).toBeUndefined();
      lease.revoke('done');
    } finally { tab.close(); }
  });

  it('a revoke and a new grant while the tab is being checked: the old connection ends, the new lease is untouched', async () => {
    const tab = await heldTab();
    tab.letGo();
    try {
      let check!: () => void;
      const checking = new Promise<void>((r) => { check = r; });
      let checked!: () => void;
      const started = new Promise<void>((r) => { checked = r; });
      const { lease, relay, agent } = setup(tab.url, {
        checkTabBeforeLease: async () => { checked(); await checking; return { ok: true as const }; },
      });
      const served = relay.serve(agent as unknown as WebSocket);
      agent.emit('message', evaluate(1));
      await started;
      lease.revoke('user revoked');
      const fenceB = lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 })!;
      check();
      await served;
      agent.emit('message', evaluate(2));
      await settle();
      expect(tab.frames).toEqual([]);
      expect(agent.closed).toBe(1011);
      expect(lease.isCurrent(fenceB)).toBe(true);
      lease.revoke('done');
    } finally { tab.close(); }
  });

  it('a connection that starts with no lease held is refused at once', async () => {
    const lease = createTabLease();
    const relay = createDeviceRelay({ tabWs: 'ws://127.0.0.1:1/', consent: makeConsent(['https://a.test']), lease, enforcer, pageEnd: 'close' });
    const agent = fakeAgent();
    await relay.serve(agent as unknown as WebSocket);
    expect(agent.closed).toBe(1011);
    expect(lease.state()).toBe('idle');
  });

  it("a tab that can't be reached doesn't revoke a lease granted since", async () => {
    const tab = await heldTab();
    try {
      const { lease, relay, agent } = setup(tab.url);
      const served = relay.serve(agent as unknown as WebSocket);
      await tab.arrived;
      lease.revoke('user revoked');
      const fenceB = lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 })!;
      tab.letGo(false);
      await served;
      expect(relay.refusals.join()).toContain('could not reach the tab');
      expect(lease.isCurrent(fenceB)).toBe(true);
      lease.revoke('done');
    } finally { tab.close(); }
  });
});
