// ─────────────────────────────────────────────
//  Cascade AI — Cloud session store (native login)
// ─────────────────────────────────────────────
//
// Persists the Cascade-account tokens a native client (CLI/desktop) receives
// after signing in — the refresh token, the current short-lived access token,
// the server it belongs to, and who's signed in. Written to
// ~/.cascade-ai/cloud-session.json at 0600, next to the global provider
// credentials. Only Cascade-issued tokens live here; no OAuth provider secret
// ever does (see docs/native-auth.md).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GLOBAL_CONFIG_DIR } from '../constants.js';

export const CLOUD_SESSION_FILE = 'cloud-session.json';

export interface CloudUser {
  id: string;
  email: string | null;
  name: string | null;
  plan?: string;
}

export interface CloudSession {
  serverUrl: string;
  accessToken: string;
  /** Epoch ms when the access token expires (refresh before this). */
  accessExpiresAt: number;
  refreshToken: string;
  user: CloudUser;
}

export function globalDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, GLOBAL_CONFIG_DIR);
}

export function cloudSessionPath(dir: string = globalDir()): string {
  return path.join(dir, CLOUD_SESSION_FILE);
}

export function loadCloudSession(dir: string = globalDir()): CloudSession | null {
  try {
    const raw = fs.readFileSync(cloudSessionPath(dir), 'utf-8');
    const parsed = JSON.parse(raw) as CloudSession;
    if (!parsed?.refreshToken || !parsed?.serverUrl) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCloudSession(session: CloudSession, dir: string = globalDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = cloudSessionPath(dir);
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  // Re-assert perms in case the file pre-existed with looser bits.
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on platforms without chmod */ }
}

export function clearCloudSession(dir: string = globalDir()): void {
  try { fs.rmSync(cloudSessionPath(dir)); } catch { /* already gone */ }
}
