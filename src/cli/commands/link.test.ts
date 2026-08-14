// ─────────────────────────────────────────────
//  Cascade AI — `cascade link` adoption
// ─────────────────────────────────────────────

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { linkCommand } from './link.js';
import { ConfigManager } from '../../config/index.js';
import { CASCADE_CONFIG_FILE } from '../../constants.js';

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AZURE_OPENAI_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY',
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION',
  'ANTHROPIC_BASE_URL',
  // HOME is redirected per test. linkCommand constructs its own ConfigManager,
  // which reads AND WRITES the machine-global credential store under the real
  // home — so without this the suite both leaked adopted state between tests
  // and wrote fake tokens into the developer's actual ~/.cascade-ai.
  'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR',
];

describe('cascade link — adoption', () => {
  let dir: string;
  let fakeHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-link-'));
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    fakeHome = path.join(dir, 'home');
    await fs.mkdir(fakeHome, { recursive: true });
    process.env['HOME'] = fakeHome;
    process.env['USERPROFILE'] = fakeHome;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function providersAfterLink(target: string): Promise<Array<Record<string, unknown>>> {
    await linkCommand(target, { workspace: dir, acceptRisk: true });
    const cm = new ConfigManager(dir);
    await cm.load();
    return cm.getConfig().providers as unknown as Array<Record<string, unknown>>;
  }

  async function seedConfig(providers: unknown[]): Promise<void> {
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    await fs.writeFile(
      path.join(dir, CASCADE_CONFIG_FILE),
      JSON.stringify({ providers, models: {}, tools: {} }),
      'utf-8',
    );
  }

  it('keeps a configured gateway endpoint when adopting a bearer token', async () => {
    // The provider entry is replaced wholesale, so building it from scratch
    // discarded baseUrl. Harmless while the Anthropic client ignored baseUrl;
    // now that it honours it, the gateway token would go to api.anthropic.com,
    // the one endpoint it is not valid at.
    await seedConfig([{ type: 'anthropic', baseUrl: 'https://gateway.internal/v1' }]);
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';

    const anthropic = (await providersAfterLink('anthropic')).find((p) => p['type'] === 'anthropic');
    expect(anthropic?.['authToken']).toBe('gw-token');
    expect(anthropic?.['baseUrl']).toBe('https://gateway.internal/v1');
  });

  it('replaces the previous credential rather than leaving both', async () => {
    await seedConfig([{ type: 'anthropic', apiKey: 'sk-ant-old' }]);
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    process.env['ANTHROPIC_BASE_URL'] = 'https://gateway.internal';

    const anthropic = (await providersAfterLink('anthropic')).find((p) => p['type'] === 'anthropic');
    expect(anthropic?.['authToken']).toBe('gw-token');
    expect(anthropic?.['apiKey']).toBeUndefined();
  });

  it('links an OpenAI-compatible service by name, with its endpoint', async () => {
    process.env['GROQ_API_KEY'] = 'groq-key';
    const compatible = (await providersAfterLink('groq')).find((p) => p['type'] === 'openai-compatible');
    expect(compatible?.['apiKey']).toBe('groq-key');
    expect(compatible?.['baseUrl']).toBe('https://api.groq.com/openai/v1');
  });

  it('picks the service that was NAMED, not whichever was found first', async () => {
    // They share one provider type, so matching on type alone configured
    // OpenRouter for `cascade link deepseek`.
    process.env['OPENROUTER_API_KEY'] = 'or-key';
    process.env['DEEPSEEK_API_KEY'] = 'ds-key';

    const compatible = (await providersAfterLink('deepseek')).find((p) => p['type'] === 'openai-compatible');
    expect(compatible?.['apiKey']).toBe('ds-key');
    expect(compatible?.['baseUrl']).toBe('https://api.deepseek.com/v1');
  });

  it('fills an Azure key into EVERY deployment without collapsing them', async () => {
    // Azure is configured one entry per deployment — the deployment name is the
    // model id. Replacing by provider type deleted every deployment but one,
    // and the save is authoritative for the global credential store, so they
    // would not come back.
    // Several deployments on ONE resource — the normal Azure setup, and the
    // case where a single key legitimately applies to all of them.
    await seedConfig([
      { type: 'azure', deploymentName: 'gpt-5-prod', baseUrl: 'https://acme.openai.azure.com' },
      { type: 'azure', deploymentName: 'gpt-5-mini-dev', baseUrl: 'https://acme.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'az-key';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(2);
    expect(azure.map((p) => p['deploymentName'])).toEqual(['gpt-5-prod', 'gpt-5-mini-dev']);
    expect(azure.every((p) => p['apiKey'] === 'az-key')).toBe(true);
  });

  it('refuses an Azure key with no routing anywhere', async () => {
    // Neither `cascade link` nor the environment injection may conjure an
    // Azure provider from a key: it would resolve to no model, while making
    // hasUsableProvider() true and skipping onboarding.
    process.env['AZURE_OPENAI_KEY'] = 'az-key';
    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(0);
  });

  it('creates one Azure provider when the environment carries full routing', async () => {
    process.env['AZURE_OPENAI_KEY'] = 'az-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://acme.openai.azure.com';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'gpt-5-prod';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(1);
    expect(azure[0]).toMatchObject({
      apiKey: 'az-key',
      baseUrl: 'https://acme.openai.azure.com',
      deploymentName: 'gpt-5-prod',
    });
  });

  it('does not carry `local: true` onto a hosted endpoint', async () => {
    // isLocalEndpoint() gives an explicit `local` precedence over the URL, so a
    // self-hosted entry's flag surviving onto Groq would price every paid model
    // at zero and slip the budget caps entirely.
    await seedConfig([
      { type: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', local: true },
    ]);
    process.env['GROQ_API_KEY'] = 'groq-key';

    const compatible = (await providersAfterLink('groq')).find((p) => p['type'] === 'openai-compatible');
    expect(compatible?.['baseUrl']).toBe('https://api.groq.com/openai/v1');
    expect(compatible?.['local']).toBeUndefined();
  });

  it('adopts the gateway bearer token without demanding --accept-risk', async () => {
    // ANTHROPIC_AUTH_TOKEN is the credential Anthropic documents for gateways.
    // Classifying it as a subscription token sent the documented command down
    // the risk-gate path and refused to persist it.
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    process.env['ANTHROPIC_BASE_URL'] = 'https://gateway.internal';
    await linkCommand('anthropic', { workspace: dir });   // note: no acceptRisk

    const cm = new ConfigManager(dir);
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    // `credentialSource` is set by adoption alone. Asserting on authToken would
    // pass either way: injectEnvKeys picks ANTHROPIC_AUTH_TOKEN up on load, so
    // the field is populated whether or not `link` ever ran.
    expect(anthropic?.credentialSource).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(anthropic?.authToken).toBe('gw-token');
    // The gateway comes with it — a bearer sent anywhere else is a leak.
    expect(anthropic?.baseUrl).toBe('https://gateway.internal');
  });

  it('accepts a bearer token when the WORKSPACE names the gateway', async () => {
    // Discovery sees env vars only, so it marks an endpoint-less bearer
    // unusable — but its own warning tells the user to configure `baseUrl`,
    // which this path has to then honour.
    await seedConfig([{ type: 'anthropic', baseUrl: 'https://gateway.internal' }]);
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';

    const anthropic = (await providersAfterLink('anthropic')).find((p) => p['type'] === 'anthropic');
    expect(anthropic?.['authToken']).toBe('gw-token');
    expect(anthropic?.['baseUrl']).toBe('https://gateway.internal');
    expect(anthropic?.['credentialSource']).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('does not claim success when Azure adoption declines', async () => {
    // Two resources, nothing to choose between them: adoption explains and
    // changes nothing, so the caller must not print "✓ Linked" over that.
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' },
      { type: 'azure', deploymentName: 'dev', baseUrl: 'https://two.openai.azure.com', apiKey: 'key-two' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';

    const said: string[] = [];
    (console.log as unknown as { mockImplementation: (f: (m?: unknown) => void) => void })
      .mockImplementation((m?: unknown) => { said.push(String(m ?? '')); });
    await linkCommand('azure', { workspace: dir, acceptRisk: true });

    expect(said.join('\n')).not.toMatch(/✓ Linked/);
    expect(said.join('\n')).toMatch(/Several Azure resources/);
  });

  it('refuses a bearer token when no gateway is known', async () => {
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    await linkCommand('anthropic', { workspace: dir, acceptRisk: true });

    const cm = new ConfigManager(dir);
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.credentialSource).toBeUndefined();
  });

  it('gives an Azure key only to the resource it belongs to', async () => {
    // Azure keys are resource-scoped. Writing one across every deployment
    // breaks the ones on other resources and overwrites keys they already had
    // — permanently, since the save is authoritative for the global store.
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' },
      { type: 'azure', deploymentName: 'dev', baseUrl: 'https://two.openai.azure.com', apiKey: 'key-two' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'prod';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(2);
    expect(azure.find((p) => p['deploymentName'] === 'prod')?.['apiKey']).toBe('new-key');
    // The other resource is untouched.
    expect(azure.find((p) => p['deploymentName'] === 'dev')?.['apiKey']).toBe('key-two');
  });

  it('adds a fully routed deployment rather than refusing it', async () => {
    // The credential names its own endpoint AND deployment, so there is nothing
    // to infer. Requiring the endpoint to already exist refused a key that
    // carried everything needed to configure it.
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://two.openai.azure.com';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'staging';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(2);
    const added = azure.find((p) => p['deploymentName'] === 'staging');
    expect(added).toMatchObject({ apiKey: 'new-key', baseUrl: 'https://two.openai.azure.com' });
    // The existing resource keeps its own key.
    expect(azure.find((p) => p['deploymentName'] === 'prod')?.['apiKey']).toBe('key-one');
  });

  it('adds a new deployment on a resource that already has one', async () => {
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'mini';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure.map((p) => p['deploymentName']).sort()).toEqual(['mini', 'prod']);
  });

  it('refuses to guess when several Azure resources are configured', async () => {
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' },
      { type: 'azure', deploymentName: 'dev', baseUrl: 'https://two.openai.azure.com', apiKey: 'key-two' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure.map((p) => p['apiKey'])).toEqual(['key-one', 'key-two']);
  });

  it('links an Azure key when the WORKSPACE supplies the routing', async () => {
    // Discovery only sees env vars, so a key exported beside already-configured
    // deployments looked unusable — making the fill-into-deployments path
    // reachable only by re-exporting routing the config already had.
    await seedConfig([
      { type: 'azure', deploymentName: 'gpt-5-prod', baseUrl: 'https://prod.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'az-key';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(1);
    expect(azure[0]).toMatchObject({
      apiKey: 'az-key',
      deploymentName: 'gpt-5-prod',
      baseUrl: 'https://prod.openai.azure.com',
      // Adoption stamps this; injectEnvKeys also fills the key into an existing
      // entry, so without it the assertion would hold even if link had bailed.
      credentialSource: 'Environment (AZURE_OPENAI_KEY)',
    });
  });

  it('updates the existing deployment when the endpoint differs by a trailing slash', async () => {
    // The provider strips trailing slashes before it builds a client, so these
    // address the same service. Comparing them as typed missed the row and
    // appended a DUPLICATE — and the router takes the first row matching a
    // deployment name, so it kept using the old keyless one while link printed
    // "✓ Linked".
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com/';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'prod';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(1);
    expect(azure[0]).toMatchObject({ deploymentName: 'prod', apiKey: 'new-key' });
  });

  it('sends a newly linked key to the gateway exported with it', async () => {
    // Adoption keeps fields the credential says nothing about, and discovery
    // attached ANTHROPIC_BASE_URL only to the bearer — so linking an exported
    // API key left the stale endpoint in place and sent the new key to the host
    // that did not issue it. injectEnvKeys cannot cover this one: the entry is
    // already credentialed, so it skips it.
    await seedConfig([{ type: 'anthropic', apiKey: 'old-key', baseUrl: 'https://old-gateway.internal' }]);
    process.env['ANTHROPIC_API_KEY'] = 'new-key';
    process.env['ANTHROPIC_BASE_URL'] = 'https://new-gateway.internal';

    const providers = await providersAfterLink('anthropic');
    expect(providers.find((p) => p['type'] === 'anthropic')).toMatchObject({
      apiKey: 'new-key',
      baseUrl: 'https://new-gateway.internal',
    });
  });

  it('links an Azure key when the endpoint names the resource but no deployment came with it', async () => {
    // The configured deployments already supply the routing, and the exported
    // endpoint says which resource — nothing is ambiguous. Counting every
    // configured resource before narrowing refused the key, and because the
    // refusal returns before the write, nothing was persisted.
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com' },
      { type: 'azure', deploymentName: 'dev', baseUrl: 'https://two.openai.azure.com', apiKey: 'key-two' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure.find((p) => p['deploymentName'] === 'prod')).toMatchObject({
      apiKey: 'new-key',
      credentialSource: 'Environment (AZURE_OPENAI_KEY)',
    });
    // The other resource is untouched — an Azure key belongs to one of them.
    expect(azure.find((p) => p['deploymentName'] === 'dev')?.['apiKey']).toBe('key-two');
  });

  it('rotates the key across EVERY deployment on the named resource', async () => {
    // An Azure key is resource-scoped. Keying only the deployment that
    // AZURE_OPENAI_DEPLOYMENT names left its siblings holding the previous key
    // — and injectEnvKeys skips rows that already have one — so once the old
    // key was revoked every other deployment on that resource failed.
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com', apiKey: 'old-key' },
      { type: 'azure', deploymentName: 'mini', baseUrl: 'https://one.openai.azure.com', apiKey: 'old-key' },
      { type: 'azure', deploymentName: 'dev', baseUrl: 'https://two.openai.azure.com', apiKey: 'other-resource' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'prod';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure.find((p) => p['deploymentName'] === 'prod')?.['apiKey']).toBe('new-key');
    expect(azure.find((p) => p['deploymentName'] === 'mini')?.['apiKey']).toBe('new-key');
    // The other resource is untouched — the key does not belong to it.
    expect(azure.find((p) => p['deploymentName'] === 'dev')?.['apiKey']).toBe('other-resource');
  });

  it('fills an endpointless row rather than calling it another resource\'s', async () => {
    // A row with this deployment name and NO endpoint is this deployment
    // waiting for one — and the credential supplies exactly what it lacks.
    // Treating it as a collision refused a link that had everything it needed.
    await seedConfig([{ type: 'azure', deploymentName: 'prod' }]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'prod';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(1);
    expect(azure[0]).toMatchObject({
      deploymentName: 'prod',
      baseUrl: 'https://one.openai.azure.com',
      apiKey: 'new-key',
    });
  });

  it('still refuses when the name belongs to a DIFFERENT configured resource', async () => {
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://two.openai.azure.com';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'prod';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(1);
    expect(azure[0]).toMatchObject({ baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' });
  });

  it('applies the exported API version to the deployments it keys', async () => {
    // The fully routed branch carries apiVersion; this one dropped it, leaving
    // each deployment on its stale or default version while the user had
    // exported the one they meant — and a deployment that requires a preview
    // version fails on its first request.
    await seedConfig([
      { type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com', apiVersion: '2023-05-15' },
      { type: 'azure', deploymentName: 'b', baseUrl: 'https://one.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com';
    process.env['AZURE_OPENAI_API_VERSION'] = '2026-01-01-preview';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure.every((p) => p['apiVersion'] === '2026-01-01-preview')).toBe(true);
  });

  it('leaves each deployment its own API version when none was exported', async () => {
    await seedConfig([
      { type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com', apiVersion: '2023-05-15' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure[0]?.['apiVersion']).toBe('2023-05-15');
  });

  it('scopes by the exported deployment name when no endpoint came with it', async () => {
    // AZURE_OPENAI_DEPLOYMENT alone identifies the resource, via the row that
    // already carries that name — so the key is not ambiguous and was being
    // refused as though it were.
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com' },
      { type: 'azure', deploymentName: 'mini', baseUrl: 'https://two.openai.azure.com' },
      { type: 'azure', deploymentName: 'mini-b', baseUrl: 'https://two.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'mini';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    // Its whole resource is keyed — an Azure key is resource-scoped.
    expect(azure.find((p) => p['deploymentName'] === 'mini')?.['apiKey']).toBe('new-key');
    expect(azure.find((p) => p['deploymentName'] === 'mini-b')?.['apiKey']).toBe('new-key');
    expect(azure.find((p) => p['deploymentName'] === 'prod')?.['apiKey']).toBeUndefined();
    // `credentialSource` is stamped by ADOPTION only — injectEnvKeys fills the
    // same key into the same rows, so without this the assertions above would
    // hold even if `cascade link` had bailed out entirely.
    expect(azure.find((p) => p['deploymentName'] === 'mini')?.['credentialSource'])
      .toBe('Environment (AZURE_OPENAI_KEY)');
  });

  it('refuses when the configured deployments have no endpoint at all', async () => {
    await seedConfig([{ type: 'azure', deploymentName: 'prod' }]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure[0]?.['apiKey']).toBeUndefined();
  });

  it('still refuses when several resources are configured and none is named', async () => {
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' },
      { type: 'azure', deploymentName: 'dev', baseUrl: 'https://two.openai.azure.com', apiKey: 'key-two' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure.map((p) => p['apiKey'])).toEqual(['key-one', 'key-two']);
  });

  it('refuses a deployment name another resource already claims', async () => {
    // A deployment name IS the model id, and the router binds an Azure model to
    // the first row whose deploymentName matches — endpoint not consulted. So
    // appending the second `prod` created a row that can never be selected,
    // while link printed "✓ Linked" and requests carried on to the other
    // resource.
    await seedConfig([
      { type: 'azure', deploymentName: 'prod', baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'new-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://two.openai.azure.com';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'prod';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(1);
    expect(azure[0]).toMatchObject({ baseUrl: 'https://one.openai.azure.com', apiKey: 'key-one' });
  });

  it('refuses to guess which compatible service a bare target meant', async () => {
    // They all share one provider type, so the first directly-usable candidate
    // won — leaving the choice to the order of a table in
    // credential-discovery.ts and silently configuring OpenRouter for someone
    // who meant Groq.
    process.env['OPENROUTER_API_KEY'] = 'or-key';
    process.env['GROQ_API_KEY'] = 'groq-key';

    const providers = await providersAfterLink('openai-compatible');
    expect(providers.find((p) => p['type'] === 'openai-compatible')).toBeUndefined();
  });

  it('adopts the service the target names, with both keys set', async () => {
    process.env['OPENROUTER_API_KEY'] = 'or-key';
    process.env['GROQ_API_KEY'] = 'groq-key';

    const providers = await providersAfterLink('groq');
    expect(providers.find((p) => p['type'] === 'openai-compatible')).toMatchObject({
      apiKey: 'groq-key',
      baseUrl: 'https://api.groq.com/openai/v1',
    });
  });

  it('still adopts a bare target when only one compatible key is set', async () => {
    process.env['OPENROUTER_API_KEY'] = 'or-key';

    const providers = await providersAfterLink('openai-compatible');
    expect(providers.find((p) => p['type'] === 'openai-compatible')).toMatchObject({
      apiKey: 'or-key',
    });
  });

  it('says --accept-risk no longer applies rather than ignoring it', async () => {
    // The flag used to be the documented way past this refusal. It is inert
    // now — a subscription token is refused by the provider, so there is no
    // working configuration to opt into — and silently swallowing it would
    // leave the user waiting for an effect that is never coming.
    await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(fakeHome, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x' } }),
      'utf-8',
    );

    await linkCommand('anthropic', { workspace: dir, acceptRisk: true });
    const printed = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toMatch(/--accept-risk no longer applies/);
  });

  it('refuses a Claude Code subscription token even with --accept-risk', async () => {
    // The flag used to be the way to adopt exactly this. Anthropic prohibits
    // it and refuses it at the API, so no flag should get it configured.
    await fs.mkdir(path.join(fakeHome, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(fakeHome, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x' } }),
      'utf-8',
    );

    const providers = await providersAfterLink('anthropic');
    const anthropic = providers.find((p) => p['type'] === 'anthropic');
    expect(anthropic?.['authToken']).toBeUndefined();
    expect(anthropic?.['apiKey']).toBeUndefined();
  });
});
