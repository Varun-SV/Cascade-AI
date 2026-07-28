import { describe, it, expect, vi } from 'vitest';
import { McpOAuthProvider, withOAuthStoreLock, type McpOAuthState, type McpOAuthStore } from './oauth.js';

/** An in-memory store to observe what the provider persists. */
function memStore(initial?: McpOAuthState) {
  let state: McpOAuthState | undefined = initial;
  const store: McpOAuthStore = {
    load: () => state,
    save: (s) => { state = { ...s }; },
    clear: () => { state = undefined; },
  };
  return { store, get: () => state };
}

describe('McpOAuthProvider', () => {
  it('advertises a public-client registration (PKCE, no secret)', () => {
    const { store } = memStore();
    const p = new McpOAuthProvider({ redirectUrl: 'https://app.example/cb', store, redirect: () => {}, scope: 'read' });
    const md = p.clientMetadata;
    expect(md.redirect_uris).toEqual(['https://app.example/cb']);
    expect(md.token_endpoint_auth_method).toBe('none'); // public client
    expect(md.grant_types).toContain('authorization_code');
    expect(md.grant_types).toContain('refresh_token');
    expect(md.scope).toBe('read');
  });

  it('persists client info, tokens, and the PKCE verifier through the store', async () => {
    const { store, get } = memStore();
    const p = new McpOAuthProvider({ redirectUrl: 'http://127.0.0.1:1/callback', store, redirect: () => {} });

    await p.saveClientInformation({ client_id: 'dcr-123', redirect_uris: ['http://127.0.0.1:1/callback'] } as never);
    await p.saveCodeVerifier('verifier-xyz');
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' } as never);

    expect(get()?.clientInformation?.client_id).toBe('dcr-123');
    expect(get()?.codeVerifier).toBe('verifier-xyz');
    expect(get()?.tokens?.access_token).toBe('at');

    // A fresh provider over the same store reads them back.
    const p2 = new McpOAuthProvider({ redirectUrl: 'http://127.0.0.1:1/callback', store, redirect: () => {} });
    expect((await p2.clientInformation())?.client_id).toBe('dcr-123');
    expect(await p2.codeVerifier()).toBe('verifier-xyz');
    expect((await p2.tokens())?.refresh_token).toBe('rt');
  });

  it('calls the redirect strategy with the authorization URL', async () => {
    const { store } = memStore();
    const redirect = vi.fn();
    const p = new McpOAuthProvider({ redirectUrl: 'https://x/cb', store, redirect });
    await p.redirectToAuthorization(new URL('https://as.example/authorize?x=1'));
    expect(redirect).toHaveBeenCalledWith(new URL('https://as.example/authorize?x=1'));
  });

  it('invalidateCredentials clears the requested scope', async () => {
    const { store, get } = memStore();
    const p = new McpOAuthProvider({ redirectUrl: 'https://x/cb', store, redirect: () => {} });
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer' } as never);
    await p.saveCodeVerifier('v');
    await p.invalidateCredentials('tokens');
    expect(get()?.tokens).toBeUndefined();
    expect(get()?.codeVerifier).toBe('v'); // untouched
  });

  it('uses a fixed state when provided (cloud pending-flow key)', () => {
    const { store } = memStore();
    const p = new McpOAuthProvider({ redirectUrl: 'https://x/cb', store, redirect: () => {}, state: 'fixed-state' });
    expect(p.state()).toBe('fixed-state');
    expect(p.oauthState).toBe('fixed-state');
  });
});

describe('withOAuthStoreLock', () => {
  it('runs operations on the SAME store path one at a time, in order', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const op = (label: string, ms: number) => withOAuthStoreLock('/tmp/srv.json', async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      order.push(label);
      inFlight--;
    });
    await Promise.all([op('discovery', 20), op('run', 5)]);
    expect(maxConcurrent).toBe(1);
    // 'discovery' started first and held the lock, so it finishes first too —
    // this is the actual guarantee: a run's connect never overlaps discovery's.
    expect(order).toEqual(['discovery', 'run']);
  });

  it('lets DIFFERENT store paths run fully in parallel', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const op = (path: string) => withOAuthStoreLock(path, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
    });
    await Promise.all([op('/tmp/a.json'), op('/tmp/b.json')]);
    expect(maxConcurrent).toBe(2);
  });

  it('releases the lock when an operation throws, so the next caller still runs', async () => {
    const first = withOAuthStoreLock('/tmp/c.json', async () => { throw new Error('refresh failed'); });
    await expect(first).rejects.toThrow('refresh failed');
    const second = await withOAuthStoreLock('/tmp/c.json', async () => 'ok');
    expect(second).toBe('ok');
  });
});
