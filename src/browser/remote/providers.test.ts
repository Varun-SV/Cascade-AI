// ─────────────────────────────────────────────
//  Cascade AI — remote browser providers
// ─────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GenericCdpProvider, isCdpEndpoint } from './generic-cdp.js';
import { SteelProvider } from './steel.js';

/** Stand in for global fetch, recording what the provider asked for. */
function stubFetch(responses: Array<{ ok?: boolean; status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { ok: true, body: {} };
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => next.text ?? '',
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the generic CDP endpoint', () => {
  it('hands back the endpoint it was given', async () => {
    const session = await new GenericCdpProvider('wss://browser.internal:9222/').createSession();
    expect(session.cdpUrl).toBe('wss://browser.internal:9222/');
  });

  it('offers no live view, because it has no session API to ask one for', async () => {
    // Callers must cope with this rather than assume every provider has one.
    const session = await new GenericCdpProvider('ws://localhost:9222').createSession();
    expect(session.liveViewUrl).toBeUndefined();
  });

  it('does not close a browser it does not own', async () => {
    // The endpoint belongs to whoever runs it and outlives any one run. On a
    // shared endpoint, "ending" it would take the browser away from everyone
    // else using it.
    const provider = new GenericCdpProvider('ws://localhost:9222');
    await expect(provider.endSession('cdp')).resolves.toBeUndefined();
  });

  it('recognises only websocket endpoints', () => {
    // An http:// URL copied from a provider's docs is the likely mistake, and
    // naming it at startup beats an obscure Playwright failure on first use.
    expect(isCdpEndpoint('ws://localhost:9222')).toBe(true);
    expect(isCdpEndpoint('wss://x.example/session/abc')).toBe(true);
    expect(isCdpEndpoint('https://x.example')).toBe(false);
    expect(isCdpEndpoint('not a url')).toBe(false);
    expect(isCdpEndpoint('')).toBe(false);
  });
});

describe('Steel', () => {
  it('creates a session and maps its fields onto the seam', async () => {
    // Field names verified against the API source, not docs: websocketUrl is
    // the CDP endpoint and debugUrl is the live view.
    const calls = stubFetch([{ body: { id: 'sess-1', websocketUrl: 'wss://s/cdp', debugUrl: 'https://s/debug' } }]);
    const session = await new SteelProvider({ url: 'https://steel.test' }).createSession();

    expect(calls[0]?.url).toBe('https://steel.test/v1/sessions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(session).toEqual({ id: 'sess-1', cdpUrl: 'wss://s/cdp', liveViewUrl: 'https://s/debug' });
  });

  it('refuses a session with nothing to drive', async () => {
    // Failing here names the problem; passing undefined to connectOverCDP
    // fails later and somewhere else.
    stubFetch([{ body: { id: 'sess-1' } }]);
    await expect(new SteelProvider().createSession()).rejects.toThrow(/no id or websocket/i);
  });

  it('omits the live view rather than inventing one', async () => {
    stubFetch([{ body: { id: 'sess-1', websocketUrl: 'wss://s/cdp' } }]);
    const session = await new SteelProvider().createSession();
    expect(session).not.toHaveProperty('liveViewUrl');
  });

  it('sends the API key only when there is one', async () => {
    // The self-hosted API takes no key, and an empty header is worse than none.
    const withKey = stubFetch([{ body: { id: 'a', websocketUrl: 'wss://s' } }]);
    await new SteelProvider({ apiKey: 'secret' }).createSession();
    expect((withKey[0]?.init.headers as Record<string, string>)['steel-api-key']).toBe('secret');

    vi.unstubAllGlobals();
    const without = stubFetch([{ body: { id: 'a', websocketUrl: 'wss://s' } }]);
    await new SteelProvider().createSession();
    expect(without[0]?.init.headers as Record<string, string>).not.toHaveProperty('steel-api-key');
  });

  it('does not produce a double slash when the base has a trailing one', async () => {
    // Some gateways 404 on `//v1/sessions`, which reads as a wrong endpoint
    // rather than a formatting slip.
    const calls = stubFetch([{ body: { id: 'a', websocketUrl: 'wss://s' } }]);
    await new SteelProvider({ url: 'https://steel.test/' }).createSession();
    expect(calls[0]?.url).toBe('https://steel.test/v1/sessions');
  });

  it('carries the failure body into the error', async () => {
    // Quota, bad key and wrong region all arrive as a status code; without the
    // body every one of them reads as an unexplained number.
    stubFetch([{ ok: false, status: 402, text: 'session quota exceeded' }]);
    await expect(new SteelProvider().createSession()).rejects.toThrow(/402.*quota exceeded/i);
  });

  it('releases the session it was given', async () => {
    const calls = stubFetch([{ body: {} }]);
    await new SteelProvider({ url: 'https://steel.test' }).endSession('sess-1');
    expect(calls[0]?.url).toBe('https://steel.test/v1/sessions/sess-1/release');
  });

  it('does not turn a failed release into a failed run', async () => {
    // Release is cleanup, usually running while a run is already ending. A
    // provider that is briefly unreachable must not escalate that into an
    // error the user sees; its own idle timeout collects the session.
    stubFetch([{ ok: false, status: 503, text: 'upstream down' }]);
    await expect(new SteelProvider().endSession('sess-1')).resolves.toBeUndefined();
  });

  it('escapes a session id rather than splicing it into the path', async () => {
    const calls = stubFetch([{ body: {} }]);
    await new SteelProvider({ url: 'https://steel.test' }).endSession('a/../b');
    expect(calls[0]?.url).toBe('https://steel.test/v1/sessions/a%2F..%2Fb/release');
  });
});
