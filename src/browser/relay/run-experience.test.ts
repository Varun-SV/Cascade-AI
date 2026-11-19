// What a run says when it asks, what the user can answer, and what a device does with it:
// any public site, the sites hint, the chat a run is from, and bringing its window forward.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createIdentity, createMemoryNonceStore } from './capability.js';
import { parseSites } from './consent-input.js';
import { type LeasedBrowser, type RunHint, type UserConsent, connectDeviceClient, readRunHint } from './device.js';
import type { Consent } from './egress-rules.js';
import { ANY_PUBLIC_SITE, makeConsent, onConsentedSite, requestVerdict } from './egress-rules.js';
import { authenticateControl, createRelayHub } from './hub.js';
import type { RequestEnforcer } from './request-enforcer.js';
import { RelayBrowserProvider } from '../remote/relay-provider.js';
import { describeStep, sessionHintFor } from '../remote/controller.js';

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await Promise.resolve(c()).catch(() => {}); });

describe('any public site', () => {
  const any = makeConsent([], [], { anyPublic: true });

  it('lets pages from any public site load, and nothing private', () => {
    expect(requestVerdict('https://www.rtings.com/headphones', 'Document', any)).toEqual({ allow: true });
    expect(requestVerdict('https://reddit.com/r/headphones', 'Document', any)).toEqual({ allow: true });
    expect(requestVerdict('http://192.168.1.1/', 'Document', any)).toMatchObject({ allow: false });
    expect(requestVerdict('http://localhost:3000/', 'XHR', any)).toMatchObject({ allow: false });
    expect(onConsentedSite('https://anything.example/page', any)).toBe(true);
    expect(onConsentedSite('http://127.0.0.1/', any)).toBe(false);
    expect(onConsentedSite('file:///etc/passwd', any)).toBe(false);
  });

  it('is off unless asked for: named sites stay the only ones', () => {
    const named = makeConsent(['https://a.test']);
    expect(named.anyPublic).toBe(false);
    expect(requestVerdict('https://b.test/', 'Document', named)).toMatchObject({ allow: false });
  });

  it('a signed approval that says "*" reads back as any public site', () => {
    expect(makeConsent([ANY_PUBLIC_SITE, 'https://a.test']).anyPublic).toBe(true);
  });

  it('typed as * in a terminal', () => {
    expect(parseSites('*')).toEqual({ consent: { allowedOrigins: [], privateOrigins: [], anyPublic: true } });
    expect(parseSites('* localhost:3000')).toEqual({ consent: { allowedOrigins: [], privateOrigins: ['https://localhost:3000'], anyPublic: true } });
  });
});

describe("a run's hint, as a device reads it", () => {
  it('keeps host names and a chat key of the right shape, and nothing else', () => {
    expect(readRunHint({ sites: ['GitHub.com', 'docs.github.com', 'github.com'], chat: 'c_1-x' })).toEqual({ sites: ['github.com', 'docs.github.com'], chat: 'c_1-x' });
    expect(readRunHint({ sites: ['https://x.test/path', '<b>', 'a'.repeat(300)], chat: 'not ok!' })).toBeUndefined();
    expect(readRunHint({ sites: Array.from({ length: 30 }, (_, i) => `s${i}.test`) })!.sites).toHaveLength(10);
    expect(readRunHint('nope')).toBeUndefined();
  });

  it("is the site of the run's first page, when it starts by opening one", () => {
    expect(sessionHintFor({ kind: 'navigate', url: 'https://www.rtings.com/headphones' })).toEqual({ sites: ['www.rtings.com'] });
    expect(sessionHintFor({ kind: 'navigate', url: 'example.com' })).toEqual({ sites: ['example.com'] });
    expect(sessionHintFor({ kind: 'navigate', url: 'javascript:alert(1)' })).toBeUndefined();
    expect(sessionHintFor({ kind: 'click', selector: '#a' })).toBeUndefined();
  });
});

describe('the steps the side pane shows', () => {
  it('say what was done, never what was typed', () => {
    const typed = describeStep({ kind: 'fill', ref: 'e3', value: 'hunter2' }, { ok: true, detail: 'ok', url: 'https://a.test/login', title: 'Sign in' }, 1);
    expect(typed).toEqual({ kind: 'fill', summary: 'Typed into element e3', ok: true, at: 1, url: 'https://a.test/login', title: 'Sign in' });
    expect(JSON.stringify(typed)).not.toContain('hunter2');
    expect(describeStep({ kind: 'navigate', url: 'https://www.rtings.com/headphones?x=1' }, { ok: false, detail: 'blocked' }, 2))
      .toMatchObject({ summary: 'Opened www.rtings.com/headphones', ok: false, why: 'blocked' });
  });

  it('say why one did not work, without anything that was typed', () => {
    const failed = describeStep({ kind: 'fill', ref: 'e3', value: 'hunter2' }, { ok: false, detail: 'elementHandle.fill("hunter2"): Timeout 500ms exceeded.' }, 3);
    expect(failed.why).toBe('elementHandle.fill("…"): Timeout 500ms exceeded.');
    expect(JSON.stringify(failed)).not.toContain('hunter2');
    expect(describeStep({ kind: 'click', ref: 'e4' }, { ok: true, detail: 'Clicked e4' }, 4)).not.toHaveProperty('why');
  });
});

describe('the relay provider', () => {
  it("asks the device with the run's site and its chat key", async () => {
    const asked: unknown[] = [];
    const hub = {
      requestBrowser: async (r: unknown) => { asked.push(r); return { token: 't', expiresAt: Date.now() + 60_000, closed: new Promise<string>(() => {}), close: () => {} }; },
      endRun: () => {},
    };
    const p = new RelayBrowserProvider({ hub: hub as never, agentUrl: (t) => `ws://x/${t}`, userId: 'u', deviceId: 'd', runId: 'r', chat: 'abc' });
    await p.createSession(undefined, { sites: ['github.com'] });
    expect(asked[0]).toMatchObject({ runId: 'r', hint: { sites: ['github.com'], chat: 'abc' } });
  });
});

const enforcer: RequestEnforcer = {
  decisions: [], closedPages: [], children: [], dismissedDialogs: [],
  checkTabBeforeLease: async () => ({ ok: true as const }), clearForeignHistory: async () => true,
  onForeignDocument: () => {}, onPolicyLost: () => {}, endPageActivity: async () => true, close: () => {},
};

describe('over the relay', () => {
  async function world() {
    const server = createIdentity('server');
    const device = createIdentity('device-a');
    const hub = createRelayHub({ server, store: createMemoryNonceStore(Date.now), deviceKey: (id) => (id === device.id ? device.publicKey : null) });
    const claims: string[] = [];
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws, req) => {
      if (req.url === '/control') {
        void authenticateControl(ws, { serverId: server.id, device: (id) => (id === device.id ? { userId: 'user-a', key: device.publicKey } : null) })
          .then((who) => { if (who) hub.attachDevice(who, ws); });
      } else if (req.url === '/run') {
        ws.once('message', (m) => claims.push(String(m)));
        hub.attachRun(ws);
      } else ws.close();
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    closers.push(() => { hub.close(); httpServer.closeAllConnections(); httpServer.close(); });
    // A tab that answers every command.
    const tab = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    tab.on('connection', (ws) => ws.on('message', (raw) => ws.send(JSON.stringify({ id: (JSON.parse(String(raw)) as { id: number }).id, result: {} }))));
    await new Promise((r) => tab.once('listening', r));
    closers.push(() => tab.close());
    const base = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    return { hub, server, device, claims, base, tabWs: `ws://127.0.0.1:${(tab.address() as AddressInfo).port}/` };
  }

  it('the device is asked with the hint; "any public site" reaches its browser and its signed approval; focus reaches it', async () => {
    const w = await world();
    const asked: Array<RunHint | undefined> = [];
    const started: Consent[] = [];
    const focused = vi.fn();
    const answer: UserConsent = { allowedOrigins: [], privateOrigins: [], anyPublic: true };
    const client = connectDeviceClient({
      controlUrl: `${w.base}/control`, runUrl: `${w.base}/run`, device: w.device, serverId: w.server.id, serverKey: w.server.publicKey,
      askUser: async (run) => { asked.push(run.hint); return answer; },
      startBrowser: async (consent): Promise<LeasedBrowser> => {
        started.push(consent);
        return { tabWs: w.tabWs, tabTargetId: 'T1', enforcer, pageEnd: 'blank', onEgressDown: () => {}, close: async () => {} };
      },
      onFocus: focused,
    });
    closers.push(() => client.close());
    await client.ready;
    await vi.waitFor(() => expect(w.hub.deviceOnline('user-a', w.device.id)).toBe(true));

    expect(w.hub.focusRun('run-1')).toBe(false);
    const browser = await w.hub.requestBrowser({ userId: 'user-a', deviceId: w.device.id, runId: 'run-1', hint: { sites: ['www.rtings.com'], chat: 'chat1' } });
    closers.push(() => browser.close());
    expect(asked).toEqual([{ sites: ['www.rtings.com'], chat: 'chat1' }]);
    expect(started[0]!.anyPublic).toBe(true);
    const claim = JSON.parse(w.claims[0]!) as { approval: { payload: { allowedOrigins: string[] } } };
    expect(claim.approval.payload.allowedOrigins).toEqual([ANY_PUBLIC_SITE]);

    expect(w.hub.focusRun('run-1')).toBe(true);
    await vi.waitFor(() => expect(focused).toHaveBeenCalledTimes(1));
    expect(w.hub.focusRun('another-run')).toBe(false);
  });

  // A deploy: the server shuts its hub down and the device is told it is a
  // restart, so the extension waits before reconnecting (see background.ts).
  it('a server restart is told apart from a dropped connection', async () => {
    const w = await world();
    const options = {
      controlUrl: `${w.base}/control`, runUrl: `${w.base}/run`, device: w.device, serverId: w.server.id, serverKey: w.server.publicKey,
      askUser: async () => null,
      startBrowser: async (): Promise<LeasedBrowser> => { throw new Error('not used'); },
    };
    const client = connectDeviceClient(options);
    await client.ready;
    await vi.waitFor(() => expect(w.hub.deviceOnline('user-a', w.device.id)).toBe(true));
    w.hub.close();
    expect(await client.closed).toBe('the server is restarting');
    expect(client.restarting()).toBe(true);
    expect(client.rejected()).toBe(false);
  });

  it('a device dropped by the server is not taken for a restart', async () => {
    const w = await world();
    const client = connectDeviceClient({
      controlUrl: `${w.base}/control`, runUrl: `${w.base}/run`, device: w.device, serverId: w.server.id, serverKey: w.server.publicKey,
      askUser: async () => null,
      startBrowser: async (): Promise<LeasedBrowser> => { throw new Error('not used'); },
    });
    await client.ready;
    await vi.waitFor(() => expect(w.hub.deviceOnline('user-a', w.device.id)).toBe(true));
    w.hub.dropDevice(w.device.id, 'signed out');
    await client.closed;
    expect(client.restarting()).toBe(false);
  });
});
