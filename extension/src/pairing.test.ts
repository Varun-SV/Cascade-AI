import { describe, expect, it } from 'vitest';
import { createIdentity, publicKeyFromText, publicKeyToText } from '../../src/browser/relay/capability.js';
import { endpointsOf, pairWithServer, serverOrigin } from './pairing.js';

const server = createIdentity('server-1');
const info = { serverId: 'server-1', serverKey: publicKeyToText(server.publicKey), controlPath: '/api/browser-relay/control', runPath: '/api/browser-relay/run' };

function fakeServer(over: { relay?: boolean; regKey?: string; polls?: number } = {}) {
  const calls: { path: string; init?: RequestInit }[] = [];
  let polls = over.polls ?? 1;
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, ...(init ? { init } : {}) });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/browser-relay/server') return over.relay === false ? json(404, {}) : json(200, info);
    if (path === '/api/native/device') return json(200, { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://cascade.test/activate', expires_in: 600, interval: 1 });
    if (path === '/api/native/device/token') return polls-- > 0 ? json(428, {}) : json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 900 });
    if (path === '/api/browser-relay/devices') return json(201, { device: { id: 'dev-9', name: 'Chrome' }, serverId: info.serverId, serverKey: over.regKey ?? info.serverKey });
    if (path === '/api/native/logout') return json(200, { ok: true });
    return json(404, {});
  };
  return { f: f as typeof fetch, calls };
}

describe('the server address', () => {
  it('is an https origin; http only for this machine', () => {
    expect(serverOrigin('cascadeai.in')).toBe('https://cascadeai.in');
    expect(serverOrigin('https://cascadeai.in/some/page')).toBe('https://cascadeai.in');
    expect(serverOrigin('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => serverOrigin('http://cascadeai.in')).toThrow(/https/);
    expect(() => serverOrigin('https://me:pw@cascadeai.in')).toThrow();
    expect(() => serverOrigin('not a url at all')).toThrow();
  });
});

describe('pairing', () => {
  it("signs in with a code the user approves, registers only the key's public half, and revokes the sign-in", async () => {
    const { f, calls } = fakeServer({ polls: 2 });
    const codes: string[] = [];
    const d = await pairWithServer({ server: 'https://cascade.test', name: 'Chrome', fetch: f, sleep: async () => {}, onCode: (c) => codes.push(c.userCode) });
    expect(codes).toEqual(['ABCD-1234']);
    expect(d).toMatchObject({ serverUrl: 'https://cascade.test', deviceId: 'dev-9', serverId: 'server-1', serverKey: info.serverKey });
    const reg = calls.find((c) => c.path === '/api/browser-relay/devices')!;
    expect((reg.init!.headers as Record<string, string>)['Authorization']).toBe('Bearer AT');
    const body = JSON.parse(String(reg.init!.body)) as { kind: string; publicKey: string };
    expect(body.kind).toBe('extension');
    expect(publicKeyFromText(body.publicKey)).not.toBeNull();
    expect(String(reg.init!.body)).not.toContain('PRIVATE');
    expect(d.privateKeyPem).toContain('PRIVATE KEY');
    const logout = calls.find((c) => c.path === '/api/native/logout')!;
    expect(JSON.parse(String(logout.init!.body))).toEqual({ refresh_token: 'RT' });
  });

  it('a server without the relay is told before anyone signs in', async () => {
    const { f, calls } = fakeServer({ relay: false });
    await expect(pairWithServer({ server: 'https://cascade.test', name: 'Chrome', fetch: f, sleep: async () => {}, onCode: () => {} })).rejects.toThrow(/does not offer/);
    expect(calls.map((c) => c.path)).toEqual(['/api/browser-relay/server']);
  });

  it('a server whose identity changed between the calls pairs nothing, and the sign-in is still revoked', async () => {
    const { f, calls } = fakeServer({ regKey: publicKeyToText(createIdentity('x').publicKey) });
    await expect(pairWithServer({ server: 'https://cascade.test', name: 'Chrome', fetch: f, sleep: async () => {}, onCode: () => {} })).rejects.toThrow(/identity/);
    expect(calls.some((c) => c.path === '/api/native/logout')).toBe(true);
  });

  it('connects back to the server it paired with', () => {
    expect(endpointsOf({ serverUrl: 'https://cascade.test', ...info })).toEqual({ controlUrl: 'wss://cascade.test/api/browser-relay/control', runUrl: 'wss://cascade.test/api/browser-relay/run' });
  });
});
