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
    await seedConfig([
      { type: 'azure', deploymentName: 'gpt-5-prod', baseUrl: 'https://prod.openai.azure.com' },
      { type: 'azure', deploymentName: 'gpt-5-mini-dev', baseUrl: 'https://dev.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'az-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://acme.openai.azure.com';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'whatever';

    const azure = (await providersAfterLink('azure')).filter((p) => p['type'] === 'azure');
    expect(azure).toHaveLength(2);
    expect(azure.map((p) => p['deploymentName'])).toEqual(['gpt-5-prod', 'gpt-5-mini-dev']);
    // Each keeps its own endpoint, and each gets the key.
    expect(azure.map((p) => p['baseUrl']))
      .toEqual(['https://prod.openai.azure.com', 'https://dev.openai.azure.com']);
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
    await linkCommand('anthropic', { workspace: dir });   // note: no acceptRisk

    const cm = new ConfigManager(dir);
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    // `credentialSource` is set by adoption alone. Asserting on authToken would
    // pass either way: injectEnvKeys picks ANTHROPIC_AUTH_TOKEN up on load, so
    // the field is populated whether or not `link` ever ran.
    expect(anthropic?.credentialSource).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(anthropic?.authToken).toBe('gw-token');
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
