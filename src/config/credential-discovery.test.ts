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

  it('detects a Claude Code OAuth token as a usable Anthropic bearer with a ToS warning', async () => {
    await write('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'sk-ant-oat01-xyz' } });
    const found = await discoverCredentials({ homeDir: home, env: {} });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      provider: 'anthropic',
      sourceTool: 'Claude Code',
      kind: 'oauth',
      secret: 'sk-ant-oat01-xyz',
      directlyUsable: true,
    });
    expect(found[0]!.warning).toMatch(/terms of service/i);
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
