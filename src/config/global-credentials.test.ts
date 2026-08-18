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

  it('never sends one Azure resource\u2019s key to a different resource', () => {
    // Azure keys are resource-scoped, and a deployment name is only unique
    // WITHIN a resource. Keying the merge on the deployment name alone meant
    // the endpoint never participated in the normal routed shape, so a global
    // row for resource A named "prod" matched a workspace row named "prod" on
    // resource B — the merge kept B's own baseUrl and filled its missing
    // apiKey from A. `cascade link` already refuses to reuse a deployment name
    // across resources; the global store has to hold the same invariant.
    const merged = mergeGlobalCredentials(
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-b.openai.azure.com' }],
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', apiKey: 'key-for-a' }],
    );

    const onB = merged.find((p) => p.baseUrl === 'https://resource-b.openai.azure.com')!;
    expect(onB.apiKey).toBeUndefined();

    // Resource A's row is a DIFFERENT entry, kept whole rather than folded in.
    const onA = merged.find((p) => p.baseUrl === 'https://resource-a.openai.azure.com')!;
    expect(onA.apiKey).toBe('key-for-a');
    expect(merged.filter((p) => p.type === 'azure')).toHaveLength(2);
  });

  it('still adopts the resource for a workspace row that names only a deployment', () => {
    // The case the global store exists for, and the one a strict
    // endpoint+deployment key would have broken: an identifier absent on one
    // side is not a disagreement, so this row adopts both endpoint and key.
    const merged = mergeGlobalCredentials(
      [{ type: 'azure', deploymentName: 'prod' }],
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', apiKey: 'key-for-a' }],
    );

    expect(merged.filter((p) => p.type === 'azure')).toHaveLength(1);
    expect(merged[0]!.baseUrl).toBe('https://resource-a.openai.azure.com');
    expect(merged[0]!.apiKey).toBe('key-for-a');
  });

  it('does not let differing display labels split one deployment in two', () => {
    // `label` is a name the user types, so the same deployment on the same
    // resource routinely carries two of them. Weighing it beside the real
    // identifiers made this pair non-matching, so the global row was APPENDED
    // rather than filling the workspace row — and the router binds an Azure
    // model with `configs.find(... deploymentName === model.id)`, so the
    // first, keyless workspace row won and every request failed while a
    // correctly keyed duplicate sat behind it.
    const merged = mergeGlobalCredentials(
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', label: 'project prod' }],
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', label: 'prod', apiKey: 'key-for-a' }],
    );

    const azure = merged.filter((p) => p.type === 'azure');
    expect(azure).toHaveLength(1);
    expect(azure[0]!.apiKey).toBe('key-for-a');
    // The workspace's own display name is not overwritten by the global one.
    expect(azure[0]!.label).toBe('project prod');
  });

  it('still refuses to match across resources even when the labels agree', () => {
    // Label must not rescue a match the real identifiers reject, either.
    const merged = mergeGlobalCredentials(
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-b.openai.azure.com', label: 'prod' }],
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', label: 'prod', apiKey: 'key-for-a' }],
    );
    expect(merged.filter((p) => p.type === 'azure')).toHaveLength(2);
    expect(merged.find((p) => p.baseUrl?.includes('resource-b'))?.apiKey).toBeUndefined();
  });

  it('falls back to the label only when neither row names anything real', () => {
    const merged = mergeGlobalCredentials(
      [{ type: 'azure', label: 'prod' }],
      [{ type: 'azure', label: 'prod', apiKey: 'key-for-a' }],
    );
    expect(merged.filter((p) => p.type === 'azure')).toHaveLength(1);
    expect(merged[0]!.apiKey).toBe('key-for-a');
  });

  it('will not join two rows on a label when their real identities are unrelated', () => {
    // Previously joined. Neither strong identifier is present on BOTH rows —
    // one names a deployment, the other a resource — so the old check fell
    // through to the label and matched on a display name the user typed,
    // assigning resource A's key to `prod` on a guess. Label is metadata, not
    // identity: uncorrelated strong identities mean "different rows", not
    // "ask the label".
    const merged = mergeGlobalCredentials(
      [{ type: 'azure', deploymentName: 'prod', label: 'main' }],
      [{ type: 'azure', baseUrl: 'https://resource-a.openai.azure.com', label: 'main', apiKey: 'key-for-a' }],
    );

    const azure = merged.filter((p) => p.type === 'azure');
    expect(azure).toHaveLength(2);
    expect(azure.find((p) => p.deploymentName === 'prod')?.apiKey).toBeUndefined();
    expect(azure.find((p) => p.deploymentName === 'prod')?.baseUrl).toBeUndefined();
  });

  it('treats a trailing slash as the same resource, not a second one', () => {
    const merged = mergeGlobalCredentials(
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com/' }],
      [{ type: 'azure', deploymentName: 'prod', baseUrl: 'https://resource-a.openai.azure.com', apiKey: 'key-for-a' }],
    );
    expect(merged.filter((p) => p.type === 'azure')).toHaveLength(1);
    expect(merged[0]!.apiKey).toBe('key-for-a');
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

  it('never pairs a global bearer with a different gateway', () => {
    // Non-Azure rows match on provider type alone, so a credentialless
    // workspace row naming gateway B accepted the global row's token from
    // gateway A — and the `!existing.baseUrl` guard left B's endpoint in place.
    // The result passes every usability check on the way to the wire, and
    // AnthropicProvider sends A's bearer to B.
    const merged = mergeGlobalCredentials(
      [{ type: 'anthropic', baseUrl: 'https://gw-b.example' }],
      [{ type: 'anthropic', authToken: 'token-a', baseUrl: 'https://gw-a.example' }],
    );

    const anthropic = merged.find((p) => p.type === 'anthropic')!;
    expect(anthropic.authToken).toBeUndefined();
    expect(anthropic.baseUrl).toBe('https://gw-b.example');
  });

  it('adopts a bearer together with the gateway that issued it', () => {
    // A workspace row with no endpoint of its own takes both.
    const merged = mergeGlobalCredentials(
      [{ type: 'anthropic' }],
      [{ type: 'anthropic', authToken: 'token-a', baseUrl: 'https://gw-a.example' }],
    );

    const anthropic = merged.find((p) => p.type === 'anthropic')!;
    expect(anthropic.authToken).toBe('token-a');
    expect(anthropic.baseUrl).toBe('https://gw-a.example');
  });

  it('adopts a bearer when both name the same gateway, trailing slash aside', () => {
    const merged = mergeGlobalCredentials(
      [{ type: 'anthropic', baseUrl: 'https://gw-a.example/' }],
      [{ type: 'anthropic', authToken: 'token-a', baseUrl: 'https://gw-a.example' }],
    );
    expect(merged.find((p) => p.type === 'anthropic')?.authToken).toBe('token-a');
  });

  it('will not adopt a stored bearer that names no gateway at all', () => {
    // Nowhere to send it, so it is not a credential — the rule the rest of the
    // release holds. Adopting it would make the row look configured.
    const merged = mergeGlobalCredentials(
      [{ type: 'anthropic' }],
      [{ type: 'anthropic', authToken: 'token-a' }],
    );
    expect(merged.find((p) => p.type === 'anthropic')?.authToken).toBeUndefined();
  });

  it('never pairs a global API key with a different endpoint either', () => {
    // The round-27 guard covered `authToken` only, so this line still copied
    // `apiKey` before considering the endpoint: a credentialless workspace row
    // on gateway B took the global row's key from gateway A and kept B's URL.
    // The environment path already treats ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL
    // as a pair; the store has to hold the same invariant.
    const merged = mergeGlobalCredentials(
      [{ type: 'anthropic', baseUrl: 'https://gw-b.example' }],
      [{ type: 'anthropic', apiKey: 'key-a', baseUrl: 'https://gw-a.example' }],
    );

    const anthropic = merged.find((p) => p.type === 'anthropic')!;
    expect(anthropic.apiKey).toBeUndefined();
    expect(anthropic.baseUrl).toBe('https://gw-b.example');
  });

  it('adopts an API key together with the endpoint it belongs to', () => {
    const merged = mergeGlobalCredentials(
      [{ type: 'openai-compatible' }],
      [{ type: 'openai-compatible', apiKey: 'key-a', baseUrl: 'https://openrouter.ai/api/v1' }],
    );
    const row = merged.find((p) => p.type === 'openai-compatible')!;
    expect(row.apiKey).toBe('key-a');
    expect(row.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('still adopts a plain API key when neither row names an endpoint', () => {
    const merged = mergeGlobalCredentials(
      [{ type: 'openai' }],
      [{ type: 'openai', apiKey: 'sk-o' }],
    );
    expect(merged.find((p) => p.type === 'openai')?.apiKey).toBe('sk-o');
  });

  it('does not graft a global endpoint onto a row that has its own credential', () => {
    // The refusal was one-sided: a secret could not be imported into a row
    // naming a different host, but the endpoint fill ran unconditionally. So a
    // workspace row holding a project key and no endpoint silently acquired the
    // global row's corporate gateway — sending that key to a host it was never
    // paired with.
    const merged = mergeGlobalCredentials(
      [{ type: 'anthropic', apiKey: 'project-key' }],
      [{ type: 'anthropic', apiKey: 'old-gateway-key', baseUrl: 'https://corp-gw.example' }],
    );

    const anthropic = merged.find((p) => p.type === 'anthropic')!;
    expect(anthropic.apiKey).toBe('project-key');
    expect(anthropic.baseUrl).toBeUndefined();
  });

  it('still gives an endpoint to a row that brought no credential', () => {
    const merged = mergeGlobalCredentials(
      [{ type: 'anthropic' }],
      [{ type: 'anthropic', apiKey: 'gw-key', baseUrl: 'https://corp-gw.example' }],
    );
    expect(merged.find((p) => p.type === 'anthropic')).toMatchObject({
      apiKey: 'gw-key', baseUrl: 'https://corp-gw.example',
    });
  });

  it('spreads a resource-scoped Azure key across every deployment on it', () => {
    // Azure keys are resource-scoped. A global row naming the RESOURCE and no
    // deployment matched through `find`, so only the first workspace deployment
    // got the key and its siblings stayed keyless — failing every request while
    // the first worked.
    const merged = mergeGlobalCredentials(
      [
        { type: 'azure', deploymentName: 'gpt-4o', baseUrl: 'https://r1.openai.azure.com' },
        { type: 'azure', deploymentName: 'gpt-4o-mini', baseUrl: 'https://r1.openai.azure.com' },
        { type: 'azure', deploymentName: 'other', baseUrl: 'https://r2.openai.azure.com' },
      ],
      [{ type: 'azure', baseUrl: 'https://r1.openai.azure.com', apiKey: 'key-r1' }],
    );

    const on = (name: string) => merged.find((p) => p.deploymentName === name);
    expect(on('gpt-4o')?.apiKey).toBe('key-r1');
    expect(on('gpt-4o-mini')?.apiKey).toBe('key-r1');
    // …and nothing on the other resource.
    expect(on('other')?.apiKey).toBeUndefined();
  });

  it('keeps an Azure deployment endpoint fill, which its deployment name pins', () => {
    // The non-Azure graft rule must not break this: a matching deployment name
    // identifies its resource, so the global row is the only record of where
    // that deployment lives, not a guess.
    const merged = mergeGlobalCredentials(
      [{ type: 'azure', deploymentName: 'gpt-4o', apiKey: 'ws-key' }],
      [{ type: 'azure', deploymentName: 'gpt-4o', apiKey: 'global-key', baseUrl: 'https://r1.openai.azure.com' }],
    );
    const row = merged.find((p) => p.deploymentName === 'gpt-4o')!;
    expect(row.apiKey).toBe('ws-key');
    expect(row.baseUrl).toBe('https://r1.openai.azure.com');
  });
});
