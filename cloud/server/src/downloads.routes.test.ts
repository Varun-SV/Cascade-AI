import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './app.js';
import { CloudStore } from './db.js';
import { DownloadResolver } from './downloads.js';
import type { CloudEnv } from './env.js';

/**
 * The two public download routes, end to end over real HTTP.
 *
 * The resolver is injected with a stub fetch so the suite never touches
 * GitHub's API — which would be slow, flaky, and spend a rate limit shared with
 * everything else running from the same IP.
 */

const RELEASE = {
  tag_name: 'v0.68.0',
  published_at: '2026-08-04T06:16:17Z',
  assets: [
    { name: 'Cascade-AI-0.68.0-arm64.dmg', size: 151237300, browser_download_url: 'https://github.com/Varun-SV/Cascade-AI/releases/download/v0.68.0/Cascade-AI-0.68.0-arm64.dmg' },
    { name: 'Cascade-AI-Setup-0.68.0.exe', size: 127347976, browser_download_url: 'https://github.com/Varun-SV/Cascade-AI/releases/download/v0.68.0/Cascade-AI-Setup-0.68.0.exe' },
    { name: 'latest.yml', size: 352, browser_download_url: 'https://github.com/Varun-SV/Cascade-AI/releases/download/v0.68.0/latest.yml' },
  ],
};

const env: CloudEnv = {
  PORT: 0,
  SESSION_SECRET: 'test-session-secret-value',
  DATA_DIR: './data',
  WEB_ORIGIN: 'http://localhost:5173',
  OAUTH_REDIRECT_BASE_URL: 'http://localhost:8787',
  GITHUB_CLIENT_ID: undefined,
  GITHUB_CLIENT_SECRET: undefined,
  GOOGLE_CLIENT_ID: undefined,
  GOOGLE_CLIENT_SECRET: undefined,
  CLOUD_DEV_BYPASS: true,
  MAX_COST_PER_RUN_USD: 0.5,
};

describe('download routes', () => {
  let dir: string;
  let store: CloudStore;
  let server: http.Server;
  let baseUrl: string;

  async function start(fetchImpl: typeof fetch) {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-downloads-'));
    env.DATA_DIR = dir;
    store = new CloudStore(path.join(dir, 'cloud.db'));
    const app = createApp(env, store, { downloads: new DownloadResolver(fetchImpl) });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const okFetch = (async () => ({ ok: true, json: async () => RELEASE })) as unknown as typeof fetch;
  const deadFetch = (async () => { throw new Error('github is down'); }) as unknown as typeof fetch;

  beforeEach(() => { vi.clearAllMocks(); });

  afterEach(async () => {
    store?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('GET /api/downloads returns only the installables', async () => {
    await start(okFetch);
    const res = await fetch(`${baseUrl}/api/downloads`);
    expect(res.status).toBe(200);

    const body = await res.json() as { version: string; targets: { id: string }[] };
    expect(body.version).toBe('0.68.0');
    // latest.yml is updater metadata and must never be offered as a download.
    expect(body.targets.map((t) => t.id)).toEqual(['mac-arm64', 'win-x64']);
  });

  it('GET /download/:target redirects to the release asset', async () => {
    await start(okFetch);
    const res = await fetch(`${baseUrl}/download/mac-arm64`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://github.com/Varun-SV/Cascade-AI/releases/download/v0.68.0/Cascade-AI-0.68.0-arm64.dmg',
    );
    // The target is stable but what it points at changes every release, so a
    // cached 302 would keep installing the old version.
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('sends an unknown or hostile target to the section rather than resolving it', async () => {
    await start(okFetch);
    for (const target of ['nonsense', '..%2F..%2Fetc%2Fpasswd', 'MAC-ARM64']) {
      const res = await fetch(`${baseUrl}/download/${target}`, { redirect: 'manual' });
      expect(res.status, target).toBe(302);
      expect(res.headers.get('location'), target).toBe('/#download');
    }
  });

  it('falls back to the releases page for a build this release does not carry', async () => {
    await start(okFetch);
    // linux-deb is a real target id, but the stub release has no .deb asset.
    const res = await fetch(`${baseUrl}/download/linux-deb`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.com/Varun-SV/Cascade-AI/releases/latest');
  });

  it('answers 503 with a usable fallback link when the release cannot be resolved', async () => {
    await start(deadFetch);
    const res = await fetch(`${baseUrl}/api/downloads`);
    expect(res.status).toBe(503);
    expect((await res.json() as { releasesUrl: string }).releasesUrl)
      .toBe('https://github.com/Varun-SV/Cascade-AI/releases/latest');
  });

  it('redirects a download to GitHub rather than dead-ending when the API is down', async () => {
    await start(deadFetch);
    const res = await fetch(`${baseUrl}/download/win-x64`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.com/Varun-SV/Cascade-AI/releases/latest');
  });

  it('sends bare /download to the section that explains the choices', async () => {
    await start(okFetch);
    const res = await fetch(`${baseUrl}/download`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/#download');
  });

  it('does not let the SPA catch-all swallow the download routes', async () => {
    await start(okFetch);

    // First prove the catch-all is actually live in this run — otherwise the
    // assertion below passes for the wrong reason (no catch-all registered
    // because cloud/web was never built) and would never catch the regression
    // it exists for.
    const spa = await fetch(`${baseUrl}/some/app/route`, { redirect: 'manual' });
    if (spa.status !== 200) return; // cloud/web not built here; nothing to order against.

    // Registered before it, so a download link redirects instead of silently
    // rendering the app shell with a 200.
    const res = await fetch(`${baseUrl}/download/win-x64`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('Cascade-AI-Setup-0.68.0.exe');
  });
});
