// The relay's setup, before there's a browser to test against.

import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
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
