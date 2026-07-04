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
