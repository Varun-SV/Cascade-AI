import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigManager, hasUsableProvider } from './index.js';
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

  it('returns true for an Anthropic OAuth token adopted by `cascade link`', () => {
    // cli/commands/link.ts stores a discovered OAuth credential in authToken,
    // NOT apiKey, and AnthropicProvider.isAvailable() accepts either. Counting
    // only apiKey called that working install unconfigured: `cascade run`
    // aborted with "No providers configured" and the desktop reopened the
    // full-screen wizard over a config that runs fine.
    expect(hasUsableProvider([{ type: 'anthropic', authToken: 'sk-ant-oat-x' }])).toBe(true);
  });

  it('still returns false for a provider with neither key nor token', () => {
    expect(hasUsableProvider([{ type: 'anthropic', apiKey: '', authToken: '' }])).toBe(false);
  });
});
