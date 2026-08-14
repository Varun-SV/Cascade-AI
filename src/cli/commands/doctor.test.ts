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

  it('does not count an Azure key whose resource is ambiguous', () => {
    // Adoption scopes an Azure key to ONE resource and refuses when several
    // remain, so counting "some deployment is configured" reported a key as
    // usable that `cascade link` rejects a moment later. Doctor makes no
    // attempt and prints no follow-up, so an optimistic answer here is simply
    // wrong.
    const detail = linkableCredentialsDetail(
      [cred({ provider: 'azure' })],
      [
        { type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com' },
        { type: 'azure', deploymentName: 'b', baseUrl: 'https://two.openai.azure.com' },
      ],
    );
    expect(detail).toBe('1 found, none usable — run `cascade link` to see why');
  });

  it('counts it again once the exported endpoint names the resource', () => {
    const detail = linkableCredentialsDetail(
      [cred({ provider: 'azure', baseUrl: 'https://two.openai.azure.com' })],
      [
        { type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com' },
        { type: 'azure', deploymentName: 'b', baseUrl: 'https://two.openai.azure.com' },
      ],
    );
    expect(detail).toBe('1 found (1 usable) — run `cascade link` to adopt');
  });

  it('does not count an Azure key whose endpoint matches no configured deployment', () => {
    const detail = linkableCredentialsDetail(
      [cred({ provider: 'azure', baseUrl: 'https://elsewhere.openai.azure.com' })],
      [{ type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com' }],
    );
    expect(detail).toBe('1 found, none usable — run `cascade link` to see why');
  });

  it('does not count a fully routed Azure key whose deployment name is taken', () => {
    // `directlyUsable` is true here — the environment carried endpoint AND
    // deployment — so an `||` short-circuit skipped the check entirely. But
    // adoption refuses this: a deployment name is the model id, and the router
    // would never select the second row.
    const detail = linkableCredentialsDetail(
      [cred({
        provider: 'azure', directlyUsable: true,
        baseUrl: 'https://two.openai.azure.com', deploymentName: 'prod',
      })],
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com' }],
    );
    expect(detail).toBe('1 found, none usable — run `cascade link` to see why');
  });

  it('counts a fully routed Azure key against a row that has no endpoint yet', () => {
    // Adoption recognises that row as the same deployment and fills in its
    // endpoint, so treating the absent endpoint as "a different resource" made
    // doctor report unusable a credential `cascade link azure` accepts
    // immediately afterwards. Both now ask one function.
    const detail = linkableCredentialsDetail(
      [cred({
        provider: 'azure', directlyUsable: true,
        baseUrl: 'https://one.openai.azure.com', deploymentName: 'prod',
      })],
      [{ type: 'azure', deploymentName: 'prod' }],
    );
    expect(detail).toBe('1 found (1 usable) — run `cascade link` to adopt');
  });

  it('counts a fully routed Azure key whose deployment name is free', () => {
    const detail = linkableCredentialsDetail(
      [cred({
        provider: 'azure', directlyUsable: true,
        baseUrl: 'https://two.openai.azure.com', deploymentName: 'mini',
      })],
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com' }],
    );
    expect(detail).toBe('1 found (1 usable) — run `cascade link` to adopt');
  });

  it('counts an updated deployment on the resource that already owns the name', () => {
    // Same name, SAME resource, is an update — not a collision.
    const detail = linkableCredentialsDetail(
      [cred({
        provider: 'azure', directlyUsable: true,
        baseUrl: 'https://one.openai.azure.com/', deploymentName: 'prod',
      })],
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com' }],
    );
    expect(detail).toBe('1 found (1 usable) — run `cascade link` to adopt');
  });

  it('does not count an Azure key when every configured row lacks an endpoint', () => {
    // Normalising an absent endpoint to '' made a config of nothing but
    // endpointless rows look like ONE unambiguous resource. linkCommand
    // refuses these at its own gate, and the rows could not route a request
    // anyway.
    const detail = linkableCredentialsDetail(
      [cred({ provider: 'azure' })],
      [{ type: 'azure', deploymentName: 'prod' }, { type: 'azure', deploymentName: 'mini' }],
    );
    expect(detail).toBe('1 found, none usable — run `cascade link` to see why');
  });

  it('counts an Azure key that names its deployment but not its endpoint', () => {
    // The deployment name pins the resource just as well as the endpoint does.
    const detail = linkableCredentialsDetail(
      [cred({ provider: 'azure', deploymentName: 'mini' })],
      [
        { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com' },
        { type: 'azure', deploymentName: 'mini', baseUrl: 'https://two.openai.azure.com' },
      ],
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
