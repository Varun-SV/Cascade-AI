import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DownloadResolver, buildManifest, classifyAsset, isTargetId, isTrustedAssetUrl,
  TARGET_META, CACHE_TTL_MS, CACHE_STALE_MS, REFRESH_RETRY_MS, RELEASES_PAGE_URL,
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
    // Waits for the call rather than assuming it happens within one microtask
    // of get(): the resolver reads its on-disk warm start first, so how many
    // ticks precede the fetch is an implementation detail this test should not
    // encode. Releasing early left the promise pending and timed the test out.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
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

  it('does not re-ask a failing GitHub on every request', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => { throw new Error('rate limited'); });
    const resolver = new DownloadResolver(fetchImpl as unknown as typeof fetch, () => now);

    expect(await resolver.get()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // SEQUENTIAL callers, which is what real traffic looks like — `inFlight`
    // only ever covered concurrent ones, so without negative caching each of
    // these would be another GitHub request during an outage.
    now += 1_000;
    expect(await resolver.get()).toBeNull();
    now += 1_000;
    expect(await resolver.get()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Once the retry window passes it tries again, so a transient failure
    // clears on its own rather than blacking the section out for a full TTL.
    now += REFRESH_RETRY_MS;
    await resolver.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('serves the stale manifest without another call during the retry window', async () => {
    let now = 1_000_000;
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error('network down');
      return okResponse(realRelease());
    });
    const resolver = new DownloadResolver(fetchImpl as unknown as typeof fetch, () => now);

    await resolver.get();
    fail = true;
    now += CACHE_TTL_MS + 1;

    // First call past the TTL genuinely tries, fails, and falls back to stale.
    expect((await resolver.get())!.version).toBe('0.68.0');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // The next one gets the same answer immediately, with no doomed request in
    // front of it — the visitor does not wait on a timeout to see the section.
    now += 1_000;
    expect((await resolver.get())!.version).toBe('0.68.0');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

describe('DownloadResolver — authentication and the on-disk warm start', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-dl-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const cacheFile = () => path.join(dir, 'downloads-manifest.json');

  it('sends no Authorization header when no token is configured', async () => {
    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    await new DownloadResolver(fetchImpl as unknown as typeof fetch).get();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('authenticates the release lookup when a token is configured', async () => {
    // Unauthenticated the API allows 60/hour PER IP, and a shared host's
    // egress IP is shared with every other tenant on it — which is how a
    // redeploy could land straight into a rate limit nothing here caused.
    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    await new DownloadResolver(fetchImpl as unknown as typeof fetch, Date.now, { token: 'ghp_x' }).get();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ghp_x');
    // The headers GitHub requires are still sent alongside it.
    expect((init.headers as Record<string, string>)['User-Agent']).toBeTruthy();
  });

  it('treats a blank token as no token, rather than sending "Bearer "', async () => {
    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    await new DownloadResolver(fetchImpl as unknown as typeof fetch, Date.now, { token: '  ' }).get();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('persists a resolved manifest so the next process starts warm', async () => {
    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    const first = new DownloadResolver(fetchImpl as unknown as typeof fetch, Date.now, { cacheFile: cacheFile() });
    expect((await first.get())!.version).toBe('0.68.0');
    // The write is fire-and-forget, so let it land before reading it back.
    await vi.waitFor(() => expect(fs.existsSync(cacheFile())).toBe(true));

    // A NEW process (new resolver, no memory) whose very first fetch fails.
    // Before the warm start this was the "downloads unavailable" case: the
    // 24h stale window needs a prior success IN THIS PROCESS to fall back to.
    const failing = vi.fn(async () => { throw new Error('rate limited'); });
    const second = new DownloadResolver(failing as unknown as typeof fetch, Date.now, { cacheFile: cacheFile() });
    expect((await second.get())!.version).toBe('0.68.0');
  });

  it('still expires the warm-started copy once it is genuinely ancient', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    const first = new DownloadResolver(fetchImpl as unknown as typeof fetch, () => now, { cacheFile: cacheFile() });
    await first.get();
    await vi.waitFor(() => expect(fs.existsSync(cacheFile())).toBe(true));

    now += CACHE_STALE_MS + 1;
    const failing = vi.fn(async () => { throw new Error('down'); });
    const second = new DownloadResolver(failing as unknown as typeof fetch, () => now, { cacheFile: cacheFile() });
    expect(await second.get()).toBeNull();
  });

  it('ignores a cache file whose timestamp is in the future', async () => {
    // Both the freshness and staleness checks are `now - fetchedAt`, so a
    // future value makes the age negative — which reads as "just fetched"
    // forever and pins the site to one obsolete release, with the 15-minute
    // TTL unable to expire it. A host clock corrected backwards produces one.
    fs.writeFileSync(cacheFile(), JSON.stringify({
      fetchedAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      manifest: {
        version: '0.1.0', releasedAt: null,
        targets: [{ id: 'mac-arm64', os: 'mac', label: 'macOS', detail: 'Apple silicon',
          filename: 'old.dmg', sizeBytes: 10,
          url: 'https://github.com/Varun-SV/Cascade-AI/releases/download/v0.1.0/old.dmg' }],
      },
    }), 'utf8');

    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    const manifest = await new DownloadResolver(fetchImpl as unknown as typeof fetch, Date.now, { cacheFile: cacheFile() }).get();
    // The stale-future copy was discarded and a real fetch happened.
    expect(manifest!.version).toBe('0.68.0');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('still accepts a timestamp a little ahead, for ordinary clock skew', async () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({
      fetchedAt: Date.now() + 30_000,
      manifest: {
        version: '0.68.0', releasedAt: null,
        targets: [{ id: 'mac-arm64', os: 'mac', label: 'macOS', detail: 'Apple silicon',
          filename: 'x.dmg', sizeBytes: 10,
          url: 'https://github.com/Varun-SV/Cascade-AI/releases/download/v0.68.0/x.dmg' }],
      },
    }), 'utf8');

    const failing = vi.fn(async () => { throw new Error('down'); });
    expect((await new DownloadResolver(failing as unknown as typeof fetch, Date.now, { cacheFile: cacheFile() }).get())!.version).toBe('0.68.0');
  });

  it('ignores a corrupt cache file instead of failing the lookup', async () => {
    fs.writeFileSync(cacheFile(), '{"manifest":{"version":"0.6', 'utf8');
    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    const resolver = new DownloadResolver(fetchImpl as unknown as typeof fetch, Date.now, { cacheFile: cacheFile() });
    expect((await resolver.get())!.version).toBe('0.68.0');
  });

  it('rebuilds fixed target metadata rather than trusting what the file says', async () => {
    // os/label/detail are constants keyed by the target id, so they never come
    // off disk. A stale or hand-edited entry missing `os` used to pass
    // validation and reach the page, where the download section indexes its
    // icon map by that field — an undefined lookup throws while rendering and
    // takes the whole section down, which is worse than the missing-manifest
    // fallback the warm start exists to avoid.
    fs.writeFileSync(cacheFile(), JSON.stringify({
      fetchedAt: Date.now(),
      manifest: {
        version: '0.68.0',
        releasedAt: null,
        targets: [
          // No os, a non-string label, junk detail — all reconstructed.
          { id: 'mac-arm64', label: 42, detail: null, filename: 'x.dmg', sizeBytes: 10,
            url: 'https://github.com/Varun-SV/Cascade-AI/releases/download/v0.68.0/x.dmg' },
        ],
      },
    }), 'utf8');

    const failing = vi.fn(async () => { throw new Error('down'); });
    const manifest = await new DownloadResolver(failing as unknown as typeof fetch, Date.now, { cacheFile: cacheFile() }).get();

    const target = manifest!.targets[0]!;
    expect(target.os).toBe('mac');
    expect(target.label).toBe('macOS');
    expect(target.detail).toBe('Apple silicon');
    // The genuinely per-release fields still come from the file.
    expect(target.filename).toBe('x.dmg');
    expect(target.sizeBytes).toBe(10);
  });

  it('drops a stored target with a zero or negative size', async () => {
    fs.writeFileSync(cacheFile(), JSON.stringify({
      fetchedAt: Date.now(),
      manifest: {
        version: '0.68.0', releasedAt: null,
        targets: [{ id: 'mac-arm64', os: 'mac', label: 'macOS', detail: 'Apple silicon',
          filename: 'x.dmg', sizeBytes: 0,
          url: 'https://github.com/Varun-SV/Cascade-AI/releases/download/v0.68.0/x.dmg' }],
      },
    }), 'utf8');

    const fetchImpl = vi.fn(async () => okResponse(realRelease()));
    // Nothing usable came off disk, so it falls through to a real fetch.
    expect((await new DownloadResolver(fetchImpl as unknown as typeof fetch, Date.now, { cacheFile: cacheFile() }).get())!.version).toBe('0.68.0');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('drops stored targets whose URL is not one we would redirect to', async () => {
    // The file sits on a volume, and /api/downloads hands its URLs to the page
    // as links. A stored entry gets the same trust check a fetched one does.
    fs.writeFileSync(cacheFile(), JSON.stringify({
      fetchedAt: Date.now(),
      manifest: {
        version: '9.9.9',
        releasedAt: null,
        releasesUrl: 'https://evil.example/releases',
        targets: [
          { id: 'mac-arm64', os: 'mac', label: 'macOS', detail: 'Apple silicon', filename: 'x.dmg', sizeBytes: 1, url: 'https://evil.example/x.dmg' },
          { id: 'win-x64', os: 'windows', label: 'Windows', detail: 'Installer', filename: 'y.exe', sizeBytes: 2, url: 'https://github.com/Varun-SV/Cascade-AI/releases/download/v9.9.9/y.exe' },
        ],
      },
    }), 'utf8');

    const failing = vi.fn(async () => { throw new Error('down'); });
    const manifest = await new DownloadResolver(failing as unknown as typeof fetch, Date.now, { cacheFile: cacheFile() }).get();

    expect(manifest!.targets.map((t) => t.id)).toEqual(['win-x64']);
    // releasesUrl is always ours, never whatever the file claimed.
    expect(manifest!.releasesUrl).toBe(RELEASES_PAGE_URL);
  });
});
