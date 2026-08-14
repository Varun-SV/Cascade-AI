// ─────────────────────────────────────────────
//  Cascade AI — revoked credential migration
// ─────────────────────────────────────────────

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isRevokedSubscriptionCredential, stripRevokedCredentials, stripRevokedFromConfig,
  clearAnthropicPins, hasUsableAnthropic,
} from './revoked-credentials.js';
import { ConfigManager, hasUsableProvider } from './index.js';
import { CASCADE_CONFIG_FILE } from '../constants.js';

describe('isRevokedSubscriptionCredential', () => {
  it('recognises a token by its Anthropic subscription prefix', () => {
    expect(isRevokedSubscriptionCredential({ type: 'anthropic', authToken: 'sk-ant-oat01-abc' })).toBe(true);
  });

  it('recognises one by the source `cascade link` stamped on it', () => {
    expect(isRevokedSubscriptionCredential({
      type: 'anthropic', authToken: 'opaque', credentialSource: 'Claude Code',
    })).toBe(true);
  });

  it('leaves a gateway bearer alone', () => {
    // The whole point of keeping this narrow: a bearer token is a good
    // credential in general, and this release adds support for exactly that.
    expect(isRevokedSubscriptionCredential({
      type: 'anthropic', authToken: 'gw-token',
      credentialSource: 'Environment (ANTHROPIC_AUTH_TOKEN)',
      baseUrl: 'https://gateway.internal',
    })).toBe(false);
  });

  it('leaves an API key alone, whatever its source', () => {
    expect(isRevokedSubscriptionCredential({
      type: 'anthropic', apiKey: 'sk-ant-real', credentialSource: 'Claude Code',
    })).toBe(false);
  });

  it('does not reach into other providers', () => {
    expect(isRevokedSubscriptionCredential({ type: 'openai', authToken: 'sk-ant-oat01-abc' })).toBe(false);
  });
});

describe('stripRevokedCredentials', () => {
  it('drops the entry when the dead token was all it had', () => {
    const { kept, removed } = stripRevokedCredentials([
      { type: 'anthropic', authToken: 'sk-ant-oat01-x', credentialSource: 'Claude Code' },
    ]);
    expect(removed).toBe(1);
    expect(kept).toEqual([]);
  });

  it('keeps the entry, minus the token, when it still carries something usable', () => {
    // Deleting the row would take a configured endpoint with it.
    const { kept, removed } = stripRevokedCredentials([
      { type: 'anthropic', authToken: 'sk-ant-oat01-x', baseUrl: 'https://gateway.internal' },
    ]);
    expect(removed).toBe(1);
    expect(kept).toEqual([{ type: 'anthropic', baseUrl: 'https://gateway.internal' }]);
  });

  it('leaves an untouched list untouched', () => {
    const providers = [{ type: 'openai', apiKey: 'sk' }, { type: 'ollama' }];
    const { kept, removed } = stripRevokedCredentials(providers);
    expect(removed).toBe(0);
    expect(kept).toEqual(providers);
  });
});

describe('ConfigManager — removing a dead subscription token on load', () => {
  let dir: string;

  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-revoked-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function seed(providers: unknown[]): Promise<void> {
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    await fs.writeFile(
      path.join(dir, CASCADE_CONFIG_FILE),
      JSON.stringify({ providers, models: {}, tools: {} }),
      'utf-8',
    );
  }

  it('removes it and stops calling the install configured', async () => {
    // Left in place it counts as a credential, so onboarding stays closed over
    // an install whose every request the provider refuses.
    await seed([{ type: 'anthropic', authToken: 'sk-ant-oat01-x', credentialSource: 'Claude Code' }]);
    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();

    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')).toBeUndefined();
    expect(hasUsableProvider(cm.getConfig().providers)).toBe(false);
  });

  it('explains why, rather than silently deleting a credential', async () => {
    await seed([{ type: 'anthropic', authToken: 'sk-ant-oat01-x' }]);
    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();

    const notice = cm.takeRetiredNotice();
    expect(notice).toMatch(/no longer permits/i);
    expect(notice).toMatch(/Claude Console|ANTHROPIC_AUTH_TOKEN/);
  });

  it('reports the notice once, not on every load', async () => {
    await seed([{ type: 'anthropic', authToken: 'sk-ant-oat01-x' }]);
    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    expect(cm.takeRetiredNotice()).toBeTruthy();
    await cm.load();
    // Nothing left to remove on the second pass, so nothing to announce.
    expect(cm.takeRetiredNotice()).toBeUndefined();
  });

  it('does not touch a legitimate gateway bearer', async () => {
    await seed([{
      type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal',
      credentialSource: 'Environment (ANTHROPIC_AUTH_TOKEN)',
    }]);
    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();

    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.authToken).toBe('gw-token');
    expect(cm.takeRetiredNotice()).toBeUndefined();
  });
});

describe('clearing pins the removed credential leaves dangling', () => {
  it('clears an Anthropic pin, matched the way the selector parses it', () => {
    const models = { t1: 'anthropic:claude-opus-4', t2: 'Anthropic:claude-sonnet-4', t3: 'openai:gpt-5-mini' };
    // Lowercased because selector.ts's resolveDynamicModel() parses the
    // provider half case-insensitively, so `Anthropic:` is a valid pin.
    expect(clearAnthropicPins(models)).toEqual(['t1', 't2']);
    expect(models).toEqual({ t3: 'openai:gpt-5-mini' });
  });

  it('reads a surviving Anthropic provider from whatever list it is given', () => {
    expect(hasUsableAnthropic([{ type: 'anthropic', apiKey: 'sk' }])).toBe(true);
    expect(hasUsableAnthropic([{ type: 'anthropic', baseUrl: 'https://gw' }])).toBe(false);
    expect(hasUsableAnthropic([{ type: 'openai', apiKey: 'sk' }])).toBe(false);
  });

  it('strips providers without touching pins — that decision comes later', () => {
    // stripRevokedFromConfig runs on the RAW workspace file, before the global
    // store and the environment are merged in. It cannot know yet whether a
    // usable Anthropic provider survives, so it must not decide.
    const raw = {
      providers: [{ type: 'anthropic', authToken: 'sk-ant-oat01-x' }],
      models: { t1: 'anthropic:claude-opus-4' },
    };
    expect(stripRevokedFromConfig(raw).removed).toBe(1);
    expect(raw.models).toEqual({ t1: 'anthropic:claude-opus-4' });
  });
});

describe('ConfigManager — a pin survives if any source still supplies Anthropic', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-pins-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function seedWorkspace(providers: unknown[], models: unknown): Promise<void> {
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    await fs.writeFile(
      path.join(dir, CASCADE_CONFIG_FILE),
      JSON.stringify({ providers, models, tools: {} }),
      'utf-8',
    );
  }

  it('KEEPS the pin when the global store still supplies a key', async () => {
    // Deciding from the raw workspace file deleted the user's explicit model
    // selection while the loaded config still had a working Anthropic provider.
    const globalDir = path.join(dir, 'global');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, 'credentials.json'),
      JSON.stringify({ version: 1, providers: [{ type: 'anthropic', apiKey: 'sk-ant-real' }] }),
      'utf-8',
    );
    await seedWorkspace(
      [{ type: 'anthropic', authToken: 'sk-ant-oat01-x' }],
      { t1: 'anthropic:claude-opus-4' },
    );

    const cm = new ConfigManager(dir, globalDir);
    await cm.load();
    expect(cm.getConfig().models.t1).toBe('anthropic:claude-opus-4');
    expect(hasUsableProvider(cm.getConfig().providers)).toBe(true);
  });

  it('clears it when nothing else supplies one, and persists that', async () => {
    await seedWorkspace(
      [{ type: 'anthropic', authToken: 'sk-ant-oat01-x' }],
      { t1: 'anthropic:claude-opus-4' },
    );
    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    expect(cm.getConfig().models.t1).toBeUndefined();

    // Persisted, so the next launch does not repeat the migration or re-warn.
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, CASCADE_CONFIG_FILE), 'utf-8')) as
      { models?: Record<string, unknown> };
    expect(onDisk.models?.['t1']).toBeUndefined();
  });
});

describe('the notice survives alongside a retirement notice', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-notices-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('explains the removal even when only the GLOBAL store held the token', async () => {
    // The global-store branch used to fabricate an empty retiredCleanup, and
    // describeCleanup() of that then overwrote this explanation with the bare
    // string "Cascade config migration: .".
    const globalDir = path.join(dir, 'global');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, 'credentials.json'),
      JSON.stringify({ version: 1, providers: [{ type: 'anthropic', authToken: 'sk-ant-oat01-x' }] }),
      'utf-8',
    );
    const cm = new ConfigManager(dir, globalDir);
    await cm.load();

    const notice = cm.takeRetiredNotice();
    expect(notice).toMatch(/no longer permits/i);
    expect(notice).not.toMatch(/migration: \.$/);
  });

  it('names the pin it cleared, so the tier change is not a surprise', async () => {
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    await fs.writeFile(
      path.join(dir, CASCADE_CONFIG_FILE),
      JSON.stringify({
        providers: [{ type: 'anthropic', authToken: 'sk-ant-oat01-x' }],
        models: { t1: 'anthropic:claude-opus-4' },
        tools: {},
      }),
      'utf-8',
    );
    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();

    expect(cm.takeRetiredNotice()).toMatch(/Cleared the T1 model pin/);
    expect(cm.getConfig().models.t1).toBeUndefined();
  });
});
