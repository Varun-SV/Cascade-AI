import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  credentialsPath,
  loadGlobalCredentials,
  mergeGlobalCredentials,
  saveGlobalCredentials,
} from './global-credentials.js';
import { ConfigManager } from './index.js';
import type { ProviderConfig } from '../types.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('global credentials store', () => {
  it('round-trips credential-bearing providers and skips key-less locals', async () => {
    const dir = await makeTempDir('cascade-creds-');
    saveGlobalCredentials(dir, [
      { type: 'anthropic', apiKey: 'sk-ant-1' },
      { type: 'ollama' }, // nothing to persist
      { type: 'azure', label: 'prod', apiKey: 'az-1', baseUrl: 'https://r1.openai.azure.com', deploymentName: 'gpt-4o' },
      { type: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' }, // endpoint counts
    ]);
    const loaded = loadGlobalCredentials(dir);
    expect(loaded.map((p) => p.type).sort()).toEqual(['anthropic', 'azure', 'openai-compatible']);
    expect(loaded.find((p) => p.type === 'azure')?.deploymentName).toBe('gpt-4o');
  });

  it('writes the file with owner-only permissions (0600)', async () => {
    const dir = await makeTempDir('cascade-creds-');
    saveGlobalCredentials(dir, [{ type: 'openai', apiKey: 'sk-x' }]);
    // Windows has no POSIX modes; the check is meaningful on Linux/macOS.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(credentialsPath(dir)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('returns [] for a missing or corrupt file', async () => {
    const dir = await makeTempDir('cascade-creds-');
    expect(loadGlobalCredentials(dir)).toEqual([]);
    fs.writeFileSync(credentialsPath(dir), '{not json', 'utf-8');
    expect(loadGlobalCredentials(dir)).toEqual([]);
  });

  it('merge appends missing providers and fills missing keys, workspace key wins', () => {
    const workspace: ProviderConfig[] = [
      { type: 'anthropic', apiKey: 'workspace-key' }, // has own key — must win
      { type: 'openai' },                             // present but key-less — fill
    ];
    const global: ProviderConfig[] = [
      { type: 'anthropic', apiKey: 'global-key' },
      { type: 'openai', apiKey: 'global-openai' },
      { type: 'gemini', apiKey: 'global-gemini' },    // absent — append
    ];
    const merged = mergeGlobalCredentials(workspace, global);
    expect(merged.find((p) => p.type === 'anthropic')?.apiKey).toBe('workspace-key');
    expect(merged.find((p) => p.type === 'openai')?.apiKey).toBe('global-openai');
    expect(merged.find((p) => p.type === 'gemini')?.apiKey).toBe('global-gemini');
  });

  it('merges azure entries per deployment, not per type', () => {
    const workspace: ProviderConfig[] = [
      { type: 'azure', deploymentName: 'gpt-4o', apiKey: 'ws-key' },
    ];
    const global: ProviderConfig[] = [
      { type: 'azure', deploymentName: 'gpt-4o', apiKey: 'global-key', baseUrl: 'https://r1.openai.azure.com' },
      { type: 'azure', deploymentName: 'gpt-35', apiKey: 'global-35', baseUrl: 'https://r2.openai.azure.com' },
    ];
    const merged = mergeGlobalCredentials(workspace, global);
    const azure = merged.filter((p) => p.type === 'azure');
    expect(azure).toHaveLength(2);
    const gpt4o = azure.find((p) => p.deploymentName === 'gpt-4o')!;
    expect(gpt4o.apiKey).toBe('ws-key');                        // workspace key wins
    expect(gpt4o.baseUrl).toBe('https://r1.openai.azure.com');  // missing endpoint filled
    expect(azure.find((p) => p.deploymentName === 'gpt-35')?.apiKey).toBe('global-35');
  });
});

describe('ConfigManager + global credentials (the "AppImage forgets my keys" bug)', () => {
  it('keys saved in one workspace are available when a FRESH workspace loads', async () => {
    const globalDir = await makeTempDir('cascade-global-');
    const workspaceA = await makeTempDir('cascade-ws-a-');
    const workspaceB = await makeTempDir('cascade-ws-b-');

    // Workspace A: user enters keys + azure deployments, saves.
    const cmA = new ConfigManager(workspaceA, globalDir);
    await cmA.load();
    cmA.getConfig().providers.push(
      { type: 'anthropic', apiKey: 'sk-ant-persist' },
      { type: 'azure', label: 'prod', apiKey: 'az-persist', baseUrl: 'https://r.openai.azure.com', deploymentName: 'gpt-4o', apiVersion: '2024-08-01-preview' },
    );
    await cmA.save();
    cmA.getStore().close();

    // Workspace B: brand new folder, no config at all — the app-restart-in-a-
    // different-workspace scenario that previously lost everything.
    const cmB = new ConfigManager(workspaceB, globalDir);
    await cmB.load();
    const providers = cmB.getConfig().providers;
    expect(providers.find((p) => p.type === 'anthropic')?.apiKey).toBe('sk-ant-persist');
    const azure = providers.find((p) => p.type === 'azure');
    expect(azure?.apiKey).toBe('az-persist');
    expect(azure?.deploymentName).toBe('gpt-4o');
    expect(azure?.baseUrl).toBe('https://r.openai.azure.com');
    cmB.getStore().close();
  });

  it('removing a provider and saving removes it from the global store too', async () => {
    const globalDir = await makeTempDir('cascade-global-');
    const workspace = await makeTempDir('cascade-ws-');

    const cm1 = new ConfigManager(workspace, globalDir);
    await cm1.load();
    cm1.getConfig().providers.push({ type: 'openai', apiKey: 'sk-tmp' });
    await cm1.save();
    cm1.getStore().close();

    const cm2 = new ConfigManager(workspace, globalDir);
    await cm2.load();
    const cfg = cm2.getConfig();
    cfg.providers = cfg.providers.filter((p) => p.type !== 'openai');
    await cm2.save();
    cm2.getStore().close();

    expect(loadGlobalCredentials(globalDir).find((p) => p.type === 'openai')).toBeUndefined();
  });
});
