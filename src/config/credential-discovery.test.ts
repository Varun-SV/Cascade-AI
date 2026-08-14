import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverCredentials, maskSecret } from './credential-discovery.js';

let home: string;

async function write(rel: string, content: unknown): Promise<void> {
  const file = path.join(home, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-disco-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('discoverCredentials', () => {
  it('returns nothing when no sources exist and env is empty', async () => {
    const found = await discoverCredentials({ homeDir: home, env: {} });
    expect(found).toEqual([]);
  });

  it('reads standard provider keys from the environment, deduped per provider', async () => {
    const found = await discoverCredentials({
      homeDir: home,
      env: { ANTHROPIC_API_KEY: 'sk-ant-1', GEMINI_API_KEY: 'g1', GOOGLE_API_KEY: 'g2' },
    });
    const anthropic = found.find((c) => c.provider === 'anthropic');
    const gemini = found.filter((c) => c.provider === 'gemini');
    expect(anthropic?.kind).toBe('api-key');
    expect(anthropic?.directlyUsable).toBe(true);
    // GEMINI_API_KEY wins; GOOGLE_API_KEY is not added as a duplicate.
    expect(gemini).toHaveLength(1);
    expect(gemini[0]!.secret).toBe('g1');
  });

  it('surfaces a Claude Code subscription token but refuses to call it usable', async () => {
    // Anthropic prohibits third-party clients from routing requests through
    // Claude subscription credentials and refuses them at the API, so adopting
    // one produces a provider that fails on its first call. It is still
    // reported: knowing the token is there, and why it cannot be used, beats
    // silence.
    await write('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'sk-ant-oat01-xyz' } });
    const found = await discoverCredentials({ homeDir: home, env: {} });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      provider: 'anthropic',
      sourceTool: 'Claude Code',
      kind: 'oauth',
      secret: 'sk-ant-oat01-xyz',
      directlyUsable: false,
    });
    // The warning names the policy and what to do instead, rather than hedging.
    expect(found[0]!.warning).toMatch(/does not permit/i);
    expect(found[0]!.warning).toMatch(/API key|ANTHROPIC_AUTH_TOKEN/);
  });

  it('honours CLAUDE_CONFIG_DIR when locating the Claude Code store', async () => {
    await write('elsewhere/.credentials.json', { claudeAiOauth: { accessToken: 'sk-ant-oat01-moved' } });
    const found = await discoverCredentials({
      homeDir: home,
      env: { CLAUDE_CONFIG_DIR: path.join(home, 'elsewhere') },
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.secret).toBe('sk-ant-oat01-moved');
  });

  it('picks up ANTHROPIC_AUTH_TOKEN, the gateway credential Anthropic documents', async () => {
    // Unrelated to the subscription tokens above: this is a bearer credential
    // issued by a gateway the user points Cascade at, and it is supported.
    const found = await discoverCredentials({ homeDir: home, env: { ANTHROPIC_AUTH_TOKEN: 'gw-token' } });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ provider: 'anthropic', kind: 'oauth', directlyUsable: true });
  });

  it('prefers a real API key over the gateway token when both are set', async () => {
    const found = await discoverCredentials({
      homeDir: home,
      env: { ANTHROPIC_API_KEY: 'sk-ant-real', ANTHROPIC_AUTH_TOKEN: 'gw-token' },
    });
    expect(found.filter((c) => c.provider === 'anthropic')).toHaveLength(1);
    expect(found[0]!.secret).toBe('sk-ant-real');
  });

  it('discovers OpenAI-compatible keys WITH the endpoint they belong to', async () => {
    // A key with no baseUrl would configure a provider with nowhere to send a
    // request — the same non-working provider the OAuth paths are refused for.
    const found = await discoverCredentials({ homeDir: home, env: { OPENROUTER_API_KEY: 'or-1' } });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      provider: 'openai-compatible',
      kind: 'api-key',
      directlyUsable: true,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(found[0]!.sourceTool).toContain('OpenRouter');
  });

  it('adopts only one OpenAI-compatible endpoint, since only one can be configured', async () => {
    const found = await discoverCredentials({
      homeDir: home,
      env: { GROQ_API_KEY: 'g-1', DEEPSEEK_API_KEY: 'd-1' },
    });
    expect(found.filter((c) => c.provider === 'openai-compatible')).toHaveLength(1);
    expect(found[0]!.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('detects a Codex API key as directly usable but a ChatGPT OAuth token as not', async () => {
    await write('.codex/auth.json', { OPENAI_API_KEY: 'sk-proj-abc' });
    const keyFound = await discoverCredentials({ homeDir: home, env: {} });
    expect(keyFound[0]).toMatchObject({ provider: 'openai', kind: 'api-key', directlyUsable: true });

    await fs.rm(path.join(home, '.codex'), { recursive: true });
    await write('.codex/auth.json', { tokens: { access_token: 'chatgpt-oauth' } });
    const oauthFound = await discoverCredentials({ homeDir: home, env: {} });
    expect(oauthFound[0]).toMatchObject({ provider: 'openai', kind: 'oauth', directlyUsable: false });
  });

  it('detects a Copilot oauth_token nested under a host key', async () => {
    await write('.config/github-copilot/apps.json', { 'github.com:Iv1.abc': { oauth_token: 'gho_xyz', user: 'me' } });
    const found = await discoverCredentials({ homeDir: home, env: {} });
    expect(found[0]).toMatchObject({ provider: 'openai-compatible', sourceTool: 'GitHub Copilot CLI', directlyUsable: false });
  });

  it('ignores malformed credential files without throwing', async () => {
    await write('.claude/.credentials.json', 'not json {{');
    const found = await discoverCredentials({ homeDir: home, env: {} });
    expect(found).toEqual([]);
  });
});

describe('maskSecret', () => {
  it('redacts the middle of a secret', () => {
    expect(maskSecret('sk-ant-oat01-abcdefghij')).toBe('sk-ant…ij');
  });
  it('fully masks short secrets', () => {
    expect(maskSecret('short')).toBe('••••');
  });
});
