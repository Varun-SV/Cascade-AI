import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { checkEndpointUrl, endpointLabel, openBridge, pinnedLookup, UserEndpointProvider } from './user-endpoint.js';

const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

/** A CDP-ish server on loopback that echoes, counting every connection it accepts. */
async function target() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const accepted: string[] = [];
  wss.on('connection', (ws, req) => {
    accepted.push(req.url ?? '');
    ws.on('message', (m) => ws.send(`echo:${String(m)}`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { wss.close(); server.closeAllConnections(); server.close(); });
  return { port: (server.address() as AddressInfo).port, accepted };
}

const connect = (url: string) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
  closers.push(() => ws.terminate());
});
const nextMessage = (ws: WebSocket) => new Promise<string>((r) => ws.once('message', (m) => r(String(m))));
const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', (code) => r(code)));

describe('what may be stored as an endpoint', () => {
  const pub = { allowPrivate: false };
  it('wss only, no name or password, not too long, and not a private host', () => {
    expect(checkEndpointUrl('wss://connect.steel.dev?apiKey=abc', pub)).toMatchObject({ ok: true });
    expect(checkEndpointUrl('ws://browser.example.com', pub)).toMatchObject({ ok: false, error: expect.stringContaining('wss://') });
    expect(checkEndpointUrl('https://browser.example.com', pub)).toMatchObject({ ok: false });
    expect(checkEndpointUrl('wss://me:pw@browser.example.com', pub)).toMatchObject({ ok: false, error: expect.stringContaining('token') });
    expect(checkEndpointUrl(`wss://x.example.com/${'a'.repeat(2100)}`, pub)).toMatchObject({ ok: false });
    for (const host of ['localhost', '127.0.0.1', '10.0.0.2', '[::1]', '192.168.1.1', 'router.local', '169.254.169.254']) {
      expect([host, checkEndpointUrl(`wss://${host}:9222`, pub).ok]).toEqual([host, false]);
    }
    expect(checkEndpointUrl('', pub).ok).toBe(false);
    expect(checkEndpointUrl(42, pub).ok).toBe(false);
  });
  it('a self-hoster that allows private endpoints may use ws:// and its own network', () => {
    expect(checkEndpointUrl('ws://192.168.1.5:9222/devtools/browser/x', { allowPrivate: true })).toMatchObject({ ok: true });
  });
  it('is shown back only as its host: the path and query, where a token lives, never', () => {
    expect(endpointLabel('wss://connect.steel.dev/x?apiKey=SECRET')).toBe('connect.steel.dev');
  });
});

describe('the pinned lookup', () => {
  const lookup = (resolve: (h: string) => Promise<string[]>, allowPrivate = false) => (host: string) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((r) => pinnedLookup({ allowPrivate, resolve })(host, {}, (err, address) => r({ err, address })));

  it('answers with the first address, once every address was checked', async () => {
    expect((await lookup(async () => ['203.0.113.7', '203.0.113.8'])('endpoint.test')).address).toBe('203.0.113.7');
  });
  it('refuses a public-looking name with ANY private address among its answers', async () => {
    const r = await lookup(async () => ['203.0.113.7', '10.0.0.1'])('rebind.test');
    expect(r.err?.message).toMatch(/private address/);
    expect((await lookup(async () => ['::ffff:127.0.0.1'])('mapped.test')).err).not.toBeNull();
    expect((await lookup(async () => [])('empty.test')).err?.message).toMatch(/did not resolve/);
    expect((await lookup(async () => { throw new Error('ENOTFOUND'); })('gone.test')).err?.message).toMatch(/did not resolve/);
  });
});

describe('the bridge', () => {
  it('pipes CDP both ways, resolving the host once and dialling the address it checked', async () => {
    const t = await target();
    const resolve = vi.fn(async () => ['127.0.0.1']);
    const bridge = await openBridge(`ws://endpoint.test:${t.port}/devtools/browser/abc?token=T`, { allowPrivate: true, resolve });
    closers.push(() => bridge.close());
    expect(bridge.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{20,}$/);
    const ws = await connect(bridge.url);
    const reply = nextMessage(ws);
    ws.send('{"id":1,"method":"Browser.getVersion"}');
    expect(await reply).toBe('echo:{"id":1,"method":"Browser.getVersion"}');
    expect(t.accepted).toEqual(['/devtools/browser/abc?token=T']);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a name that resolves to a private address is refused: the server there accepts nothing', async () => {
    const t = await target();
    const bridge = await openBridge(`wss://looks-public.test:${t.port}/x`, { allowPrivate: false, resolve: async () => ['127.0.0.1'] });
    closers.push(() => bridge.close());
    const ws = await connect(bridge.url);
    expect(await closed(ws)).toBe(1011);
    expect(t.accepted).toEqual([]);
  });

  it('answers only its own path, on loopback', async () => {
    const t = await target();
    const bridge = await openBridge(`ws://endpoint.test:${t.port}/`, { allowPrivate: true, resolve: async () => ['127.0.0.1'] });
    closers.push(() => bridge.close());
    const wrong = await connect(bridge.url.replace(/\/[^/]+$/, '/guess'));
    expect(await closed(wrong)).toBe(1008);
    expect(t.accepted).toEqual([]);
  });
});

describe('the provider', () => {
  it('opens a bridge per session and closes it with the session', async () => {
    const t = await target();
    const p = new UserEndpointProvider(`ws://endpoint.test:${t.port}/`, { allowPrivate: true, resolve: async () => ['127.0.0.1'] });
    const s = await p.createSession();
    const ws = await connect(s.cdpUrl);
    const gone = closed(ws);
    await p.endSession(s.id);
    await gone;
    await expect(connect(s.cdpUrl)).rejects.toThrow();
    expect(p.allocatesSessions).toBe(false);
  });
});
