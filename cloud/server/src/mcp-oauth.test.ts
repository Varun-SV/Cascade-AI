import { describe, expect, it, vi, beforeEach } from 'vitest';

// The refresh leg is the only thing we stub — everything else (encryption,
// the store, the resolver's own bookkeeping) runs for real, because the bug
// being pinned is about how those parts interleave.
const refreshCalls: string[] = [];
let refreshDelayMs = 0;

vi.mock('#cascade-ai', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('#cascade-ai');
  return {
    ...actual,
    refreshMcpToken: vi.fn(async (input: { refreshToken: string }) => {
      refreshCalls.push(input.refreshToken);
      if (refreshDelayMs) await new Promise((r) => setTimeout(r, refreshDelayMs));
      // A rotating authorization server: each refresh retires the token it was
      // given and issues a new pair.
      const n = refreshCalls.length;
      return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, token_type: 'Bearer', expires_in: 3600 };
    }),
  };
});

const { resolveRunMcpServers } = await import('./mcp-oauth.js');
const { encryptAtRest } = await import('./secrets.js');

const SECRET = 'test-secret-value-for-mcp-oauth-tests';

/** Minimal store standing in for CloudStore's three OAuth touchpoints. */
function fakeStore(initialBlob: string) {
  const blobs = new Map<string, string>([['srv1', initialBlob]]);
  return {
    writes: [] as string[],
    listEnabledMcpServerRows() {
      return [{ id: 'srv1', name: 'notion', url: 'https://notion.example.com/mcp', headers_json: null, oauth_json: blobs.get('srv1') ?? null }];
    },
    getMcpServerOAuth(id: string) { return blobs.get(id) ?? null; },
    updateMcpServerOAuth(id: string, _userId: string, oauthJson: string) {
      blobs.set(id, oauthJson);
      this.writes.push(oauthJson);
      return true;
    },
  };
}

/** An OAuth record already past its expiry, so every resolve wants a refresh. */
function expiredBlob(): string {
  return encryptAtRest(JSON.stringify({
    clientInformation: { client_id: 'client-1' },
    tokens: { access_token: 'access-0', refresh_token: 'refresh-0', token_type: 'Bearer' },
    authorizationServerUrl: 'https://auth.example.com',
    expiresAt: Date.now() - 1000,
  }), SECRET);
}

describe('resolveRunMcpServers — concurrent refresh', () => {
  beforeEach(() => { refreshCalls.length = 0; refreshDelayMs = 0; });

  it('refreshes ONCE when tool discovery and a run start race', async () => {
    // The real pairing: /api/mcp/:id/tools and runChatTurnInner both resolve the
    // same user's servers. Unserialised, both present `refresh-0`; the AS
    // retires it on the first, the second 401s, and the resolver's catch drops
    // the connector from that caller's list — the run silently loses its tools.
    refreshDelayMs = 25;
    const store = fakeStore(expiredBlob());

    const [a, b] = await Promise.all([
      resolveRunMcpServers(store as never, 'user-1', SECRET),
      resolveRunMcpServers(store as never, 'user-1', SECRET),
    ]);

    expect(refreshCalls).toEqual(['refresh-0']);   // never re-presented
    expect(store.writes.length).toBe(1);
    // Both callers get a working connector, and the SAME token.
    expect(a[0]?.headers?.Authorization).toBe('Bearer access-1');
    expect(b[0]?.headers?.Authorization).toBe('Bearer access-1');
  });

  it('re-reads the row inside the lock instead of reusing its stale copy', async () => {
    // The second caller captured `row.oauth_json` before waiting. If it decrypts
    // that copy it sees the retired refresh token; re-reading picks up what the
    // first caller just persisted, which is still fresh, so it refreshes zero
    // times rather than once more.
    refreshDelayMs = 25;
    const store = fakeStore(expiredBlob());

    await Promise.all([
      resolveRunMcpServers(store as never, 'user-1', SECRET),
      resolveRunMcpServers(store as never, 'user-1', SECRET),
      resolveRunMcpServers(store as never, 'user-1', SECRET),
    ]);

    expect(refreshCalls.length).toBe(1);
  });

  it('releases the lock when a refresh throws, so the next caller still runs', async () => {
    const store = fakeStore(expiredBlob());
    const mod = await import('#cascade-ai');
    const spy = vi.mocked(mod.refreshMcpToken);
    spy.mockRejectedValueOnce(new Error('authorization server said no'));

    const first = await resolveRunMcpServers(store as never, 'user-1', SECRET);
    expect(first[0]?.headers).toBeUndefined();  // dropped — the user can reconnect
    expect(first.length).toBe(0);

    const second = await resolveRunMcpServers(store as never, 'user-1', SECRET);
    expect(second[0]?.headers?.Authorization).toMatch(/^Bearer access-/);
  });
});
