// ─────────────────────────────────────────────
//  Cascade AI — safeFetch and DNS rebinding
// ─────────────────────────────────────────────
//
//  Its own file because it mocks BOTH dns modules at the module level, which
//  would change what every other safe-fetch test resolves.
//
//  The attack this pins: `assertPublicUrl` resolves a hostname to decide
//  whether to proceed, then `fetch` resolves it again to open the socket. An
//  attacker who controls DNS for the name they supply can answer publicly for
//  the first lookup and privately for the second, and a pre-flight check —
//  however strict — cannot see that happen. The fix validates inside the
//  resolution the connection itself uses, so the two cannot disagree.

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What each of the two lookups answers. Mutable so a test can make them differ. */
const dnsAnswers = {
  preflight: [{ address: '93.184.216.34', family: 4 }],
  connect: [{ address: '93.184.216.34', family: 4 }],
};

vi.mock('node:dns/promises', () => ({
  default: { lookup: async () => dnsAnswers.preflight },
}));

vi.mock('node:dns', () => ({
  default: {
    lookup: (
      _hostname: string,
      options: { all?: boolean },
      callback: (err: Error | null, addr?: unknown, family?: number) => void,
    ) => {
      const list = dnsAnswers.connect;
      if (options?.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    },
  },
}));

const { safeFetch } = await import('./safe-fetch.js');

describe('safeFetch — DNS rebinding', () => {
  beforeEach(() => {
    delete process.env['CASCADE_ALLOW_LOCAL_FETCH'];
    dnsAnswers.preflight = [{ address: '93.184.216.34', family: 4 }];
    dnsAnswers.connect = [{ address: '93.184.216.34', family: 4 }];
  });

  it('blocks a host that passes the pre-flight check and then resolves privately', async () => {
    // Public for assertPublicUrl…
    dnsAnswers.preflight = [{ address: '93.184.216.34', family: 4 }];
    // …and loopback by the time the socket is opened.
    dnsAnswers.connect = [{ address: '127.0.0.1', family: 4 }];

    const err = await safeFetch('http://rebind.example/').then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err, 'the request should not have succeeded').not.toBeNull();
    // fetch wraps a connect-time failure, so the reason is on the cause.
    const reason = String((err as { cause?: unknown }).cause ?? err?.message ?? '');
    expect(reason).toMatch(/non-public address 127\.0\.0\.1/);
  });

  it('blocks the cloud metadata address on the second resolution too', async () => {
    dnsAnswers.preflight = [{ address: '93.184.216.34', family: 4 }];
    dnsAnswers.connect = [{ address: '169.254.169.254', family: 4 }];

    const err = await safeFetch('http://metadata-rebind.example/').then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).not.toBeNull();
    const reason = String((err as { cause?: unknown }).cause ?? err?.message ?? '');
    expect(reason).toMatch(/169\.254\.169\.254/);
  });

  it('rejects when ANY resolved address is private, not just the first', async () => {
    // A rebinding answer often carries a good address alongside the bad one,
    // betting the checker looks at [0] and the connector picks another.
    dnsAnswers.preflight = [{ address: '93.184.216.34', family: 4 }];
    dnsAnswers.connect = [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];

    const err = await safeFetch('http://mixed-rebind.example/').then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).not.toBeNull();
    const reason = String((err as { cause?: unknown }).cause ?? err?.message ?? '');
    expect(reason).toMatch(/10\.0\.0\.5/);
  });

  it('lets the connect-time check through when CASCADE_ALLOW_LOCAL_FETCH is set', async () => {
    // The documented escape hatch for local dev has to survive this, or
    // pointing web_fetch at a local docs server stops working.
    process.env['CASCADE_ALLOW_LOCAL_FETCH'] = '1';
    dnsAnswers.preflight = [{ address: '127.0.0.1', family: 4 }];
    dnsAnswers.connect = [{ address: '127.0.0.1', family: 4 }];

    const err = await safeFetch('http://localhost:1/').then(
      () => null,
      (e: unknown) => e as Error,
    );

    // It still fails — nothing is listening on port 1 — but it must fail as a
    // connection error, NOT as an SSRF block.
    const reason = String((err as { cause?: unknown })?.cause ?? err?.message ?? '');
    expect(reason).not.toMatch(/non-public address/);
  });
});
