// ─────────────────────────────────────────────
//  Cascade AI — `cascade doctor` reporting
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { linkableCredentialsDetail } from './doctor.js';
import type { DiscoveredCredential } from '../../config/credential-discovery.js';

const cred = (over: Partial<DiscoveredCredential>): DiscoveredCredential => ({
  provider: 'anthropic', sourceTool: 'Environment', kind: 'api-key',
  secret: 's', directlyUsable: false, ...over,
});

describe('what doctor says about discovered credentials', () => {
  it('offers `cascade link` when something would actually be adopted', () => {
    expect(linkableCredentialsDetail([cred({ directlyUsable: true }), cred({})]))
      .toBe('2 found (1 usable) — run `cascade link` to adopt');
  });

  it('does not prescribe adoption when nothing can be adopted', () => {
    // The case this exists for: a Claude Code subscription token is the only
    // credential on the machine, and `cascade link` is REQUIRED to refuse it.
    // Telling the user to run link anyway makes an unusable credential read as
    // a step they forgot to take.
    const detail = linkableCredentialsDetail([cred({ kind: 'oauth' })]);
    expect(detail).not.toContain('to adopt');
    expect(detail).toBe('1 found, none usable — run `cascade link` to see why');
  });

  it('counts a bearer the CONFIG can route, which link adopts', () => {
    // `directlyUsable` is the environment's view. A bearer exported without
    // ANTHROPIC_BASE_URL, beside an Anthropic provider that already has one, is
    // adopted by `cascade link` — so reporting "none usable" contradicted the
    // command a line later.
    const detail = linkableCredentialsDetail(
      [cred({ kind: 'bearer' })],
      [{ type: 'anthropic', baseUrl: 'https://gateway.internal' }],
    );
    expect(detail).toBe('1 found (1 usable) — run `cascade link` to adopt');
  });

  it('counts an Azure key against deployments already configured', () => {
    const detail = linkableCredentialsDetail(
      [cred({ provider: 'azure' })],
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://r.openai.azure.com' }],
    );
    expect(detail).toBe('1 found (1 usable) — run `cascade link` to adopt');
  });

  it('does not count a subscription token just because a gateway is configured', () => {
    // Routing is not the obstacle for this one — the provider refuses it.
    const detail = linkableCredentialsDetail(
      [cred({ kind: 'oauth' })],
      [{ type: 'anthropic', baseUrl: 'https://gateway.internal' }],
    );
    expect(detail).toBe('1 found, none usable — run `cascade link` to see why');
  });
});
