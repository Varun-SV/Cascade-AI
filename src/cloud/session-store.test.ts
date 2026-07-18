import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCloudSession, saveCloudSession, clearCloudSession, cloudSessionPath, type CloudSession } from './session-store.js';

const sample: CloudSession = {
  serverUrl: 'https://example.test',
  accessToken: 'access-1',
  accessExpiresAt: Date.now() + 3600_000,
  refreshToken: 'refresh-1',
  user: { id: 'u1', email: 'a@b.com', name: 'A' },
};

describe('cloud session store', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-cloud-sess-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when there is no session', () => {
    expect(loadCloudSession(dir)).toBeNull();
  });

  it('round-trips a session and writes it 0600', () => {
    saveCloudSession(sample, dir);
    expect(loadCloudSession(dir)).toEqual(sample);
    const mode = fs.statSync(cloudSessionPath(dir)).mode & 0o777;
    // Owner-only on POSIX; skip the strict check on platforms without real perms.
    if (process.platform !== 'win32') expect(mode & 0o077).toBe(0);
  });

  it('clears a session', () => {
    saveCloudSession(sample, dir);
    clearCloudSession(dir);
    expect(loadCloudSession(dir)).toBeNull();
  });

  it('treats a malformed or partial file as no session', () => {
    fs.writeFileSync(cloudSessionPath(dir), '{ not json');
    expect(loadCloudSession(dir)).toBeNull();
    fs.writeFileSync(cloudSessionPath(dir), JSON.stringify({ serverUrl: 'x' })); // no refresh token
    expect(loadCloudSession(dir)).toBeNull();
  });
});
