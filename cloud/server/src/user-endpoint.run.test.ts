// The run's side of source C: which runs use the user's endpoint, and that one does.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { attachRemoteBrowser } from './remote-browser.js';
import { buildCloudConfig, endpointBrowserControls, endpointForRun } from './runs.js';
import { encryptAtRest } from './secrets.js';
import type { CloudEnv } from './env.js';

const SECRET = 'test-session-secret-value';
const env = (over: Partial<CloudEnv> = {}) => ({ SESSION_SECRET: SECRET, BROWSER_ENDPOINTS: true, ...over }) as CloudEnv;
const enc = (url: string) => encryptAtRest(url, SECRET, 'cascade-browser-endpoint-v1');
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

describe('which runs use the user\'s own endpoint', () => {
  const chosen = (url: string) => ({ source: 'endpoint' as const, endpointEnc: enc(url), endpointHost: 'x' });

  it('the one they saved and chose, decrypted for the run', () => {
    expect(endpointForRun(env(), chosen('wss://connect.example.com/?apiKey=T'))).toEqual({ url: 'wss://connect.example.com/?apiKey=T', allowPrivate: false });
  });

  it('none when the server doesn\'t offer it, they chose another source, or none is saved', () => {
    expect(endpointForRun(env({ BROWSER_ENDPOINTS: false }), chosen('wss://connect.example.com/'))).toBeNull();
    expect(endpointForRun(env(), { ...chosen('wss://connect.example.com/'), source: 'device' })).toBeNull();
    expect(endpointForRun(env(), { source: 'endpoint', endpointEnc: null, endpointHost: null })).toBeNull();
  });

  it('none when it was encrypted with another key, or tampered with', () => {
    expect(endpointForRun(env(), { source: 'endpoint', endpointEnc: encryptAtRest('wss://connect.example.com/', 'other-secret', 'cascade-browser-endpoint-v1'), endpointHost: 'x' })).toBeNull();
    // The MCP key's blobs don't open as an endpoint either.
    expect(endpointForRun(env(), { source: 'endpoint', endpointEnc: encryptAtRest('wss://connect.example.com/', SECRET), endpointHost: 'x' })).toBeNull();
  });

  it('a private endpoint saved while allowed stops being used once the server no longer allows it', () => {
    const saved = chosen('ws://192.168.1.5:9222/devtools/browser/x');
    expect(endpointForRun(env({ BROWSER_ENDPOINTS_PRIVATE: true }), saved)).toMatchObject({ allowPrivate: true });
    expect(endpointForRun(env({ BROWSER_ENDPOINTS_PRIVATE: false }), saved)).toBeNull();
  });

  it('the run config names the endpoint only when the turn asked for a browser', () => {
    expect(buildCloudConfig([], 0.5, { browserMode: true, ...endpointBrowserControls({} as CloudEnv) }).tools.remoteBrowser).toMatchObject({ provider: 'endpoint' });
    expect(buildCloudConfig([], 0.5, { browserMode: false, ...endpointBrowserControls({} as CloudEnv) }).tools.remoteBrowser).toBeUndefined();
  });
});

describe('a run on the user\'s endpoint', () => {
  it('reaches it through the bridge, and the bridge goes with the run', async () => {
    // Stands in for the user's endpoint: it accepts the connection, though it speaks no CDP.
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const accepted: string[] = [];
    wss.on('connection', (ws, req) => { accepted.push(req.url ?? ''); ws.close(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => { wss.close(); server.closeAllConnections(); server.close(); });
    const port = (server.address() as AddressInfo).port;

    const handlers = new Map<string, (e: unknown) => void>();
    const wired: Array<{ controller: (a: unknown, c: unknown) => Promise<{ ok: boolean; detail: string }> }> = [];
    const cascade = {
      on: (event: string, fn: (e: unknown) => void) => { handlers.set(event, fn); },
      setRemoteBrowserController: (controller: never) => { wired.push({ controller }); },
    } as never;
    const warn = vi.fn();
    expect(attachRemoteBrowser({ cascade, config: { tools: { remoteBrowser: { provider: 'endpoint', maxSessions: 1 } } }, conversationId: 'c1', emit: () => {}, warn })).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toMatch(/endpoint/);

    const attached = attachRemoteBrowser({
      cascade, config: { tools: { remoteBrowser: { provider: 'endpoint', maxSessions: 1 } } }, conversationId: 'c1', emit: () => {},
      userEndpoint: { url: `ws://127.0.0.1:${port}/devtools/browser/mine?token=T`, allowPrivate: true },
    })!;
    handlers.get('run:started')!({ taskId: 't1' });
    const out = await wired[0]!.controller({ kind: 'navigate', url: 'https://example.com/' }, { sessionId: 't1', actorId: 'w1' });
    // Not a browser behind it, so the action fails: but it got there, by the user's own path.
    expect(out.ok).toBe(false);
    expect(accepted).toEqual(['/devtools/browser/mine?token=T']);
    await attached.endRun();
  });
});
