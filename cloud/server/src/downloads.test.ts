import { describe, it, expect, vi } from 'vitest';
import {
  DownloadResolver, buildManifest, classifyAsset, isTargetId, isTrustedAssetUrl,
  TARGET_META, CACHE_TTL_MS, CACHE_STALE_MS,
} from './downloads.js';

/**
 * The real asset list from the v0.68.0 release, names and sizes verbatim.
 *
 * Recorded rather than invented on purpose: the whole job of this module is
 * telling twenty real filenames apart, and a fixture written from memory would
 * only prove the classifier agrees with whatever I imagined electron-builder
 * emits. The two `.exe` files and the two `.dmg` files below are the cases that
 * actually decide whether a visitor gets something installable.
 */
const REAL_ASSETS = [
  ['Cascade-AI-0.68.0-arm64-mac.zip', 146673801],
  ['Cascade-AI-0.68.0-arm64.dmg', 151237300],
  ['Cascade-AI-0.68.0-arm64.dmg.blockmap', 158495],
  ['Cascade-AI-0.68.0-mac.zip', 151493725],
  ['Cascade-AI-0.68.0.AppImage', 162232955],
  ['Cascade-AI-0.68.0.dmg', 156061585],
  ['Cascade-AI-0.68.0.dmg.blockmap', 163857],
  ['Cascade-AI-0.68.0.exe', 127202528],
  ['cascade-ai-desktop-0.68.0.pacman', 102327136],
  ['cascade-ai-desktop-0.68.0.x86_64.rpm', 104177301],
  ['cascade-ai-desktop_0.68.0_amd64.deb', 102322284],
  ['Cascade-AI-Setup-0.68.0.exe', 127347976],
  ['Cascade-AI-Setup-0.68.0.exe.blockmap', 131306],
  ['Cascade.AI-0.68.0-arm64-mac.zip.blockmap', 151898],
  ['Cascade.AI-0.68.0-mac.zip.blockmap', 157597],
  ['latest-linux.yml', 708],
  ['latest-mac.yml', 820],
  ['latest.yml', 352],
] as const;

function realRelease() {
  return {
    tag_name: 'v0.68.0',
    published_at: '2026-08-04T06:16:17Z',
    assets: REAL_ASSETS.map(([name, size]) => ({
      name,
      size,
      browser_download_url: `https://github.com/Varun-SV/Cascade-AI/releases/download/v0.68.0/${name}`,
    })),
  };
}

function okResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe('classifyAsset', () => {
  it('keeps only installables from a real release', () => {
    const kept = REAL_ASSETS
      .map(([name]) => [name, classifyAsset(name)] as const)
      .filter(([, id]) => id !== null);

    expect(Object.fromEntries(kept)).toEqual({
      'Cascade-AI-0.68.0-arm64.dmg': 'mac-arm64',
      'Cascade-AI-0.68.0.dmg': 'mac-x64',
      'Cascade-AI-Setup-0.68.0.exe': 'win-x64',
      'Cascade-AI-0.68.0.AppImage': 'linux-appimage',
      'cascade-ai-desktop_0.68.0_amd64.deb': 'linux-deb',
      'cascade-ai-desktop-0.68.0.x86_64.rpm': 'linux-rpm',
      'cascade-ai-desktop-0.68.0.pacman': 'linux-pacman',
    });
  });

  it('rejects the portable .exe, which installs nothing', () => {
    expect(classifyAsset('Cascade-AI-0.68.0.exe')).toBeNull();
    expect(classifyAsset('Cascade-AI-Setup-0.68.0.exe')).toBe('win-x64');
  });

  it('rejects updater machinery — blockmaps, manifests and the mac zips', () => {
    for (const name of [
      'Cascade-AI-0.68.0.dmg.blockmap',
      'Cascade-AI-Setup-0.68.0.exe.blockmap',
      'latest.yml', 'latest-mac.yml', 'latest-linux.yml',
      'Cascade-AI-0.68.0-mac.zip', 'Cascade-AI-0.68.0-arm64-mac.zip',
    ]) {
      expect(classifyAsset(name), name).toBeNull();
    }
  });

  it('separates the two macOS builds by architecture', () => {
    expect(classifyAsset('Cascade-AI-9.9.9-arm64.dmg')).toBe('mac-arm64');
    expect(classifyAsset('Cascade-AI-9.9.9.dmg')).toBe('mac-x64');
  });
});

describe('buildManifest', () => {
  it('produces one entry per installable, in display order', () => {
    const manifest = buildManifest(realRelease());
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe('0.68.0');
    expect(manifest!.releasedAt).toBe('2026-08-04T06:16:17Z');
    // Ordered by TARGET_META rather than by GitHub's asset order.
    expect(manifest!.targets.map((t) => t.id)).toEqual(TARGET_META.map((m) => m.id));
  });

  it('carries the real filename and size through for each target', () => {
    const manifest = buildManifest(realRelease())!;
    const mac = manifest.targets.find((t) => t.id === 'mac-arm64')!;
    expect(mac.filename).toBe('Cascade-AI-0.68.0-arm64.dmg');
    expect(mac.sizeBytes).toBe(151237300);
    expect(mac.url).toBe('https://github.com/Varun-SV/Cascade-AI/releases/download/v0.68.0/Cascade-AI-0.68.0-arm64.dmg');
    expect(mac.detail).toBe('Apple silicon');
  });

  it('drops assets hosted anywhere but GitHub', () => {
    const manifest = buildManifest({
      tag_name: 'v1.0.0',
      assets: [
        { name: 'Cascade-AI-1.0.0.dmg', size: 1, browser_download_url: 'https://evil.example.com/x.dmg' },
        { name: 'Cascade-AI-1.0.0-arm64.dmg', size: 2, browser_download_url: 'https://github.com/ok.dmg' },
      ],
    });
    expect(manifest!.targets.map((t) => t.id)).toEqual(['mac-arm64']);
  });

  it('strips the leading v from the tag', () => {
    expect(buildManifest({ tag_name: 'v1.2.3', assets: [{ name: 'a.dmg', size: 1, browser_download_url: 'https://github.com/a.dmg' }] })!.version).toBe('1.2.3');
  });

  it('returns null rather than an empty shell when nothing is installable', () => {
    expect(buildManifest({ tag_name: 'v1.0.0', assets: [{ name: 'latest.yml', size: 1, browser_download_url: 'https://github.com/latest.yml' }] })).toBeNull();
    expect(buildManifest({ tag_name: 'v1.0.0', assets: [] })).toBeNull();
    expect(buildManifest({ assets: [] })).toBeNull();
    expect(buildManifest(null)).toBeNull();
    expect(buildManifest('nope')).toBeNull();
  });

  it('keeps the first asset when two claim the same target', () => {
    const manifest = buildManifest({
      tag_name: 'v1.0.0',
      assets: [
        { name: 'first-arm64.dmg', size: 10, browser_download_url: 'https://github.com/first.dmg' },
        { name: 'second-arm64.dmg', size: 20, browser_download_url: 'https://github.com/second.dmg' },
      ],
    });
    expect(manifest!.targets).toHaveLength(1);
    expect(manifest!.targets[0]!.filename).toBe('first-arm64.dmg');
  });
});

describe('isTrustedAssetUrl', () => {
  it('accepts GitHub over https only', () => {
    expect(isTrustedAssetUrl('https://github.com/a/b/releases/download/v1/x.dmg')).toBe(true);
    expect(isTrustedAssetUrl('https://objects.github.com/x.dmg')).toBe(true);
    expect(isTrustedAssetUrl('http://github.com/x.dmg')).toBe(false);
  });

  it('rejects lookalike hosts and junk', () => {
    for (const url of [
      'https://github.com.evil.example/x.dmg',
      'https://notgithub.com/x.dmg',
      'https://evil.example/github.com/x.dmg',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(isTrustedAssetUrl(url), url).toBe(false);
    }
  });
});

describe('isTargetId', () => {
  it('accepts known targets and rejects anything else', () => {
    expect(isTargetId('mac-arm64')).toBe(true);
    expect(isTargetId('linux-pacman')).toBe(true);
    expect(isTargetId('../../etc/passwd')).toBe(false);
    expect(isTargetId('mac')).toBe(false);
    expect(isTargetId('')).toBe(false);
  });
});

describe('DownloadResolver', () => {
  it('asks GitHub once and serves the cache until the TTL expires', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    const resolver = new DownloadResolver(fetchImpl as unknown as typeof fetch, () => now);

    expect((await resolver.get())!.version).toBe('0.68.0');
    now += CACHE_TTL_MS - 1;
    expect((await resolver.get())!.version).toBe('0.68.0');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 2;
    await resolver.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends the headers GitHub requires', async () => {
    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    await new DownloadResolver(fetchImpl as unknown as typeof fetch).get();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/Varun-SV/Cascade-AI/releases/latest');
    // Without a User-Agent the API answers 403 — the one header that is not
    // optional politeness.
    expect((init.headers as Record<string, string>)['User-Agent']).toBeTruthy();
    expect((init.headers as Record<string, string>).Accept).toBe('application/vnd.github+json');
  });

  it('collapses a stampede on a cold cache into one request', async () => {
    let release: (v: Response) => void = () => {};
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { release = r; }));
    const resolver = new DownloadResolver(fetchImpl as unknown as typeof fetch);

    const all = Promise.all([resolver.get(), resolver.get(), resolver.get()]);
    release(okResponse(realRelease()));
    const results = await all;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results.every((m) => m?.version === '0.68.0')).toBe(true);
  });

  it('keeps serving the last good answer when GitHub starts failing', async () => {
    let now = 1_000;
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error('network down');
      return okResponse(realRelease());
    });
    const resolver = new DownloadResolver(fetchImpl as unknown as typeof fetch, () => now);

    await resolver.get();
    fail = true;
    now += CACHE_TTL_MS + 1;

    // Stale but correct: release assets are append-only, so a slightly old
    // list still points at files that exist.
    expect((await resolver.get())!.version).toBe('0.68.0');

    // Past the stale window it stops pretending it knows.
    now += CACHE_STALE_MS;
    expect(await resolver.get()).toBeNull();
  });

  it('returns null on a rate-limited or errored response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({}) } as unknown as Response));
    expect(await new DownloadResolver(fetchImpl as unknown as typeof fetch).get()).toBeNull();
  });

  it('returns null rather than throwing on malformed JSON', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } } as unknown as Response));
    expect(await new DownloadResolver(fetchImpl as unknown as typeof fetch).get()).toBeNull();
  });
});
