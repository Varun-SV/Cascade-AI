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
});
