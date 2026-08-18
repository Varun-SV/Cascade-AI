import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProviderApiKey, ConfigManager, hasProviderCredential, hasUsableProvider } from './index.js';
import { CASCADE_CONFIG_FILE } from '../constants.js';

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ConfigManager', () => {
  it('throws when the workspace config file is invalid instead of silently defaulting', async () => {
    const workspace = await makeTempWorkspace();
    const configPath = path.join(workspace, CASCADE_CONFIG_FILE);

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      dashboard: { port: 'not-a-number' },
    }), 'utf-8');

    const manager = new ConfigManager(workspace);
    await expect(manager.load()).rejects.toThrow(/Invalid cascade configuration/i);
  });
});

// Desktop and CLI share this one config file, and only the desktop's OAuth
// connect flow ever checked for a colliding sanitized MCP tool prefix — a file
// hand-edited, imported, or written by `cascade mcp connect` (which had no
// check of its own) could reach disk already containing a collision. Fixed on
// EVERY load, not gated on a migration flag, since it's a no-op when nothing
// collides.
describe('ConfigManager — MCP server name disambiguation on load', () => {
  it('renames a pre-existing colliding pair and persists the fix', async () => {
    const workspace = await makeTempWorkspace();
    const globalDir = await makeTempWorkspace();
    const configPath = path.join(workspace, CASCADE_CONFIG_FILE);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      tools: {
        mcpServers: [
          { name: 'foo bar', url: 'https://a.example.com/mcp' },
          { name: 'foo@bar', url: 'https://b.example.com/mcp' }, // collides: mcp__foo_bar__…
        ],
      },
    }), 'utf-8');

    const manager = new ConfigManager(workspace, globalDir);
    await manager.load();

    const servers = manager.getConfig().tools.mcpServers!;
    expect(servers[0]!.name).toBe('foo bar');       // first entry untouched
    expect(servers[1]!.name).not.toBe('foo@bar');   // renamed to break the collision
    expect(servers[1]!.url).toBe('https://b.example.com/mcp'); // other fields preserved

    // Persisted, not just fixed in memory — a second process reading the same
    // file must see the same, already-disambiguated names.
    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8')) as { tools: { mcpServers: Array<{ name: string }> } };
    expect(onDisk.tools.mcpServers[1]!.name).toBe(servers[1]!.name);
  });

  it('follows the rename into mcpTrusted, not just mcpServers', async () => {
    // McpClient.connect() matches mcpTrusted by exact string — a stale entry
    // means the renamed server is no longer trusted, so it either re-prompts
    // interactively or is rejected outright in a headless run.
    const workspace = await makeTempWorkspace();
    const globalDir = await makeTempWorkspace();
    const configPath = path.join(workspace, CASCADE_CONFIG_FILE);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      tools: {
        mcpServers: [
          { name: 'foo bar', url: 'https://a.example.com/mcp' },
          { name: 'foo@bar', url: 'https://b.example.com/mcp' },
        ],
        mcpTrusted: ['foo bar', 'foo@bar'],
      },
    }), 'utf-8');

    const manager = new ConfigManager(workspace, globalDir);
    await manager.load();

    const config = manager.getConfig();
    const renamedName = config.tools.mcpServers![1]!.name;
    expect(renamedName).not.toBe('foo@bar');

    // The first server's trust entry is untouched; the second's followed it
    // to its new name.
    expect(config.tools.mcpTrusted).toContain('foo bar');
    expect(config.tools.mcpTrusted).toContain(renamedName);
    expect(config.tools.mcpTrusted).not.toContain('foo@bar');
  });

  it('keeps the SURVIVOR trusted when two rows share the exact same raw name', async () => {
    // A different shape from the "foo bar" / "foo@bar" case above: here BOTH
    // rows are literally named "foo", so there was only ONE trust entry for
    // both (mcpTrusted is deduplicated). The first row keeps "foo" untouched;
    // the second is renamed to "foo (2)". A naive rewrite (replace "foo" with
    // "foo (2)" everywhere) would move the one trust entry entirely onto the
    // renamed row and leave the untouched survivor — which is STILL named
    // "foo" — without trust, so its next connection re-prompts or fails
    // headless.
    const workspace = await makeTempWorkspace();
    const globalDir = await makeTempWorkspace();
    const configPath = path.join(workspace, CASCADE_CONFIG_FILE);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      tools: {
        mcpServers: [
          { name: 'foo', url: 'https://a.example.com/mcp' },
          { name: 'foo', url: 'https://b.example.com/mcp' },
        ],
        mcpTrusted: ['foo'],
      },
    }), 'utf-8');

    const manager = new ConfigManager(workspace, globalDir);
    await manager.load();

    const config = manager.getConfig();
    const [first, second] = config.tools.mcpServers!;
    expect(first!.name).toBe('foo');           // survivor, untouched
    expect(second!.name).not.toBe('foo');       // renamed

    // Both are now trusted — the entry was ADDED to, not moved from.
    expect(config.tools.mcpTrusted).toContain('foo');
    expect(config.tools.mcpTrusted).toContain(second!.name);
  });

  it('grants trust to BOTH renamed identities when two different rows share the same raw name', async () => {
    // Mixed collision shape: `foo bar` and `foo@bar` collide with each other
    // via sanitizing, AND there are two separate `foo@bar` rows. All three
    // sanitize-collide, so `foo bar` survives untouched and BOTH `foo@bar`
    // rows get renamed to distinct identities. Processing renames one `from`
    // at a time (instead of grouped) drops the second `foo@bar` rename: the
    // first rename's own processing already removes `foo@bar` from the
    // trusted list, so the second rename (same `from`) sees it gone and
    // silently skips granting trust to its renamed identity.
    const workspace = await makeTempWorkspace();
    const globalDir = await makeTempWorkspace();
    const configPath = path.join(workspace, CASCADE_CONFIG_FILE);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      tools: {
        mcpServers: [
          { name: 'foo bar', url: 'https://a.example.com/mcp' },
          { name: 'foo@bar', url: 'https://b.example.com/mcp' },
          { name: 'foo@bar', url: 'https://c.example.com/mcp' },
        ],
        mcpTrusted: ['foo bar', 'foo@bar'],
      },
    }), 'utf-8');

    const manager = new ConfigManager(workspace, globalDir);
    await manager.load();

    const config = manager.getConfig();
    const [first, second, third] = config.tools.mcpServers!;
    expect(first!.name).toBe('foo bar'); // survivor, untouched
    expect(second!.name).not.toBe('foo@bar');
    expect(third!.name).not.toBe('foo@bar');
    expect(second!.name).not.toBe(third!.name); // each renamed to a distinct identity

    expect(config.tools.mcpTrusted).toContain('foo bar');
    expect(config.tools.mcpTrusted).toContain(second!.name);
    expect(config.tools.mcpTrusted).toContain(third!.name);
    expect(config.tools.mcpTrusted).not.toContain('foo@bar');
  });

  it('leaves disabledTools alone — the survivor keeps the entry, by design', async () => {
    // A denial stored at the shared prefix was ambiguous BEFORE the rename —
    // there is no way to tell which of the two servers it was meant for.
    // Leaving it untouched resolves that for free: the survivor keeps the
    // original prefix, so the entry keeps applying to it; the renamed server
    // starts clean under its distinct new prefix rather than the entry being
    // guessed onto it.
    const workspace = await makeTempWorkspace();
    const globalDir = await makeTempWorkspace();
    const configPath = path.join(workspace, CASCADE_CONFIG_FILE);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      tools: {
        mcpServers: [
          { name: 'foo bar', url: 'https://a.example.com/mcp' },
          { name: 'foo@bar', url: 'https://b.example.com/mcp' },
        ],
        disabledTools: ['mcp__foo_bar__delete_everything'],
      },
    }), 'utf-8');

    const manager = new ConfigManager(workspace, globalDir);
    await manager.load();

    expect(manager.getConfig().tools.disabledTools).toEqual(['mcp__foo_bar__delete_everything']);
  });

  it('does not rewrite the file when nothing collides', async () => {
    const workspace = await makeTempWorkspace();
    const globalDir = await makeTempWorkspace();
    const configPath = path.join(workspace, CASCADE_CONFIG_FILE);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      tools: { mcpServers: [{ name: 'github', url: 'https://a' }, { name: 'notion', url: 'https://b' }] },
    }), 'utf-8');
    const before = (await fs.stat(configPath)).mtimeMs;

    const manager = new ConfigManager(workspace, globalDir);
    await manager.load();

    expect(manager.getConfig().tools.mcpServers!.map((s) => s.name)).toEqual(['github', 'notion']);
    const after = (await fs.stat(configPath)).mtimeMs;
    expect(after).toBe(before);
  });
});

describe('hasUsableProvider (CLI re-init bug fix)', () => {
  it('returns false with no providers configured', () => {
    expect(hasUsableProvider(undefined)).toBe(false);
    expect(hasUsableProvider([])).toBe(false);
  });

  it('returns false when the only provider needs a key and has none', () => {
    expect(hasUsableProvider([{ type: 'anthropic' }])).toBe(false);
  });

  it('returns true for an ollama entry with no apiKey (key-exempt)', () => {
    expect(hasUsableProvider([{ type: 'ollama' }])).toBe(true);
  });

  it('returns true for an openai-compatible entry with no apiKey (local server, key-exempt) — the actual bug', () => {
    // This is exactly the config the wizard persists for a local-only setup
    // (setup/index.tsx's keyOptional path) — the old predicate treated ONLY
    // 'ollama' as key-exempt and re-triggered the setup wizard on every run.
    expect(hasUsableProvider([{ type: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' }])).toBe(true);
  });

  it('returns true when a key-requiring provider actually has a key', () => {
    expect(hasUsableProvider([{ type: 'anthropic', apiKey: 'sk-ant-x' }])).toBe(true);
  });

  it('returns true for a bearer credential that names its gateway', () => {
    // cli/commands/link.ts stores a discovered credential in authToken, NOT
    // apiKey, and AnthropicProvider accepts either. Counting only apiKey called
    // that working install unconfigured: `cascade run` aborted with "No
    // providers configured" and the desktop reopened the full-screen wizard
    // over a config that runs fine.
    expect(hasUsableProvider([
      { type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://gateway.internal' },
    ])).toBe(true);
  });

  it('returns false for a bearer with no gateway to send it to', () => {
    // This case previously asserted TRUE, for a subscription OAuth token
    // `cascade link` used to adopt. This release makes such a token
    // non-adoptable, and holds that a bearer is only ever configured with the
    // gateway that issued it — so the shape is no longer reachable through any
    // config path. Calling it usable is not harmless: it skipped onboarding and
    // let the router select the provider, and AnthropicProvider then sent the
    // gateway's token to api.anthropic.com, because the SDK falls back to its
    // public default host when given no baseURL.
    expect(hasUsableProvider([{ type: 'anthropic', authToken: 'gw-token' }])).toBe(false);
  });

  it('still returns false for a provider with neither key nor token', () => {
    expect(hasUsableProvider([{ type: 'anthropic', apiKey: '', authToken: '' }])).toBe(false);
  });
});

describe('ANTHROPIC_AUTH_TOKEN — the gateway credential Anthropic documents', () => {
  const saved = process.env['ANTHROPIC_AUTH_TOKEN'];
  const savedKey = process.env['ANTHROPIC_API_KEY'];
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-authtoken-'));
    delete process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env['ANTHROPIC_AUTH_TOKEN'];
    else process.env['ANTHROPIC_AUTH_TOKEN'] = saved;
    if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedKey;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('configures an Anthropic provider from the environment', async () => {
    // Every other documented Anthropic credential was picked up from the
    // environment except this one, so a user following Anthropic's own gateway
    // instructions got "No providers configured".
    //
    // The gateway is set EXPLICITLY. It is required now, and this test passed
    // for a while only because ANTHROPIC_BASE_URL happened to be exported in
    // the development container — reading a value it never set, and failing the
    // moment CI ran it without one.
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    process.env['ANTHROPIC_BASE_URL'] = 'https://gateway.internal';
    const cm = new ConfigManager(dir);
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.authToken).toBe('gw-token');
    expect(anthropic?.baseUrl).toBe('https://gateway.internal');
    expect(hasUsableProvider(cm.getConfig().providers)).toBe(true);
  });

  it('does not overwrite a key the user already configured', async () => {
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-real';
    const cm = new ConfigManager(dir);
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.apiKey).toBe('sk-ant-real');
    expect(anthropic?.authToken).toBeUndefined();
  });
});

describe('getAuthToken — the companion to getApiKey', () => {
  let dir: string;
  // Provider variables are cleared before every test by vitest.setup.ts, so
  // each case sets exactly what it means to exercise.
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-gettoken-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('returns a bearer token configured in the environment', async () => {
    // Every status surface — `cascade doctor`, the dashboard, the desktop
    // onboarding gate — asks "is this provider set up". Answering from
    // getApiKey() alone called a bearer-only install unconfigured, and
    // `cascade link` sends the user straight to doctor to verify.
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    process.env['ANTHROPIC_BASE_URL'] = 'https://gateway.internal';
    const cm = new ConfigManager(dir);
    await cm.load();
    expect(cm.getAuthToken('anthropic')).toBe('gw-token');
  });

  it('reports nothing for a bearer the config refused to configure', async () => {
    // injectEnvKeys() will not build a provider from a gateway-less bearer, so
    // reading the variable directly told `cascade doctor` a credential was set
    // that the loaded config does not hold and could not use.
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    delete process.env['ANTHROPIC_BASE_URL'];
    const cm = new ConfigManager(dir);
    await cm.load();
    expect(cm.getAuthToken('anthropic')).toBeUndefined();
  });

  it('returns nothing for a provider that has neither', async () => {
    delete process.env['ANTHROPIC_AUTH_TOKEN'];
    const cm = new ConfigManager(dir);
    await cm.load();
    expect(cm.getAuthToken('openai')).toBeUndefined();
  });
});

describe('hasProviderCredential — one answer for every surface', () => {
  it('counts a bearer token as a credential, not only an API key', () => {
    // The same "counts only apiKey" mistake was written out by hand in four
    // places and fixed separately in each as it was noticed — the last of them
    // two review rounds after the first. This is the single predicate they all
    // go through now.
    expect(hasProviderCredential({ apiKey: 'sk' })).toBe(true);
    expect(hasProviderCredential({ authToken: 'gw-token', baseUrl: 'https://gateway.internal' })).toBe(true);
    expect(hasProviderCredential({})).toBe(false);
  });

  it('does not count a bearer with no gateway', () => {
    // Previously TRUE. A bearer is only valid at the gateway that issued it, so
    // without one there is nowhere it can be sent — and reporting it as a
    // credential is what let it reach the public host.
    expect(hasProviderCredential({ authToken: 'gw-token' })).toBe(false);
    expect(hasProviderCredential({ authToken: 'gw-token', baseUrl: '' })).toBe(false);
  });

  it('treats an empty string as no credential, and tolerates a missing entry', () => {
    expect(hasProviderCredential({ apiKey: '', authToken: '' })).toBe(false);
    expect(hasProviderCredential(undefined)).toBe(false);
    expect(hasProviderCredential(null)).toBe(false);
  });
});

describe('applyProviderApiKey — a new key must not be shadowed', () => {
  // AnthropicProvider reads authToken in preference to apiKey whenever both are
  // set. Three separate settings-save paths wrote only apiKey, so the key the
  // user had just typed was silently never used — indistinguishable, from the
  // UI, from the save having failed.
  it('clears a stale bearer token when a key replaces it', () => {
    const providers = [{ type: 'anthropic', authToken: 'stale-token' }];
    applyProviderApiKey(providers, 'anthropic', 'sk-ant-new');
    expect(providers[0]!.apiKey).toBe('sk-ant-new');
    expect(providers[0]!.authToken).toBeUndefined();
  });

  it('creates the entry when the provider is not configured yet', () => {
    const providers: Array<{ type: string; apiKey?: string; authToken?: string; baseUrl?: string }> = [];
    applyProviderApiKey(providers, 'openai', 'sk-new');
    expect(providers).toEqual([{ type: 'openai', apiKey: 'sk-new' }]);
  });

  it('carries an endpoint through when one is supplied', () => {
    const providers = [{ type: 'openai-compatible', apiKey: 'old', baseUrl: 'http://old/v1' }];
    applyProviderApiKey(providers, 'openai-compatible', 'new', { baseUrl: 'http://new/v1' });
    expect(providers[0]).toMatchObject({ apiKey: 'new', baseUrl: 'http://new/v1' });
  });

  it('leaves other providers alone', () => {
    const providers = [
      { type: 'anthropic', authToken: 'keep-me' },
      { type: 'openai', apiKey: 'old' },
    ];
    applyProviderApiKey(providers, 'openai', 'new');
    expect(providers[0]!.authToken).toBe('keep-me');
    expect(providers[1]!.apiKey).toBe('new');
  });
});

describe('ANTHROPIC_AUTH_TOKEN needs the gateway that issued it', () => {
  const savedToken = process.env['ANTHROPIC_AUTH_TOKEN'];
  const savedBase = process.env['ANTHROPIC_BASE_URL'];
  const savedKey = process.env['ANTHROPIC_API_KEY'];
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-bearer-'));
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_BASE_URL'];
  });
  afterEach(async () => {
    for (const [k, v] of [
      ['ANTHROPIC_AUTH_TOKEN', savedToken], ['ANTHROPIC_BASE_URL', savedBase],
      ['ANTHROPIC_API_KEY', savedKey],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not configure a bearer-only provider with nowhere to send it', async () => {
    // Without a gateway the client defaults to api.anthropic.com — sending the
    // token to a host that should never see it — while hasUsableProvider()
    // accepts the entry and skips onboarding.
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    const cm = new ConfigManager(dir);
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')).toBeUndefined();
  });

  it('configures it, with the gateway, when ANTHROPIC_BASE_URL is set', async () => {
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    process.env['ANTHROPIC_BASE_URL'] = 'https://gateway.internal';
    const cm = new ConfigManager(dir);
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic).toMatchObject({ authToken: 'gw-token', baseUrl: 'https://gateway.internal' });
  });
});

describe('an environment key and gateway are a pair', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-pair-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function seed(providers: unknown[]): Promise<void> {
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    await fs.writeFile(
      path.join(dir, CASCADE_CONFIG_FILE),
      JSON.stringify({ providers, models: {}, tools: {} }),
      'utf-8',
    );
  }

  async function seedGlobal(providers: unknown[]): Promise<string> {
    const globalDir = path.join(dir, 'global');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, 'credentials.json'),
      JSON.stringify({ version: 1, providers }),
      'utf-8',
    );
    return globalDir;
  }

  it('refuses a subscription token exported through ANTHROPIC_API_KEY', async () => {
    // The bearer branch classified the value; the API-key branch did not, so
    // this was written into `apiKey` on every load — surviving the migration
    // that had just stripped the stored copy, counted as a credential by
    // hasProviderCredential, and reported healthy until the provider threw.
    // An EMPTY workspace, so the creation gate is open and injectEnvKeys would
    // genuinely write this row. Seeding another provider closes that gate and
    // the assertion would hold for the wrong reason.
    await seed([]);
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-oat01-dead';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.apiKey).toBeUndefined();
  });

  it('does create the row for a legitimate exported key, so the gate is real', async () => {
    // Proves the test above is measuring the classifier and not an empty
    // workspace that would have produced no row either way.
    await seed([]);
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-genuine';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')?.apiKey)
      .toBe('sk-ant-genuine');
  });

  it('strips a stored subscription token that sits in apiKey', async () => {
    // The migration matched on `authToken` only, so the same dead secret in the
    // other field was left in the config entirely.
    await seed([{ type: 'anthropic', apiKey: 'sk-ant-oat01-dead' }]);

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic?.apiKey).toBeUndefined();
  });

  it('lets an exported API key outrank a provider that exists only globally', async () => {
    // `mayCreate` is false whenever the workspace file holds any other
    // provider, and the API-key path searched only the workspace list — so an
    // Anthropic row living only in ~/.cascade-ai/credentials.json had nothing
    // to fill and no permission to be created. The exported key was dropped,
    // and mergeGlobalCredentials() then restored the stored row, stale key and
    // endpoint included. The bearer branch already consulted the global store;
    // this is the same rule on its sibling path.
    await seed([{ type: 'openai', apiKey: 'ws-openai' }]);
    const globalDir = await seedGlobal([
      { type: 'anthropic', apiKey: 'old-global-key', baseUrl: 'https://old-gateway.internal' },
    ]);
    process.env['ANTHROPIC_API_KEY'] = 'fresh-env-key';
    process.env['ANTHROPIC_BASE_URL'] = 'https://new-gateway.internal';

    const cm = new ConfigManager(dir, globalDir);
    await cm.load();

    const anthropic = cm.getConfig().providers.filter((p) => p.type === 'anthropic');
    expect(anthropic).toHaveLength(1);
    expect(anthropic[0]).toMatchObject({
      apiKey: 'fresh-env-key',
      baseUrl: 'https://new-gateway.internal',
    });
  });

  it('leaves an exported key on the public host when no gateway is exported', async () => {
    // This previously asserted the opposite — that the row should inherit
    // `baseUrl` from the global store — on the reasoning that an endpointless
    // row "goes to the public host". For a bare ANTHROPIC_API_KEY the public
    // host is exactly right: that is where a console.anthropic.com key belongs.
    // Inheriting a stored corporate gateway paired a brand-new public key with
    // a host that never issued it.
    await seed([{ type: 'openai', apiKey: 'ws-openai' }]);
    const globalDir = await seedGlobal([
      { type: 'anthropic', apiKey: 'old-global-key', baseUrl: 'https://gateway.internal' },
    ]);
    process.env['ANTHROPIC_API_KEY'] = 'fresh-env-key';

    const cm = new ConfigManager(dir, globalDir);
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic')!;
    expect(anthropic.apiKey).toBe('fresh-env-key');
    expect(anthropic.baseUrl).toBeUndefined();
  });

  it('still pairs an exported key with an exported gateway', async () => {
    await seed([{ type: 'openai', apiKey: 'ws-openai' }]);
    const globalDir = await seedGlobal([
      { type: 'anthropic', apiKey: 'old-global-key', baseUrl: 'https://old-gateway.internal' },
    ]);
    process.env['ANTHROPIC_API_KEY'] = 'fresh-env-key';
    process.env['ANTHROPIC_BASE_URL'] = 'https://new-gateway.internal';

    const cm = new ConfigManager(dir, globalDir);
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')).toMatchObject({
      apiKey: 'fresh-env-key',
      baseUrl: 'https://new-gateway.internal',
    });
  });

  it('does not let a stored bearer shadow the key the environment just set', async () => {
    // apiKey and authToken compete: AnthropicProvider prefers the bearer. The
    // merge filled authToken into the row the env injection had just given an
    // API key, so the exported key was ignored AND the stale bearer travelled
    // to the newly exported gateway.
    await seed([{ type: 'openai', apiKey: 'ws-openai' }]);
    const globalDir = await seedGlobal([
      { type: 'anthropic', authToken: 'stale-bearer', baseUrl: 'https://old-gateway.internal' },
    ]);
    process.env['ANTHROPIC_API_KEY'] = 'fresh-env-key';
    process.env['ANTHROPIC_BASE_URL'] = 'https://new-gateway.internal';

    const cm = new ConfigManager(dir, globalDir);
    await cm.load();

    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic')!;
    expect(anthropic.apiKey).toBe('fresh-env-key');
    expect(anthropic.authToken).toBeUndefined();
    expect(anthropic.baseUrl).toBe('https://new-gateway.internal');
  });

  it('replaces a stale endpoint rather than sending the new key to the old host', async () => {
    // `??=` kept the configured URL, so a key exported alongside a different
    // gateway went to the host that did not issue it.
    await seed([{ type: 'anthropic', baseUrl: 'https://old-gateway.internal' }]);
    process.env['ANTHROPIC_API_KEY'] = 'new-key';
    process.env['ANTHROPIC_BASE_URL'] = 'https://new-gateway.internal';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic).toMatchObject({ apiKey: 'new-key', baseUrl: 'https://new-gateway.internal' });
  });

  it('leaves a configured endpoint alone when the environment names none', async () => {
    await seed([{ type: 'anthropic', baseUrl: 'https://configured.internal' }]);
    process.env['ANTHROPIC_API_KEY'] = 'new-key';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')?.baseUrl)
      .toBe('https://configured.internal');
  });

  it('replaces a stale endpoint when the bearer and gateway are exported together', async () => {
    // The API-key path was fixed for this; the bearer branch beside it kept
    // `??=` and so installed the new token against the old host — the exact
    // pairing rule, missed in the sibling case.
    await seed([{ type: 'anthropic', baseUrl: 'https://old-gateway.internal' }]);
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';
    process.env['ANTHROPIC_BASE_URL'] = 'https://new-gateway.internal';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')).toMatchObject({
      authToken: 'gw-token',
      baseUrl: 'https://new-gateway.internal',
    });
  });

  it('finds the bearer\'s gateway in the machine-global store', async () => {
    // injectEnvKeys runs BEFORE mergeGlobalCredentials — deliberately, so an
    // exported key outranks a stored one — which left this lookup reading a
    // config that was missing an endpoint the user had configured. A gateway
    // entered once in another workspace lives only in the global store, so
    // ANTHROPIC_AUTH_TOKEN on its own was refused for want of a gateway, and
    // the merge added that very endpoint a few lines later.
    await seed([]);
    const globalDir = await seedGlobal([{ type: 'anthropic', baseUrl: 'https://gw.internal' }]);
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';

    const cm = new ConfigManager(dir, globalDir);
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')).toMatchObject({
      authToken: 'gw-token',
      baseUrl: 'https://gw.internal',
    });
  });

  it('adopts the bearer even when the workspace already lists other providers', async () => {
    // `wasEmpty` was too narrow for the same reason: with any other provider in
    // the workspace file the Anthropic row was never created, though the global
    // store demonstrably holds one and the merge is about to bring it in.
    await seed([{ type: 'openai', apiKey: 'sk-openai' }]);
    const globalDir = await seedGlobal([{ type: 'anthropic', baseUrl: 'https://gw.internal' }]);
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';

    const cm = new ConfigManager(dir, globalDir);
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')?.authToken).toBe('gw-token');
  });

  it('still refuses a bearer with no gateway anywhere', async () => {
    // The requirement itself stands: a bearer sent to api.anthropic.com goes to
    // a host that should not see it, while hasUsableProvider() calls the
    // install configured and skips onboarding.
    await seed([{ type: 'openai', apiKey: 'sk-openai' }]);
    const globalDir = await seedGlobal([]);
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'gw-token';

    const cm = new ConfigManager(dir, globalDir);
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'anthropic')).toBeUndefined();
  });

  it('leaves an entry that already holds a gateway bearer', async () => {
    // AnthropicProvider prefers `authToken` when both are set, so filling the
    // key in and moving the endpoint with it sent the OLD gateway's bearer to
    // the NEW host while the exported key sat unused. `authToken` is a
    // credential — the bearer branch below already reads it that way — so the
    // entry is already configured and env injection leaves it alone.
    await seed([{ type: 'anthropic', authToken: 'gw-token', baseUrl: 'https://old-gateway.internal' }]);
    process.env['ANTHROPIC_API_KEY'] = 'new-key';
    process.env['ANTHROPIC_BASE_URL'] = 'https://new-gateway.internal';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    const anthropic = cm.getConfig().providers.find((p) => p.type === 'anthropic');
    expect(anthropic).toMatchObject({ authToken: 'gw-token', baseUrl: 'https://old-gateway.internal' });
    expect(anthropic?.apiKey).toBeUndefined();
  });

  it('gives an environment Azure key to the resource its endpoint names', async () => {
    // Filling the first keyless entry sent a resource-specific key to an
    // unrelated resource, which `cascade link azure` then persisted.
    await seed([
      { type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com' },
      { type: 'azure', deploymentName: 'b', baseUrl: 'https://two.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'az-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://two.openai.azure.com';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    const azure = cm.getConfig().providers.filter((p) => p.type === 'azure');
    expect(azure.find((p) => p.deploymentName === 'b')?.apiKey).toBe('az-key');
    expect(azure.find((p) => p.deploymentName === 'a')?.apiKey).toBeUndefined();
  });

  it('fills none when several Azure resources are configured and none is named', async () => {
    await seed([
      { type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com' },
      { type: 'azure', deploymentName: 'b', baseUrl: 'https://two.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'az-key';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    expect(cm.getConfig().providers.filter((p) => p.type === 'azure')
      .every((p) => p.apiKey === undefined)).toBe(true);
  });

  it('fills EVERY deployment on the named resource, not just the first', async () => {
    // An Azure key is resource-scoped, and Azure is configured one entry per
    // deployment — the router binds each model to its own row. Keying only the
    // first left the rest issuing requests with no credential at all.
    await seed([
      { type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com' },
      { type: 'azure', deploymentName: 'b', baseUrl: 'https://one.openai.azure.com' },
      { type: 'azure', deploymentName: 'c', baseUrl: 'https://two.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'az-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    const azure = cm.getConfig().providers.filter((p) => p.type === 'azure');
    expect(azure.find((p) => p.deploymentName === 'a')?.apiKey).toBe('az-key');
    expect(azure.find((p) => p.deploymentName === 'b')?.apiKey).toBe('az-key');
    expect(azure.find((p) => p.deploymentName === 'c')?.apiKey).toBeUndefined();
  });

  it('fills every deployment when there is only one resource and no endpoint named', async () => {
    await seed([
      { type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com' },
      { type: 'azure', deploymentName: 'b', baseUrl: 'https://one.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'az-key';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    expect(cm.getConfig().providers.filter((p) => p.type === 'azure')
      .every((p) => p.apiKey === 'az-key')).toBe(true);
  });

  it('matches the resource across a trailing slash', async () => {
    // AzureOpenAIProvider strips trailing slashes before it builds a client, so
    // these are the same service. Comparing the strings as typed matched
    // nothing and the key went nowhere.
    await seed([{ type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com' }]);
    process.env['AZURE_OPENAI_KEY'] = 'az-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com/';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    expect(cm.getConfig().providers.find((p) => p.type === 'azure')?.apiKey).toBe('az-key');
  });

  it('leaves a deployment that already has its own key', async () => {
    await seed([
      { type: 'azure', deploymentName: 'a', baseUrl: 'https://one.openai.azure.com', apiKey: 'own-key' },
      { type: 'azure', deploymentName: 'b', baseUrl: 'https://one.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'az-key';
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://one.openai.azure.com';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    const azure = cm.getConfig().providers.filter((p) => p.type === 'azure');
    expect(azure.find((p) => p.deploymentName === 'a')?.apiKey).toBe('own-key');
    expect(azure.find((p) => p.deploymentName === 'b')?.apiKey).toBe('az-key');
  });

});

describe('automatic Azure env routing agrees with `cascade link azure`', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['AZURE_OPENAI_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT'];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-azure-env-'));
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seedWorkspace(providers: unknown[]): Promise<void> {
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    await fs.writeFile(
      path.join(dir, CASCADE_CONFIG_FILE),
      JSON.stringify({ providers, models: {}, tools: {} }),
      'utf-8',
    );
  }

  async function seedGlobal(providers: unknown[]): Promise<string> {
    const globalDir = path.join(dir, 'global');
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, 'credentials.json'),
      JSON.stringify({ version: 1, providers }),
      'utf-8',
    );
    return globalDir;
  }

  it('creates a deployment the environment names, as the link command does', async () => {
    // The automatic path rotated the existing rows and never made the named
    // deployment — the explicit `cascade link azure` path was fixed for this
    // and the two then disagreed.
    await seedWorkspace([
      { type: 'azure', deploymentName: 'gpt-4o', baseUrl: 'https://acme.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'env-key';
    process.env['AZURE_OPENAI_DEPLOYMENT'] = 'gpt-4o-mini';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    const azure = cm.getConfig().providers.filter((p) => p.type === 'azure');

    expect(azure.find((p) => p.deploymentName === 'gpt-4o-mini')).toMatchObject({
      baseUrl: 'https://acme.openai.azure.com', apiKey: 'env-key',
    });
    expect(azure.find((p) => p.deploymentName === 'gpt-4o')?.apiKey).toBe('env-key');
  });

  it('sees Azure deployments held only in the machine-global store', async () => {
    // Reading the workspace alone made an unambiguous single-resource setup
    // look like no setup at all, so the exported key was dropped and the merge
    // restored the stale global row a few lines later.
    await seedWorkspace([{ type: 'openai', apiKey: 'sk-o' }]);
    const globalDir = await seedGlobal([
      { type: 'azure', deploymentName: 'gpt-4o', baseUrl: 'https://acme.openai.azure.com', apiKey: 'stale' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'env-key';

    const cm = new ConfigManager(dir, globalDir);
    await cm.load();
    const azure = cm.getConfig().providers.filter((p) => p.type === 'azure');
    expect(azure).toHaveLength(1);
    expect(azure[0]).toMatchObject({ deploymentName: 'gpt-4o', apiKey: 'env-key' });
  });

  it('still refuses when several resources are configured and none is named', async () => {
    await seedWorkspace([
      { type: 'azure', deploymentName: 'a', baseUrl: 'https://r1.openai.azure.com' },
      { type: 'azure', deploymentName: 'b', baseUrl: 'https://r2.openai.azure.com' },
    ]);
    process.env['AZURE_OPENAI_KEY'] = 'env-key';

    const cm = new ConfigManager(dir, path.join(dir, 'global'));
    await cm.load();
    for (const p of cm.getConfig().providers.filter((p) => p.type === 'azure')) {
      expect(p.apiKey).toBeUndefined();
    }
  });
});
