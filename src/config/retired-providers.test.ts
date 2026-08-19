// Upgrade safety for a removed provider type.
//
// The failure these guard against is not subtle: narrowing ProviderType makes
// `validateConfig()` THROW on a file that was valid one version earlier, and
// ConfigManager.loadConfig() calls it with no recovery — so the CLI dies at
// startup and the desktop app reports "Could not load Cascade config" with no
// way to repair it from Settings. Every fixture below is a real 0.70.0-shaped
// file, not a synthetic one.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeCleanup,
  didCleanupChangeAnything,
  filterRetiredCredentials,
  stripRetiredProviders,
} from './retired-providers.js';
import { validateConfig } from './validate.js';
import { ConfigManager } from './index.js';
import { applySyncBundle, type SyncBundle } from '../cloud/keysync.js';
import type { ProviderConfig } from '../types.js';
import type { RetiredProviderCleanup } from './retired-providers.js';

/** Exactly what `cascade init` wrote for a GitHub Models user on 0.70.0. */
function config0700(): Record<string, unknown> {
  return {
    providers: [
      { type: 'anthropic', apiKey: 'sk-ant-real' },
      { type: 'github-models', apiKey: 'github_pat_dead' },
    ],
    models: { t1: 'github-models:openai/gpt-4o', t2: 'claude-sonnet-4', t3: 'github-models:meta/Llama-3.3-70B-Instruct' },
  };
}

describe('stripRetiredProviders', () => {
  it('lets a 0.70.0 config that names a retired provider pass validation again', () => {
    const raw = config0700();
    // Establish the regression is real before asserting the fix: unmigrated,
    // this file is rejected outright.
    expect(() => validateConfig(config0700())).toThrow();

    const cleanup = stripRetiredProviders(raw);
    expect(cleanup.removed).toEqual(['github-models']);
    const cfg = validateConfig(raw);
    expect(cfg.providers.map((p) => p.type)).toEqual(['anthropic']);
  });

  it('clears tier pins that name the retired provider, and only those', () => {
    const raw = config0700();
    const cleanup = stripRetiredProviders(raw);
    // A pin outlives the provider entry and is just a string, so the provider
    // filter alone leaves it behind — where it fails every single request with
    // "provider ... is not available" rather than falling back.
    expect(cleanup.clearedPins.sort()).toEqual(['t1', 't3']);
    const cfg = validateConfig(raw);
    expect(cfg.models?.t1).toBeUndefined();
    expect(cfg.models?.t3).toBeUndefined();
    expect(cfg.models?.t2).toBe('claude-sonnet-4'); // untouched
  });

  it('is a no-op on a config with nothing retired', () => {
    const raw = { providers: [{ type: 'openai', apiKey: 'k' }], models: { t1: 'gpt-4o' } };
    const cleanup = stripRetiredProviders(raw);
    expect(didCleanupChangeAnything(cleanup)).toBe(false);
    expect(raw.providers).toHaveLength(1);
    expect(raw.models.t1).toBe('gpt-4o');
  });

  it('leaves a malformed file for validateConfig to reject, rather than masking it', () => {
    // If this swallowed junk, a genuinely broken config would produce a
    // confusing error from the migration instead of the schema's real one.
    const raw = { providers: 'not-an-array' };
    expect(didCleanupChangeAnything(stripRetiredProviders(raw))).toBe(false);
    expect(() => validateConfig(raw)).toThrow();
  });

  it('does not mistake a model id that merely contains the name for a pin', () => {
    const raw = { providers: [], models: { t1: 'openai-compatible:github-models-clone' } };
    expect(stripRetiredProviders(raw).clearedPins).toEqual([]);
    expect((raw.models as { t1?: string }).t1).toBe('openai-compatible:github-models-clone');
  });

  it('describes what it did in terms a user can act on', () => {
    const raw = config0700();
    const msg = describeCleanup(stripRetiredProviders(raw));
    expect(msg).toContain('github-models');
    expect(msg).toContain('T1/T3');
  });
});

describe('filterRetiredCredentials', () => {
  it('drops retired entries from the global credentials store', () => {
    const { kept, removed } = filterRetiredCredentials([
      { type: 'anthropic', apiKey: 'k' },
      { type: 'github-models', apiKey: 'github_pat_dead' },
    ]);
    expect(removed).toEqual(['github-models']);
    expect(kept.map((p) => p.type)).toEqual(['anthropic']);
  });
});

describe('ConfigManager — upgrading from a real 0.70.0 install', () => {
  let dir: string;
  let globalDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-migrate-'));
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-global-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  function writeWorkspaceConfig(cfg: unknown) {
    fs.mkdirSync(path.join(dir, '.cascade'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cascade', 'config.json'), JSON.stringify(cfg, null, 2));
  }

  it('loads instead of throwing, and persists the cleaned config', async () => {
    writeWorkspaceConfig(config0700());
    const mgr = new ConfigManager(dir, globalDir);

    await expect(mgr.load()).resolves.toBeUndefined();
    expect(mgr.getConfig().providers.map((p) => p.type)).toEqual(['anthropic']);

    // Persisted, not just fixed in memory — otherwise every future load
    // repeats the migration and the warning never stops.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'config.json'), 'utf-8'));
    expect(onDisk.providers.some((p: { type: string }) => p.type === 'github-models')).toBe(false);
    expect(onDisk.models?.t1).toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('github-models'));
  });

  it('does not let the global credentials store reintroduce the retired entry', async () => {
    // The regression the workspace-only fix would miss: mergeGlobalCredentials
    // runs AFTER validation and never passes through the schema, so a stale
    // ~/.cascade-ai entry lands back in memory moments after the workspace
    // file was cleaned — and comes back on every load, in every workspace.
    writeWorkspaceConfig({ providers: [{ type: 'anthropic', apiKey: 'k' }] });
    fs.writeFileSync(
      path.join(globalDir, 'credentials.json'),
      JSON.stringify({ providers: [{ type: 'github-models', apiKey: 'github_pat_dead' }] }),
    );

    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();

    expect(mgr.getConfig().providers.some((p) => p.type === 'github-models')).toBe(false);
    const creds = JSON.parse(fs.readFileSync(path.join(globalDir, 'credentials.json'), 'utf-8'));
    expect(creds.providers.some((p: { type: string }) => p.type === 'github-models')).toBe(false);
  });

  it('leaves a clean install untouched and silent', async () => {
    writeWorkspaceConfig({ providers: [{ type: 'openai', apiKey: 'k' }] });
    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();

    expect(mgr.getConfig().providers.map((p) => p.type)).toEqual(['openai']);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('migration'));
  });
});

describe('applySyncBundle — pulling a bundle pushed by 0.70.0', () => {
  /**
   * A real pre-0.71 sync blob: the pushing device still had the provider
   * configured and both tiers pinned to it. Nothing between decrypt and merge
   * validates either field, which is what made this a third persistence path
   * on top of the workspace config and the global credentials store.
   */
  function bundle0700(): SyncBundle {
    return {
      v: 2,
      providers: [
        { type: 'anthropic', apiKey: 'sk-ant-real' },
        { type: 'github-models', apiKey: 'github_pat_dead' } as unknown as ProviderConfig,
      ],
      models: { t1: 'github-models:openai/gpt-4o', t2: 'claude-sonnet-4' },
    };
  }

  const baseConfig = () => validateConfig({ providers: [{ type: 'openai', apiKey: 'k' }] });

  it('does not reintroduce the retired provider or its pins', () => {
    const merged = applySyncBundle(bundle0700(), baseConfig());
    expect(merged.providers.some((p) => (p.type as string) === 'github-models')).toBe(false);
    expect(merged.providers.some((p) => p.type === 'anthropic')).toBe(true); // the rest still syncs
    expect(merged.models?.t1).toBeUndefined();
    expect(merged.models?.t2).toBe('claude-sonnet-4');
  });

  it('produces a config that still validates, so updateConfig() cannot throw', () => {
    // The CLI hands this straight to ConfigManager.updateConfig(), which
    // validates. Before the fix that throw surfaced inside a catch written for
    // a wrong passphrase, telling the user to re-enter a correct one.
    const merged = applySyncBundle(bundle0700(), baseConfig());
    expect(() => validateConfig(merged)).not.toThrow();
  });

  it('reports what it skipped so the surfaces can explain it', () => {
    const cleanup: RetiredProviderCleanup = { removed: [], clearedPins: [] };
    applySyncBundle(bundle0700(), baseConfig(), cleanup);
    expect(cleanup.removed).toEqual(['github-models']);
    expect(cleanup.clearedPins).toEqual(['t1']);
    expect(didCleanupChangeAnything(cleanup)).toBe(true);
  });

  it('keeps the receiving device\'s own pin rather than resetting the tier', () => {
    // The strip deletes `t1` from the BUNDLE, and the merge is
    // `{ ...config.models, ...bundle.models }` — so a local pin for the same
    // tier comes through. That is the outcome we want: the local pin is valid,
    // and dropping it because a stale remote snapshot named a dead provider
    // for that tier would be data loss caused by garbage input.
    const local = validateConfig({
      providers: [{ type: 'openai', apiKey: 'k' }],
      models: { t1: 'openai:gpt-4o' },
    });
    const cleanup: RetiredProviderCleanup = { removed: [], clearedPins: [] };
    const merged = applySyncBundle(bundle0700(), local, cleanup);

    expect(merged.models?.t1).toBe('openai:gpt-4o');
    // …and the report has to match: claiming T1 was "reset to Auto" told the
    // user a pin was gone while it was still in place and still in effect.
    expect(cleanup.clearedPins).toEqual([]);
    expect(cleanup.removed).toEqual(['github-models']);
  });

  it('clears a retired pin that reaches the merged config from the LOCAL side', () => {
    // Defense in depth. The local config is normally migrated at load, but a
    // pin that survives the merge still naming a retired provider is dead
    // whichever side it came from, and this is the last point before the
    // result is handed back to be persisted.
    const local = { ...validateConfig({ providers: [{ type: 'openai', apiKey: 'k' }] }), models: { t3: 'github-models:openai/gpt-4o' } };
    const cleanup: RetiredProviderCleanup = { removed: [], clearedPins: [] };
    const clean: SyncBundle = { v: 2, providers: [{ type: 'gemini', apiKey: 'k' }] };
    const merged = applySyncBundle(clean, local, cleanup);

    expect(merged.models?.t3).toBeUndefined();
    expect(cleanup.clearedPins).toEqual(['t3']);
    // The caller's own config is not mutated on the way through: with no
    // `models` in the bundle, `next.models` is still that same object.
    expect(local.models.t3).toBe('github-models:openai/gpt-4o');
  });

  it('reports nothing for a bundle with nothing retired', () => {
    const cleanup: RetiredProviderCleanup = { removed: [], clearedPins: [] };
    const clean: SyncBundle = { v: 2, providers: [{ type: 'gemini', apiKey: 'k' }], models: { t1: 'gemini-2.5-pro' } };
    const merged = applySyncBundle(clean, baseConfig(), cleanup);
    expect(didCleanupChangeAnything(cleanup)).toBe(false);
    expect(merged.models?.t1).toBe('gemini-2.5-pro');
    expect(merged.providers.some((p) => p.type === 'gemini')).toBe(true);
  });
});

describe('migration hardening (review round 3)', () => {
  let dir: string;
  let globalDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-harden-'));
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-harden-g-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    delete process.env['OPENAI_API_KEY'];
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  const write = (cfg: unknown) => {
    fs.mkdirSync(path.join(dir, '.cascade'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cascade', 'config.json'), JSON.stringify(cfg, null, 2));
  };
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'config.json'), 'utf-8'));

  it('never writes env or global credentials into the workspace file', async () => {
    // The migration used to persist via save() at the END of load(), by which
    // point this.config had been enriched with env keys and the 0600 global
    // credential store — copying secrets into a workspace file that may be
    // 0644, for a project that never had them.
    process.env['OPENAI_API_KEY'] = 'sk-openai-from-env';
    write({ providers: [{ type: 'github-models', apiKey: 'github_pat_dead' }, { type: 'anthropic', apiKey: 'sk-ws' }] });
    fs.writeFileSync(
      path.join(globalDir, 'credentials.json'),
      JSON.stringify({ providers: [{ type: 'gemini', apiKey: 'sk-gemini-global' }] }),
    );

    await new ConfigManager(dir, globalDir).load();

    const serialized = JSON.stringify(onDisk());
    expect(serialized).not.toContain('sk-openai-from-env');
    expect(serialized).not.toContain('sk-gemini-global');
    // The workspace's OWN key is untouched, and the retired entry is gone.
    expect(serialized).toContain('sk-ws');
    expect(serialized).not.toContain('github-models');
  });

  // Root ignores permission bits, so the chmod below denies nothing and the
  // test would assert its own setup rather than the behaviour. Skipping is
  // honest; passing vacuously under root is not — that is exactly how the
  // first version of this test passed locally and failed in CI.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(asRoot)('still loads when the migration cannot be written back', async () => {
    write({ providers: [{ type: 'github-models', apiKey: 'x' }, { type: 'openai', apiKey: 'k' }] });
    // Only the config FILE is made unwritable, not its directory. Making the
    // whole `.cascade` directory read-only would also block the SQLite store
    // that load() opens inside it, which fails for reasons that have nothing
    // to do with this migration — the assertion would then be testing a
    // constraint the hardening never claimed to remove.
    const cfgFile = path.join(dir, '.cascade', 'config.json');
    fs.chmodSync(cfgFile, 0o400);
    try {
      const mgr = new ConfigManager(dir, globalDir);
      // The in-memory config is already clean, so the run proceeds and simply
      // migrates again next launch rather than refusing to start.
      await expect(mgr.load()).resolves.toBeUndefined();
      expect(mgr.getConfig().providers.map((p) => p.type)).toEqual(['openai']);
      // And the file genuinely was not rewritten — otherwise this would be
      // passing because the write succeeded, not because it was tolerated.
      expect(JSON.stringify(onDisk())).toContain('github-models');
    } finally {
      fs.chmodSync(cfgFile, 0o600);
    }
  });

  it('clears a pin whose provider prefix was written in another case', () => {
    // selector.ts's resolveDynamicModel lowercases the prefix, so this was a
    // valid pin. Matching case-sensitively would strand it.
    const raw = { providers: [], models: { t1: 'GitHub-Models:openai/gpt-4o' } };
    expect(stripRetiredProviders(raw).clearedPins).toEqual(['t1']);
    expect((raw.models as { t1?: string }).t1).toBeUndefined();
  });

  it('does not treat a migration-emptied provider list as a fresh install', async () => {
    // A fresh install gets a keyless Ollama entry, which hasUsableProvider()
    // accepts without checking the daemon — so both the setup wizard and the
    // headless "No providers configured" guard would be skipped, and the run
    // would reach the router with no usable model.
    write({ providers: [{ type: 'github-models', apiKey: 'github_pat_dead' }] });
    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();
    expect(mgr.getConfig().providers).toHaveLength(0);
  });

  it('retains the notice for a UI to show, since console output gets cleared', async () => {
    write({ providers: [{ type: 'github-models', apiKey: 'x' }] });
    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();
    const notice = mgr.takeRetiredNotice();
    expect(notice).toContain('github-models');
    expect(mgr.takeRetiredNotice()).toBeUndefined(); // once, not every render
  });
});

describe('migration must not strand a usable install (review round 4)', () => {
  let dir: string;
  let globalDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r4-'));
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r4-g-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    delete process.env['OPENAI_API_KEY'];
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  const write = (cfg: unknown) => {
    fs.mkdirSync(path.join(dir, '.cascade'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cascade', 'config.json'), JSON.stringify(cfg, null, 2));
  };

  it('still adopts an environment key when retirement emptied the list', async () => {
    // The first attempt at the fresh-install guard suppressed env discovery
    // too, so a user holding a perfectly usable OPENAI_API_KEY was left with
    // nothing and a "No providers configured" exit — worse than the bug it
    // was fixing.
    process.env['OPENAI_API_KEY'] = 'sk-env';
    write({ providers: [{ type: 'github-models', apiKey: 'dead' }] });

    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();

    const types = mgr.getConfig().providers.map((p) => p.type);
    expect(types).toContain('openai');
    // …but still no phantom Ollama: that fallback is for a genuine fresh
    // install, and hasUsableProvider() accepts it without checking the daemon.
    expect(types).not.toContain('ollama');
  });

  it('adds the Ollama fallback on a genuine fresh install', async () => {
    // The other side of the same branch — the guard must not suppress this.
    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();
    expect(mgr.getConfig().providers.map((p) => p.type)).toContain('ollama');
  });

  it('purges the model cache when the retired entry lived only in the global store', async () => {
    // The purge originally ran at store construction, before the global
    // credential filter had told us anything was retired — so exactly this
    // case slipped through and stale rows kept suppressing discovery.
    write({ providers: [{ type: 'anthropic', apiKey: 'k' }] });
    fs.writeFileSync(
      path.join(globalDir, 'credentials.json'),
      JSON.stringify({ providers: [{ type: 'github-models', apiKey: 'dead' }] }),
    );

    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();
    const store = mgr.getStore();
    store.upsertCachedModel({
      id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'github-models' as never,
      contextWindow: 8_000, isVisionCapable: false,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
      maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
    });
    expect(store.purgeCachedModelsForRetiredProvider('github-models')).toBe(1);
  });
});

describe('retirement ordering (review round 5)', () => {
  let dir: string;
  let globalDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r5-'));
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r5-g-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  it('does not fake a fresh install when the retired entry was only in the global store', async () => {
    // Both halves of the cleanup must be known before injectEnvKeys() decides.
    // With the global filter running afterwards, this case saw an unset flag,
    // called it a first run, and appended a keyless Ollama entry — which
    // hasUsableProvider() accepts without checking the daemon, so the setup
    // wizard never runs and the router starts with nothing usable.
    fs.mkdirSync(path.join(dir, '.cascade'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cascade', 'config.json'), JSON.stringify({ providers: [] }));
    fs.writeFileSync(
      path.join(globalDir, 'credentials.json'),
      JSON.stringify({ providers: [{ type: 'github-models', apiKey: 'dead' }] }),
    );

    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();

    expect(mgr.getConfig().providers.map((p) => p.type)).not.toContain('ollama');
  });
});

describe('cache purge is not gated on a migration (review round 7)', () => {
  let dir: string;
  let globalDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r7-'));
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r7-g-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  it('clears retired rows for a user who cleaned their config before upgrading', async () => {
    // No migration fires for them — retiredCleanup stays unset — but the rows
    // are still in cascade.db, and the REPL reads any non-empty, non-stale
    // cache as authoritative. Gating the purge on the migration left exactly
    // this user with zero models for the providers they DO have.
    fs.mkdirSync(path.join(dir, '.cascade'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.cascade', 'config.json'),
      JSON.stringify({ providers: [{ type: 'openai', apiKey: 'k' }] }),
    );

    // Seed a stale row, then reload: the second load must clear it even though
    // nothing was migrated.
    const first = new ConfigManager(dir, globalDir);
    await first.load();
    first.getStore().upsertCachedModel({
      id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'github-models' as never,
      contextWindow: 8_000, isVisionCapable: false,
      inputCostPer1kTokens: 0, outputCostPer1kTokens: 0,
      maxOutputTokens: 4_000, supportsStreaming: true, isLocal: false,
    });
    expect(first.getStore().getCachedModels()).toHaveLength(1);

    const second = new ConfigManager(dir, globalDir);
    await second.load();
    expect(second.getStore().getCachedModels()).toHaveLength(0);
  });
});

describe('retiredCleanup is per-load state (review round 11)', () => {
  let dir: string;
  let globalDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r11-'));
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-r11-g-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  const write = (cfg: unknown) => {
    fs.mkdirSync(path.join(dir, '.cascade'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.cascade', 'config.json'), JSON.stringify(cfg));
  };

  const migrationWarnings = () =>
    warn.mock.calls.filter((c) => String(c[0]).includes('config migration')).length;

  it('does not re-announce the migration on a second load of the same instance', async () => {
    // startRepl() reloads through the SAME ConfigManager after its setup
    // wizard. The file on disk is already clean by then, so nothing is
    // migrated — but the flag from the first load was never reset, and the
    // end of load() rebuilt the notice and logged it a second time.
    write({ providers: [{ type: 'github-models', apiKey: 'dead' }] });

    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();
    expect(migrationWarnings()).toBe(1);
    expect(mgr.takeRetiredNotice()).toContain('github-models');

    await mgr.load();
    expect(migrationWarnings()).toBe(1);
    expect(mgr.takeRetiredNotice()).toBeUndefined();
  });

  it('restores the Ollama fallback on a later load that is empty for its own reasons', async () => {
    // The sharper half. injectEnvKeys() reads the flag as "this load's empty
    // provider list was emptied by the retirement", which is the one case that
    // must NOT get a keyless Ollama entry. Held over from a previous load it
    // suppressed the fallback for a genuinely empty config — leaving nothing
    // usable and nothing to fall back to.
    write({ providers: [{ type: 'github-models', apiKey: 'dead' }] });

    const mgr = new ConfigManager(dir, globalDir);
    await mgr.load();
    expect(mgr.getConfig().providers.map((p) => p.type)).not.toContain('ollama');

    // Second load: the config is clean now, so an empty list is just an empty
    // list and the fresh-install fallback applies.
    await mgr.load();
    expect(mgr.getConfig().providers.map((p) => p.type)).toContain('ollama');
  });

  it('names a discarded orphan bearer instead of printing an empty migration', () => {
    // didCleanupChangeAnything() already returned true for it, so a sync whose
    // only removal was an orphan bearer printed "Cascade config migration: ."
    // — telling the user something happened and not what.
    const line = describeCleanup({ removed: [], clearedPins: [], unusableCredentials: 1 });
    expect(line).toMatch(/gateway token/i);
    expect(line).toMatch(/named no gateway URL/i);
    expect(line).not.toMatch(/migration: \./);
  });

  it('says nothing at all when nothing was cleaned', () => {
    expect(describeCleanup({ removed: [], clearedPins: [] })).toBe('');
  });
});
