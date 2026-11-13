// The relay's setup, before there's a browser to test against.

import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { makeConsent } from './egress-rules.js';
import { createDeviceRelay } from './relay.js';
import type { PageEndMode, RequestEnforcer } from './request-enforcer.js';
import { acquireLease, createTabLease } from './tab-lease.js';

const enforcer = {
  decisions: [], closedPages: [], children: [], dismissedDialogs: [],
  checkTabBeforeLease: async () => ({ ok: true as const }),
  clearForeignHistory: async () => true,
  onForeignDocument: () => {},
  onPolicyLost: () => {},
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
  it('a connection that starts with no lease held is refused at once', async () => {
    const lease = createTabLease();
    const relay = createDeviceRelay({ tabWs: 'ws://127.0.0.1:1/', consent: makeConsent(['https://a.test']), lease, enforcer, pageEnd: 'close' });
    const agent = fakeAgent();
    await relay.serve(agent as unknown as WebSocket);
    expect(agent.closed).toBe(1011);
    expect(lease.state()).toBe('idle');
  });

  it('a revoke while the tab is being reached: no new lease until the old page step is done, and nothing reaches the tab', async () => {
    const tab = await heldTab();
    try {
      const ends: string[] = [];
      const { lease, relay, agent } = setup(tab.url, { endPageActivity: async (mode) => { ends.push(mode); return true; } });
      const served = relay.serve(agent as unknown as WebSocket);
      await tab.arrived;
      lease.revoke('user revoked');
      expect(lease.state()).toBe('ending');
      expect(lease.reserve()).toBeNull();
      agent.emit('message', evaluate(1));
      tab.letGo();
      await served;
      agent.emit('message', evaluate(2));
      await settle();
      expect(tab.frames).toEqual([]);
      expect(agent.closed).toBe(1011);
      expect(ends).toEqual(['close']);
      expect(lease.state()).toBe('idle');
    } finally { tab.close(); }
  });

  it('a revoke while the tab is being checked: the lease stays ending until the page step is done', async () => {
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
      expect(lease.reserve()).toBeNull();
      check();
      await served;
      await settle();
      expect(tab.frames).toEqual([]);
      expect(agent.closed).toBe(1011);
      expect(lease.state()).toBe('idle');
    } finally { tab.close(); }
  });

  it('a command sent while the tab is being checked waits for the check, and a refused tab never gets it', async () => {
    const tab = await heldTab();
    tab.letGo();
    try {
      let answer!: (r: { ok: true } | { ok: false; reason: string }) => void;
      const verdict = new Promise<{ ok: true } | { ok: false; reason: string }>((r) => { answer = r; });
      let checked!: () => void;
      const started = new Promise<void>((r) => { checked = r; });
      const { lease, relay, agent } = setup(tab.url, { checkTabBeforeLease: async () => { checked(); return verdict; } });
      const served = relay.serve(agent as unknown as WebSocket);
      await started;
      // Arrives after the live handler used to be installed, but before the check answers.
      agent.emit('message', evaluate(1));
      await settle();
      expect(tab.frames).toEqual([]);
      answer({ ok: false, reason: 'the tab is on a site without consent' });
      await served;
      await settle();
      expect(tab.frames).toEqual([]);
      expect(lease.state()).toBe('idle');
      expect(relay.refusals.join()).toContain('site without consent');
    } finally { tab.close(); }
  });

  it('a command sent while the tab is being checked runs once the check passes', async () => {
    const tab = await heldTab();
    tab.letGo();
    try {
      let pass!: () => void;
      const passed = new Promise<void>((r) => { pass = r; });
      let checked!: () => void;
      const started = new Promise<void>((r) => { checked = r; });
      const { relay, agent } = setup(tab.url, { checkTabBeforeLease: async () => { checked(); await passed; return { ok: true as const }; } });
      void relay.serve(agent as unknown as WebSocket);
      await started;
      agent.emit('message', evaluate(1));
      await settle();
      expect(tab.frames).toEqual([]);
      pass();
      await vi.waitFor(() => expect(tab.frames.some((f) => f.includes('Runtime.evaluate'))).toBe(true));
    } finally { tab.close(); }
  });

  for (const [what, frames] of [
    ['more commands', () => Array.from({ length: 1001 }, (_, i) => evaluate(i + 1))],
    ['more bytes', () => [JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'x'.repeat(4 * 1024 * 1024 + 1) } })]],
  ] as const) {
    it(`${what} than may wait during the check end the connection, and none reach the tab`, async () => {
      const tab = await heldTab();
      tab.letGo();
      try {
        let pass!: () => void;
        const passed = new Promise<void>((r) => { pass = r; });
        let checked!: () => void;
        const started = new Promise<void>((r) => { checked = r; });
        const { lease, relay, agent } = setup(tab.url, { checkTabBeforeLease: async () => { checked(); await passed; return { ok: true as const }; } });
        const served = relay.serve(agent as unknown as WebSocket);
        await started;
        for (const f of frames()) agent.emit('message', f);
        pass();
        await served;
        await settle();
        expect(tab.frames).toEqual([]);
        expect(agent.closed).toBe(1011);
        expect(lease.state()).toBe('idle');
        expect(relay.refusals.join()).toContain('too many commands before the tab was ready');
      } finally { tab.close(); }
    });
  }

  it("a tab that can't be reached still runs the page step before the tab is free", async () => {
    const tab = await heldTab();
    try {
      const ends: string[] = [];
      const { lease, relay, agent } = setup(tab.url, { endPageActivity: async (mode) => { ends.push(mode); return true; } });
      const served = relay.serve(agent as unknown as WebSocket);
      await tab.arrived;
      tab.letGo(false);
      await served;
      expect(relay.refusals.join()).toContain('could not reach the tab');
      expect(ends).toEqual(['close']);
      expect(lease.state()).toBe('idle');
    } finally { tab.close(); }
  });
});

/** A tab that answers every command, except the methods it's told to hold until let go. */
async function answeringTab(held: Set<string>): Promise<{
  url: string; methods: string[]; frames: { method: string; sessionId?: string }[]; emit(event: object): void; release(): void; close(): void;
}> {
  const methods: string[] = [];
  const frames: { method: string; sessionId?: string }[] = [];
  const sockets: WebSocket[] = [];
  const waiting: (() => void)[] = [];
  let releasing = false;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => { sockets.push(ws); ws.on('message', (raw) => {
    const { id, method, sessionId } = JSON.parse(String(raw)) as { id: number; method: string; sessionId?: string };
    methods.push(method);
    frames.push({ method, ...(sessionId ? { sessionId } : {}) });
    const reply = (): void => {
      const result = method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: `s${id}` }
        : method === 'Target.getTargetInfo' ? { targetInfo: { targetId: 't1', type: 'page', title: 't', url: 'https://a.test/inbox?q=WHERETHEUSERIS' } }
        : { result: { type: 'number', value: 1 } };
      ws.send(JSON.stringify({ id, result }));
    };
    if (held.has(method) && !releasing) waiting.push(reply); else reply();
  }); });
  await new Promise((r) => wss.once('listening', r));
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`, methods, frames,
    emit: (event) => { for (const s of sockets) s.send(JSON.stringify(event)); },
    release: () => { releasing = true; for (const w of waiting.splice(0)) w(); },
    close: () => wss.close(),
  };
}

const addScript = (id: number) => JSON.stringify({ id, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: '1' }, sessionId: 'cascade-tab-1' });
const replied = (out: string[], id: number) => out.some((s) => (JSON.parse(s) as { id?: number }).id === id);

/** A held lease served by its own relay, with a barrier on its page step. */
function barrierSetup(tabWs: string, lease = createTabLease(), pageEnd: PageEndMode = 'close') {
  const ends: PageEndMode[] = [];
  let openBarrier!: (ok: boolean | Error) => void;
  const barrier = new Promise<boolean | Error>((r) => { openBarrier = r; });
  const relay = createDeviceRelay({
    tabWs, consent: makeConsent(['https://a.test']), lease, pageEnd,
    enforcer: { ...enforcer, endPageActivity: async (mode) => { ends.push(mode); const v = await barrier; if (v instanceof Error) throw v; return v; } },
  });
  return { lease, relay, ends, openBarrier };
}

describe('a revoked lease is torn down before the tab can be leased again', () => {
  for (const pageEnd of ['blank', 'close'] as const) {
    it(`no grant while the page step is held, then a fresh relay serves the next lease (pageEnd=${pageEnd})`, async () => {
      const tab = await answeringTab(new Set());
      try {
        const lease = createTabLease();
        lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 });
        const a = barrierSetup(tab.url, lease, pageEnd);
        const agentA = fakeAgent();
        const outA = sent(agentA);
        const servedA = a.relay.serve(agentA as unknown as WebSocket);
        agentA.emit('message', evaluate(1));
        await vi.waitFor(() => expect(replied(outA, 1)).toBe(true));

        lease.revoke('user revoked');
        await vi.waitFor(() => expect(a.ends).toEqual([pageEnd]));
        // The page step is held: the tab is still A's, and no one can take it.
        expect(lease.state()).toBe('ending');
        expect(lease.reserve()).toBeNull();
        const claim = await acquireLease({ lease, admit: () => ({ ok: true, exp: Date.now() + 60_000 }), claim: async () => ({ outcome: 'claimed' }), burn: () => { throw new Error('burned while ending'); } });
        expect(claim.outcome).toBe('tab-leased');

        a.openBarrier(true);
        await servedA;
        expect(lease.state()).toBe('idle');
        const before = tab.methods.length;

        // B, with a fresh relay and enforcer (in production, a fresh launch).
        const fenceB = lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 })!;
        const b = barrierSetup(tab.url, lease, pageEnd);
        const agentB = fakeAgent();
        const outB = sent(agentB);
        void b.relay.serve(agentB as unknown as WebSocket);
        agentB.emit('message', evaluate(1));
        await vi.waitFor(() => expect(replied(outB, 1)).toBe(true));
        await settle();
        // Nothing of A's ran after B was granted, and B is current and usable.
        expect(tab.methods.slice(before)).toEqual(['Runtime.evaluate']);
        expect(a.ends).toEqual([pageEnd]);
        expect(b.ends).toEqual([]);
        expect(lease.isCurrent(fenceB)).toBe(true);
        expect(agentB.closed).toBeUndefined();
        b.openBarrier(true);
        lease.revoke('done');
      } finally { tab.close(); }
    });
  }

  it('a script removal that never answers is bounded: the tab is closed, then freed', async () => {
    const tab = await answeringTab(new Set(['Page.removeScriptToEvaluateOnNewDocument']));
    try {
      const lease = createTabLease();
      lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 });
      const a = barrierSetup(tab.url, lease, 'blank');
      const agent = fakeAgent();
      const out = sent(agent);
      const served = a.relay.serve(agent as unknown as WebSocket);
      agent.emit('message', addScript(1));
      await vi.waitFor(() => expect(replied(out, 1)).toBe(true));
      lease.revoke('user revoked');
      await settle();
      expect(lease.state()).toBe('ending');
      expect(lease.reserve()).toBeNull();
      // The removal times out, so the page step closes the tab rather than blanking it.
      await vi.waitFor(() => expect(a.ends).toEqual(['close']), { timeout: 3000 });
      expect(lease.state()).toBe('ending');
      a.openBarrier(true);
      await served;
      expect(lease.state()).toBe('idle');
      tab.release();
    } finally { tab.close(); }
  });

  for (const [name, outcome] of [['fails', new Error('browser gone')], ['is not confirmed', false]] as const) {
    it(`a page step that ${name} still frees the tab, once it's over`, async () => {
      const tab = await answeringTab(new Set());
      try {
        const lease = createTabLease();
        lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 });
        const a = barrierSetup(tab.url, lease);
        const agent = fakeAgent();
        const served = a.relay.serve(agent as unknown as WebSocket);
        await settle();
        lease.revoke('user revoked');
        await vi.waitFor(() => expect(a.ends).toEqual(['close']));
        expect(lease.reserve()).toBeNull();
        a.openBarrier(outcome);
        await served;
        expect(a.relay.refusals.join()).toContain('did not confirm the page ended');
        expect(lease.state()).toBe('idle');
      } finally { tab.close(); }
    });
  }

  it('a relay serves one lease: a later grant on it is refused and ended, its page untouched', async () => {
    const tab = await answeringTab(new Set());
    try {
      const lease = createTabLease();
      lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 });
      const a = barrierSetup(tab.url, lease);
      a.openBarrier(true);
      const agentA = fakeAgent();
      const servedA = a.relay.serve(agentA as unknown as WebSocket);
      await settle();
      lease.revoke('done');
      await servedA;
      lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 });
      const before = tab.methods.length;
      const agentB = fakeAgent();
      await a.relay.serve(agentB as unknown as WebSocket);
      expect(agentB.closed).toBe(1011);
      expect(a.relay.refusals.join()).toContain('fresh launch is needed');
      expect(lease.state()).toBe('idle');
      expect(a.ends).toEqual(['close']);
      expect(tab.methods.length).toBe(before);
    } finally { tab.close(); }
  });
});

describe('findings from Codex on 37e54b3', () => {
  it('a second connection for the same lease is refused, and the first keeps it', async () => {
    const tab = await answeringTab(new Set());
    try {
      const { lease, relay, agent } = setup(tab.url);
      const first = relay.serve(agent as unknown as WebSocket);
      const second = fakeAgent();
      await relay.serve(second as unknown as WebSocket);
      expect(second.closed).toBe(1011);
      expect(relay.refusals.join()).toContain('already has a connection');
      expect(lease.state()).toBe('held');
      agent.emit('message', evaluate(1));
      await vi.waitFor(() => expect(tab.methods).toContain('Runtime.evaluate'));
      lease.revoke('done');
      await first;
    } finally { tab.close(); }
  });

  it('a script registration still unanswered at a revoke makes the page step close the tab', async () => {
    const tab = await answeringTab(new Set(['Page.addScriptToEvaluateOnNewDocument']));
    try {
      const lease = createTabLease();
      lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 });
      const ends: PageEndMode[] = [];
      const relay = createDeviceRelay({
        tabWs: tab.url, consent: makeConsent(['https://a.test']), lease, pageEnd: 'blank',
        enforcer: { ...enforcer, endPageActivity: async (mode) => { ends.push(mode); return true; } },
      });
      const agent = fakeAgent();
      const served = relay.serve(agent as unknown as WebSocket);
      agent.emit('message', addScript(1));
      await vi.waitFor(() => expect(tab.methods).toContain('Page.addScriptToEvaluateOnNewDocument'));
      lease.revoke('user revoked');
      await served;
      expect(ends).toEqual(['close']);
    } finally { tab.release(); tab.close(); }
  });

  it('control: with every registration answered, the page step keeps blank', async () => {
    const tab = await answeringTab(new Set());
    try {
      const lease = createTabLease();
      lease.promote(lease.reserve()!, { expiresAt: Date.now() + 60_000 });
      const ends: PageEndMode[] = [];
      const relay = createDeviceRelay({
        tabWs: tab.url, consent: makeConsent(['https://a.test']), lease, pageEnd: 'blank',
        enforcer: { ...enforcer, endPageActivity: async (mode) => { ends.push(mode); return true; } },
      });
      const agent = fakeAgent();
      const out: string[] = [];
      (agent as unknown as { send(d: string): void }).send = (d: string) => { out.push(d); };
      const served = relay.serve(agent as unknown as WebSocket);
      agent.emit('message', addScript(1));
      await vi.waitFor(() => expect(replied(out, 1)).toBe(true));
      lease.revoke('user revoked');
      await served;
      expect(ends).toEqual(['blank']);
    } finally { tab.close(); }
  });

  it('the policy losing its connection ends the lease', async () => {
    const tab = await answeringTab(new Set());
    try {
      let lose!: () => void;
      const { lease, relay, agent } = setup(tab.url, { onPolicyLost: (l) => { lose = l; } });
      const served = relay.serve(agent as unknown as WebSocket);
      await vi.waitFor(() => expect(lose).toBeDefined());
      lose();
      await served;
      expect(lease.state()).toBe('idle');
      expect(relay.refusals.join()).toContain('request policy lost its connection');
    } finally { tab.close(); }
  });
});

const autoAttach = (id: number) => JSON.stringify({ id, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } });
const attachments = (out: string[]) => out.filter((s) => (JSON.parse(s) as { method?: string }).method === 'Target.attachedToTarget');
const errored = (out: string[], id: number) => out.some((s) => { const m = JSON.parse(s) as { id?: number; error?: unknown }; return m.id === id && m.error !== undefined; });

describe('asking where the tab is, while the user has it (Codex on e1bf934)', () => {
  it('control: under a held lease, the query is answered and names the current URL', async () => {
    const tab = await answeringTab(new Set());
    try {
      const { lease, relay, agent } = setup(tab.url);
      const out = sent(agent);
      const served = relay.serve(agent as unknown as WebSocket);
      agent.emit('message', autoAttach(1));
      await vi.waitFor(() => expect(attachments(out)).toHaveLength(1));
      expect(attachments(out)[0]).toContain('WHERETHEUSERIS');
      lease.revoke('done');
      await served;
    } finally { tab.close(); }
  });

  it('suspended: the query is refused, the tab is not asked, and nothing names the URL', async () => {
    const tab = await answeringTab(new Set());
    try {
      const { lease, relay, agent } = setup(tab.url);
      const out = sent(agent);
      const served = relay.serve(agent as unknown as WebSocket);
      agent.emit('message', evaluate(1));
      await vi.waitFor(() => expect(replied(out, 1)).toBe(true));
      lease.suspend();
      const before = tab.methods.length;
      for (const id of [2, 3, 4]) agent.emit('message', autoAttach(id));
      await settle();
      expect(lease.state()).toBe('suspended');
      for (const id of [2, 3, 4]) expect(errored(out, id)).toBe(true);
      expect(tab.methods.slice(before)).toEqual([]);
      expect(out.join()).not.toContain('WHERETHEUSERIS');
      lease.revoke('done');
      await served;
    } finally { tab.close(); }
  });

  for (const [name, change] of [['a suspend', (l: ReturnType<typeof createTabLease>) => l.suspend()], ['a revoke', (l: ReturnType<typeof createTabLease>) => l.revoke('user revoked')]] as const) {
    it(`an answer still on its way at ${name} never reaches the agent`, async () => {
      const tab = await answeringTab(new Set(['Target.getTargetInfo']));
      try {
        const { lease, relay, agent } = setup(tab.url);
        const out = sent(agent);
        const served = relay.serve(agent as unknown as WebSocket);
        agent.emit('message', autoAttach(1));
        await vi.waitFor(() => expect(tab.methods).toContain('Target.getTargetInfo'));
        change(lease);
        tab.release();
        await settle();
        expect(attachments(out)).toEqual([]);
        expect(out.join()).not.toContain('WHERETHEUSERIS');
        lease.revoke('done');
        await served;
      } finally { tab.close(); }
    });
  }

  it('after a hand-back the query works again', async () => {
    const tab = await answeringTab(new Set());
    try {
      const { lease, relay, agent } = setup(tab.url);
      const out = sent(agent);
      const served = relay.serve(agent as unknown as WebSocket);
      await settle();
      lease.suspend();
      agent.emit('message', autoAttach(1));
      await settle();
      expect(attachments(out)).toEqual([]);
      lease.handBack();
      agent.emit('message', autoAttach(2));
      await vi.waitFor(() => expect(attachments(out)).toHaveLength(1));
      lease.revoke('done');
      await served;
    } finally { tab.close(); }
  });
});

describe('child sessions while the user has the tab (Codex on 9b35690)', () => {
  const attached = (sessionId: string, url: string, waitingForDebugger = true) => ({
    method: 'Target.attachedToTarget',
    params: { sessionId, waitingForDebugger, targetInfo: { targetId: `t-${sessionId}`, type: 'iframe', title: '', url, attached: true } },
  });
  const detached = (sessionId: string) => ({ method: 'Target.detachedFromTarget', params: { sessionId, targetId: `t-${sessionId}` } });
  const onSession = (id: number, sessionId: string) => JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId });
  const events = (out: string[], method: string) => out.map((s) => JSON.parse(s) as { method?: string; params?: { sessionId?: string; waitingForDebugger?: boolean } }).filter((m) => m.method === method);
  const errorFor = (out: string[], id: number) => (out.map((s) => JSON.parse(s) as { id?: number; error?: { message: string } }).find((m) => m.id === id)?.error?.message);

  async function serving() {
    const tab = await answeringTab(new Set());
    const { lease, relay, agent } = setup(tab.url);
    const out = sent(agent);
    const served = relay.serve(agent as unknown as WebSocket);
    agent.emit('message', evaluate(1));
    await vi.waitFor(() => expect(replied(out, 1)).toBe(true));
    return { tab, lease, agent, out, served, done: async () => { lease.revoke('done'); await served; tab.close(); } };
  }

  it('a consented frame that attaches during the takeover runs, is not disclosed, and is usable after the hand-back', async () => {
    const s = await serving();
    s.lease.suspend();
    s.tab.emit(attached('child-1', 'https://a.test/frame?where=USERWASHERE'));
    await settle();
    // The page needs it running, and the agent can't resume it now.
    expect(s.tab.frames).toContainEqual({ method: 'Runtime.runIfWaitingForDebugger', sessionId: 'child-1' });
    expect(events(s.out, 'Target.attachedToTarget')).toEqual([]);
    expect(s.out.join()).not.toContain('USERWASHERE');
    s.lease.handBack();
    await vi.waitFor(() => expect(events(s.out, 'Target.attachedToTarget')).toHaveLength(1));
    const told = events(s.out, 'Target.attachedToTarget')[0]!;
    expect(told.params).toMatchObject({ sessionId: 'child-1', waitingForDebugger: false });
    // And it's a session the agent can use: the bug was an unknown-session error here.
    s.agent.emit('message', onSession(2, 'child-1'));
    await vi.waitFor(() => expect(replied(s.out, 2)).toBe(true));
    expect(errorFor(s.out, 2)).toBeUndefined();
    expect(s.tab.frames).toContainEqual({ method: 'Runtime.evaluate', sessionId: 'child-1' });
    await s.done();
  });

  it('a frame that came and went during the takeover is never mentioned', async () => {
    const s = await serving();
    s.lease.suspend();
    s.tab.emit(attached('child-1', 'https://a.test/frame'));
    s.tab.emit(detached('child-1'));
    await settle();
    s.lease.handBack();
    await settle();
    expect(events(s.out, 'Target.attachedToTarget')).toEqual([]);
    expect(events(s.out, 'Target.detachedFromTarget')).toEqual([]);
    s.agent.emit('message', onSession(2, 'child-1'));
    await vi.waitFor(() => expect(errorFor(s.out, 2)).toContain('unknown session'));
    await s.done();
  });

  it('a frame the agent knew that goes during the takeover is reported gone at the hand-back, before anything new', async () => {
    const s = await serving();
    s.tab.emit(attached('child-1', 'https://a.test/one', false));
    await vi.waitFor(() => expect(events(s.out, 'Target.attachedToTarget')).toHaveLength(1));
    s.lease.suspend();
    s.tab.emit(detached('child-1'));
    s.tab.emit(attached('child-2', 'https://a.test/two'));
    await settle();
    expect(events(s.out, 'Target.detachedFromTarget')).toEqual([]);
    const before = s.out.length;
    s.lease.handBack();
    await vi.waitFor(() => expect(s.out.length).toBe(before + 2));
    const order = s.out.slice(before).map((x) => (JSON.parse(x) as { method: string; params: { sessionId: string } })).map((m) => `${m.method}:${m.params.sessionId}`);
    expect(order).toEqual(['Target.detachedFromTarget:child-1', 'Target.attachedToTarget:child-2']);
    s.agent.emit('message', onSession(2, 'child-1'));
    await vi.waitFor(() => expect(errorFor(s.out, 2)).toContain('unknown session'));
    await s.done();
  });

  it('a frame on a site without consent stays hidden through a takeover and after it', async () => {
    const s = await serving();
    s.lease.suspend();
    s.tab.emit(attached('child-x', 'https://elsewhere.test/frame'));
    await settle();
    expect(s.tab.frames).toContainEqual({ method: 'Runtime.runIfWaitingForDebugger', sessionId: 'child-x' });
    s.lease.handBack();
    await settle();
    expect(events(s.out, 'Target.attachedToTarget')).toEqual([]);
    s.agent.emit('message', onSession(2, 'child-x'));
    await vi.waitFor(() => expect(errorFor(s.out, 2)).toContain('unknown session'));
    await s.done();
  });

  it('a lease that ends during the takeover announces nothing', async () => {
    const s = await serving();
    s.lease.suspend();
    s.tab.emit(attached('child-1', 'https://a.test/frame'));
    await settle();
    s.lease.revoke('user revoked');
    await s.served;
    expect(events(s.out, 'Target.attachedToTarget')).toEqual([]);
    s.tab.close();
  });
});

describe('the tab is announced before the reply to setAutoAttach, as Chrome does (CI on 8e5817a)', () => {
  it('a client reading its pages on the reply finds the tab', async () => {
    const tab = await answeringTab(new Set());
    try {
      const { lease, relay, agent } = setup(tab.url);
      const out = sent(agent);
      const served = relay.serve(agent as unknown as WebSocket);
      agent.emit('message', autoAttach(1));
      await vi.waitFor(() => expect(replied(out, 1)).toBe(true));
      const order = out.map((s) => JSON.parse(s) as { id?: number; method?: string })
        .map((m) => (m.method === 'Target.attachedToTarget' ? 'attached' : m.id === 1 ? 'reply' : 'other'));
      expect(order.indexOf('attached')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('attached')).toBeLessThan(order.indexOf('reply'));
      lease.revoke('done');
      await served;
    } finally { tab.close(); }
  });

  it('an answer that comes back after the lease changed still gets a refusal, not silence', async () => {
    const tab = await answeringTab(new Set(['Target.getTargetInfo']));
    try {
      const { lease, relay, agent } = setup(tab.url);
      const out = sent(agent);
      const served = relay.serve(agent as unknown as WebSocket);
      agent.emit('message', autoAttach(1));
      await vi.waitFor(() => expect(tab.methods).toContain('Target.getTargetInfo'));
      lease.suspend();
      tab.release();
      await vi.waitFor(() => expect(errored(out, 1)).toBe(true));
      expect(attachments(out)).toEqual([]);
      lease.revoke('done');
      await served;
    } finally { tab.close(); }
  });
});
