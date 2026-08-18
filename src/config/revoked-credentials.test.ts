// ─────────────────────────────────────────────
//  Cascade AI — revoked credential migration
// ─────────────────────────────────────────────

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isRevokedSubscriptionCredential, stripRevokedCredentials, stripRevokedFromConfig,
  clearAnthropicPins, hasUsableAnthropic, isSubscriptionToken,
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

  it('keeps a row that still holds an API key when an endpoint would not count', () => {
    // `keepForEndpoint: false` is what a sync bundle uses. A row carrying BOTH
    // a revoked token and a good key is what the settings-save paths fixed in
    // this release used to produce, and the key is the replacement the user is
    // syncing — dropping the row would lose it.
    const { kept, removed } = stripRevokedCredentials(
      [{ type: 'anthropic', authToken: 'sk-ant-oat01-x', apiKey: 'sk-ant-api-good' }],
      { keepForEndpoint: false },
    );
    expect(removed).toBe(1);
    expect(kept).toEqual([{ type: 'anthropic', apiKey: 'sk-ant-api-good' }]);
  });

  it('drops an endpoint-only row for a bundle, keeps it for local config', () => {
    const row = () => [{ type: 'anthropic', authToken: 'sk-ant-oat01-x', baseUrl: 'https://gw' }];
    expect(stripRevokedCredentials(row(), { keepForEndpoint: false }).kept).toEqual([]);
    expect(stripRevokedCredentials(row()).kept).toEqual([{ type: 'anthropic', baseUrl: 'https://gw' }]);
  });

  it('leaves a malformed entry for the validator instead of throwing', () => {
    // This migration runs BEFORE validateConfig() by design, so a bare
    // TypeError here replaced the actionable "providers[0] is invalid" the
    // schema would have produced for a hand-edited file.
    expect(() => stripRevokedFromConfig({ providers: [null, 'nonsense', 42] })).not.toThrow();
    expect(isRevokedSubscriptionCredential(null as never)).toBe(false);
    expect(isRevokedSubscriptionCredential(undefined as never)).toBe(false);
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

describe('a subscription token exported as ANTHROPIC_AUTH_TOKEN', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-envoat-'));
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is not injected into the config, gateway or no gateway', async () => {
    // Straight through the migration otherwise: the stored copy is stripped on
    // load, and then the same dead token — exported as a variable — was put
    // back into the config it had just been removed from, on every load.
    // Anthropic refuses it whatever header carries it.
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    await fs.writeFile(
      path.join(dir, CASCADE_CONFIG_FILE),
      JSON.stringify({ providers: [], models: {}, tools: {} }),
      'utf-8',
    );
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'sk-ant-oat01-subscription';
    process.env['ANTHROPIC_BASE_URL'] = 'https://gateway.internal';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.authToken).toBeUndefined();
  });

  it('still injects a genuine gateway bearer', () => {
    // The narrowness matters as much as the check: a gateway's bearer is a good
    // credential and this release exists partly to make it work.
    expect(isSubscriptionToken('sk-ant-oat01-x')).toBe(true);
    expect(isSubscriptionToken('gw-issued-token')).toBe(false);
    expect(isSubscriptionToken('sk-ant-api03-real-key')).toBe(false);
    expect(isSubscriptionToken(undefined)).toBe(false);
  });
});

describe('an environment key can replace what the migration removed', () => {
  let dir: string;
  const saved = process.env['ANTHROPIC_API_KEY'];
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-recreate-')); });
  afterEach(async () => {
    if (saved === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = saved;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('recreates the Anthropic row and keeps the pin', async () => {
    // With ANOTHER provider in the file, removing the dead token leaves a
    // non-empty list — so the "may an env key seed an entry" gate said no, the
    // merged config had no Anthropic at all, and the pin was cleared. All while
    // a working key sat in the environment.
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    await fs.writeFile(
      path.join(dir, CASCADE_CONFIG_FILE),
      JSON.stringify({
        providers: [
          { type: 'openai', apiKey: 'sk-openai' },
          { type: 'anthropic', authToken: 'sk-ant-oat01-dead', credentialSource: 'Claude Code' },
        ],
        models: { t1: 'anthropic:claude-opus-4' },
        tools: {},
      }),
      'utf-8',
    );
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-live';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')?.apiKey).toBe('sk-ant-live');
    expect((cm.getConfig().models as Record<string, unknown>)['t1']).toBe('anthropic:claude-opus-4');
  });
});

describe('clearing pins the removed credential leaves dangling', () => {
  it('clears an Anthropic pin, matched the way the selector parses it', () => {
    const models = { t1: 'anthropic:claude-opus-4', t2: 'Anthropic:claude-sonnet-4', t3: 'openai:gpt-5-mini' };
    // Lowercased because selector.ts's resolveDynamicModel() parses the
    // provider half case-insensitively, so `Anthropic:` is a valid pin.
    expect(clearAnthropicPins(models, []).map((c) => c.tier)).toEqual(['t1', 't2']);
    expect(models).toEqual({ t3: 'openai:gpt-5-mini' });
  });

  it('clears a BARE model id, which is the documented and commoner form', () => {
    // README's own example is `"t1": "claude-opus-4"`, and the setup wizard
    // writes the same shape. Matching only `anthropic:` left the ordinary pin
    // behind, and the router throws on a pin it cannot resolve.
    const models = { t1: 'claude-opus-4', t2: 'gpt-5-mini', t3: 'llama3.2:3b' };
    // The MODEL travels with the tier, so the migration notice can name what
    // it removed — which is what makes clearing recoverable in one line.
    expect(clearAnthropicPins(models, [])).toEqual([{ tier: 't1', model: 'claude-opus-4' }]);
    expect(models).toEqual({ t2: 'gpt-5-mini', t3: 'llama3.2:3b' });
  });

  it('clears a bare Claude id the bundled catalogue has never heard of', () => {
    // A pin is most likely to name an unknown model precisely when it is newer
    // than the build.
    const models = { t1: 'claude-opus-9-future' };
    expect(clearAnthropicPins(models, []).map((c) => c.tier)).toEqual(['t1']);
  });

  it('leaves another provider\'s bare pin alone', () => {
    const models = { t1: 'gpt-5', t2: 'gemini-2.5-flash', t3: 'llama3.2:3b' };
    expect(clearAnthropicPins(models, [])).toEqual([]);
    expect(models).toEqual({ t1: 'gpt-5', t2: 'gemini-2.5-flash', t3: 'llama3.2:3b' });
  });

  it('clears a bare Claude pin even with a gateway configured', () => {
    // A gateway MIGHT serve `claude-sonnet-4` — resolveDynamicModel() accepts
    // any registered id whatever vendor its name suggests — but its catalogue
    // is discovered at runtime and unknowable here, so its presence proves
    // nothing about this id. Keeping the pin on that basis is the worse of the
    // two mistakes: when the gateway does NOT serve it, the id is inferred as
    // Anthropic, no such provider exists, and the router throws on every run.
    // Clearing costs one tier its pin, and the notice names the model.
    const models = { t1: 'claude-sonnet-4' };
    expect(clearAnthropicPins(models, [
      { type: 'openai-compatible', apiKey: 'k', baseUrl: 'https://gw/v1' },
    ])).toEqual([{ tier: 't1', model: 'claude-sonnet-4' }]);
  });

  it('keeps a bare pin naming an Azure deployment', () => {
    // Azure model ids ARE deployment names, so this one is knowable exactly.
    const models = { t1: 'claude-proxy' };
    expect(clearAnthropicPins(models, [
      { type: 'azure', apiKey: 'k', baseUrl: 'https://r.openai.azure.com', deploymentName: 'claude-proxy' },
    ])).toEqual([]);
    expect(models).toEqual({ t1: 'claude-proxy' });
  });

  it('still clears the PREFIXED form even with a gateway configured', () => {
    // `anthropic:<model>` names the provider, not just a model, and that
    // provider is the one that was removed — no other entry can serve it.
    const models = { t1: 'anthropic:claude-sonnet-4' };
    expect(clearAnthropicPins(models, [
      { type: 'openai-compatible', apiKey: 'k', baseUrl: 'https://gw/v1' },
    ]).map((c) => c.tier)).toEqual(['t1']);
  });

  it('clears a bare pin when the only other provider serves a fixed catalogue', () => {
    // OpenAI cannot be asked for `claude-opus-4`, so nothing configured can
    // resolve this pin and the router would throw on it.
    const models = { t1: 'claude-opus-4' };
    expect(clearAnthropicPins(models, [{ type: 'openai', apiKey: 'sk' }]).map((c) => c.tier)).toEqual(['t1']);
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

    // The MODEL is named as well as the tier. Whether a bare Claude pin really
    // belonged to Anthropic is not knowable at config load, so the migration
    // errs toward clearing — and naming what it removed is what keeps that
    // recoverable.
    expect(cm.takeRetiredNotice()).toMatch(/Cleared the T1 pin \(anthropic:claude-opus-4\)/);
    expect(cm.getConfig().models.t1).toBeUndefined();
  });

  it('does not count a bearer with no gateway as a usable Anthropic provider', () => {
    // The shared rule everywhere else: a bearer is only valid at the gateway
    // that issued it. Counting a bare one here left a dead `anthropic:` tier
    // pin in place after the migration, and the router throws on a pin it
    // cannot resolve rather than falling back.
    expect(hasUsableAnthropic([{ type: 'anthropic', authToken: 'gw-token' }])).toBe(false);
    expect(hasUsableAnthropic([
      { type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal' },
    ])).toBe(true);
    expect(hasUsableAnthropic([{ type: 'anthropic', apiKey: 'sk-ant' }])).toBe(true);
  });
});
