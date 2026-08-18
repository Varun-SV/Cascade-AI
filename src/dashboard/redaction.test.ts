// ─────────────────────────────────────────────
//  Cascade AI — /api/config secret redaction
// ─────────────────────────────────────────────
//
//  The handler masked `apiKey` and nothing else, under a comment saying
//  "Strip sensitive fields before sending". A provider configured with a
//  bearer token — which both `cascade link` and ANTHROPIC_AUTH_TOKEN produce
//  — had that token served in plaintext.

import { describe, expect, it } from 'vitest';
import { redactProviderSecrets } from './server.js';
import type { CascadeConfig } from '../types.js';

function configWith(providers: CascadeConfig['providers']): CascadeConfig {
  return { providers, models: {}, tools: { allowedTools: [] } } as unknown as CascadeConfig;
}

describe('redactProviderSecrets', () => {
  it('masks an API key', () => {
    const safe = redactProviderSecrets(configWith([{ type: 'anthropic', apiKey: 'sk-ant-secret' }]));
    expect(JSON.stringify(safe)).not.toContain('sk-ant-secret');
    expect(safe.providers[0]!.apiKey).toBe('***');
  });

  it('masks a bearer token — the field that used to leak', () => {
    const safe = redactProviderSecrets(configWith([{ type: 'anthropic', authToken: 'gw-token-secret' }]));
    expect(JSON.stringify(safe)).not.toContain('gw-token-secret');
    expect(safe.providers[0]!.authToken).toBe('***');
  });

  it('masks both when a provider carries both', () => {
    const safe = redactProviderSecrets(configWith([
      { type: 'anthropic', apiKey: 'sk-ant-secret', authToken: 'gw-token-secret' },
    ]));
    const json = JSON.stringify(safe);
    expect(json).not.toContain('sk-ant-secret');
    expect(json).not.toContain('gw-token-secret');
  });

  it('leaves non-secret fields intact, so the route stays useful', () => {
    const safe = redactProviderSecrets(configWith([
      { type: 'openai-compatible', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1' },
    ]));
    expect(safe.providers[0]!.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(safe.providers[0]!.type).toBe('openai-compatible');
  });

  it('does not invent fields on a provider that has no secret', () => {
    const safe = redactProviderSecrets(configWith([{ type: 'ollama' }]));
    expect(safe.providers[0]!.apiKey).toBeUndefined();
    expect(safe.providers[0]!.authToken).toBeUndefined();
  });

  it('does not mutate the config it was given', () => {
    const config = configWith([{ type: 'anthropic', apiKey: 'sk-ant-secret', authToken: 'gw' }]);
    redactProviderSecrets(config);
    expect(config.providers[0]!.apiKey).toBe('sk-ant-secret');
    expect(config.providers[0]!.authToken).toBe('gw');
  });

  it('survives a config with no providers array at all', () => {
    const safe = redactProviderSecrets({ models: {} } as unknown as CascadeConfig);
    expect(safe.providers).toEqual([]);
  });

  // ── Secrets outside `providers` ────────────
  //
  // `safe` was otherwise the whole config, so every credential that does not
  // live on a provider was served in plaintext by the same route this
  // redaction exists to harden.

  it('masks the web-search API keys', () => {
    const safe = redactProviderSecrets({
      providers: [],
      models: {},
      tools: { webSearch: { braveApiKey: 'brave-secret', tavilyApiKey: 'tavily-secret', searxngUrl: 'https://searx.internal' } },
    } as unknown as CascadeConfig);

    const json = JSON.stringify(safe);
    expect(json).not.toContain('brave-secret');
    expect(json).not.toContain('tavily-secret');
    // A non-secret setting stays readable, or the route stops being useful.
    expect(safe.tools.webSearch?.searxngUrl).toBe('https://searx.internal');
  });

  it('masks MCP server auth headers and env, keeping their names', () => {
    const safe = redactProviderSecrets({
      providers: [],
      models: {},
      tools: {
        mcpServers: [
          { name: 'remote', url: 'https://mcp.internal', headers: { Authorization: 'Bearer super-secret' } },
          { name: 'local', command: 'node', env: { GITHUB_TOKEN: 'ghp-secret' } },
        ],
      },
    } as unknown as CascadeConfig);

    const json = JSON.stringify(safe);
    expect(json).not.toContain('super-secret');
    expect(json).not.toContain('ghp-secret');
    // Which keys are configured is useful; their values never are.
    expect(safe.tools.mcpServers![0]!.headers).toEqual({ Authorization: '***' });
    expect(safe.tools.mcpServers![1]!.env).toEqual({ GITHUB_TOKEN: '***' });
    expect(safe.tools.mcpServers![0]!.url).toBe('https://mcp.internal');
  });

  it('masks the dashboard\u2019s own JWT secret', () => {
    // Served BY the dashboard: anyone reading it can mint a session for the
    // very route they read it from.
    const safe = redactProviderSecrets({
      providers: [], models: {}, tools: {},
      dashboard: { port: 3000, host: '127.0.0.1', auth: true, teamMode: 'single', secret: 'jwt-signing-secret' },
    } as unknown as CascadeConfig);

    expect(JSON.stringify(safe)).not.toContain('jwt-signing-secret');
    expect(safe.dashboard.secret).toBe('***');
    expect(safe.dashboard.port).toBe(3000);
  });

  it('masks the telemetry key', () => {
    const safe = redactProviderSecrets({
      providers: [], models: {}, tools: {},
      telemetry: { enabled: true, posthogApiKey: 'phc-secret', distinctId: 'user-1' },
    } as unknown as CascadeConfig);

    expect(JSON.stringify(safe)).not.toContain('phc-secret');
    expect(safe.telemetry.distinctId).toBe('user-1');
  });

  it('does not mutate the live config when redacting nested branches', () => {
    // `{ ...config }` shares every nested object, so redacting in place would
    // have destroyed the running server's own credentials.
    const config = {
      providers: [],
      models: {},
      tools: {
        webSearch: { braveApiKey: 'brave-secret' },
        mcpServers: [{ name: 'remote', headers: { Authorization: 'Bearer super-secret' } }],
      },
      dashboard: { port: 3000, host: '127.0.0.1', auth: true, teamMode: 'single', secret: 'jwt-signing-secret' },
      telemetry: { enabled: true, posthogApiKey: 'phc-secret' },
    } as unknown as CascadeConfig;

    redactProviderSecrets(config);

    expect(config.tools.webSearch?.braveApiKey).toBe('brave-secret');
    expect(config.tools.mcpServers![0]!.headers).toEqual({ Authorization: 'Bearer super-secret' });
    expect(config.dashboard.secret).toBe('jwt-signing-secret');
    expect(config.telemetry.posthogApiKey).toBe('phc-secret');
  });

  it('survives a config with none of those branches present', () => {
    const safe = redactProviderSecrets({ providers: [], models: {} } as unknown as CascadeConfig);
    expect(safe.tools).toBeUndefined();
    expect(safe.dashboard).toBeUndefined();
    expect(safe.telemetry).toBeUndefined();
  });
});
