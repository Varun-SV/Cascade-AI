// ─────────────────────────────────────────────
//  Cascade Desktop — Cloud account (native sign-in)
// ─────────────────────────────────────────────
//
// Optional sign-in to Cascade Cloud from the desktop, so a user can browse and
// continue the chats they started on the web. Uses the shared `CloudClient`
// (from the Cascade core bundle) to run the RFC 8252 loopback OAuth flow — the
// system browser handles the provider login, a one-time code lands on a local
// 127.0.0.1 listener, and PKCE (not a secret) proves this client. No OAuth
// provider secret or token ever touches the desktop; only the Cascade-issued
// access + refresh tokens are stored, and those are encrypted at rest.
//
// Storage: Electron `safeStorage` (OS keychain / DPAPI) when available; a local
// AES-256-GCM key file (0600) as a fallback on machines without a keyring
// (e.g. Linux without libsecret). See docs/native-auth.md.

import { app, ipcMain, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// ── Shapes shared with the renderer (mirror the SDK's cloud types) ──

interface StoredUser { id: string; email: string | null; name: string | null; plan?: string }

interface CloudSession {
  serverUrl: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  user: StoredUser;
}

interface SessionStore {
  load(): CloudSession | null;
  save(session: CloudSession): void;
  clear(): void;
}

interface EncBlob { ciphertext: string; salt: string; iv: string }

interface CloudClientLike {
  runLoopbackLogin(
    openUrl: (url: string) => void | Promise<void>,
    opts: { provider?: 'google' | 'github'; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CloudSession>;
  listConversations(): Promise<Array<{ id: string; title: string; updatedAt?: number }>>;
  getMessages(id: string): Promise<Array<{ role: string; content: string }>>;
  pullSecrets(): Promise<{ blob: EncBlob | null; version?: number; updatedAt?: number }>;
  pushSecrets(blob: EncBlob): Promise<{ version: number; updatedAt: number }>;
  logout(): Promise<void>;
}

type CloudClientCtor = new (serverUrl: string, dir?: string, store?: SessionStore) => CloudClientLike;

// The subset of the Cascade core bundle this module uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfg = any;
interface McpFileStore { clear(): void }
interface CoreExports {
  CloudClient: CloudClientCtor;
  DEFAULT_CLOUD_URL: string;
  gatherSyncBundle: (config: Cfg) => unknown;
  applySyncBundle: (bundle: unknown, config: Cfg) => Cfg;
  encryptSyncBlob: (data: unknown, passphrase: string) => Promise<EncBlob>;
  decryptSyncBlob: (blob: EncBlob, passphrase: string) => Promise<unknown>;
  connectMcpWithLoopbackOAuth: (opts: { serverUrl: string; store: McpFileStore; openUrl: (u: string) => void; clientName?: string }) => Promise<unknown>;
  FileMcpOAuthStore: new (path: string) => McpFileStore;
}

/** Live config access, so a pulled bundle takes effect without a backend restart. */
export interface ConfigHooks {
  getConfig: () => Cfg | null;
  persistConfig: () => Promise<void>;
}

type StorageMode = 'keychain' | 'encrypted-file';

/** Envelope written to disk — never contains plaintext tokens. */
interface Envelope { mode: 'safeStorage' | 'aesgcm'; blob: string; iv?: string; tag?: string }

// ── Encrypted-at-rest session store ─────────────

class SafeStorageSessionStore implements SessionStore {
  private file(): string { return join(app.getPath('userData'), 'cloud-session.enc'); }
  private keyFile(): string { return join(app.getPath('userData'), 'cloud-session.key'); }

  /** How the session is protected right now — surfaced to the user honestly. */
  storageMode(): StorageMode {
    return safeStorage.isEncryptionAvailable() ? 'keychain' : 'encrypted-file';
  }

  load(): CloudSession | null {
    try {
      const env = JSON.parse(readFileSync(this.file(), 'utf-8')) as Envelope;
      let json: string;
      if (env.mode === 'safeStorage') {
        json = safeStorage.decryptString(Buffer.from(env.blob, 'base64'));
      } else {
        const key = readFileSync(this.keyFile());
        const dec = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv ?? '', 'base64'));
        dec.setAuthTag(Buffer.from(env.tag ?? '', 'base64'));
        json = Buffer.concat([dec.update(Buffer.from(env.blob, 'base64')), dec.final()]).toString('utf-8');
      }
      const parsed = JSON.parse(json) as CloudSession;
      if (!parsed?.refreshToken || !parsed?.serverUrl) return null;
      return parsed;
    } catch {
      return null; // no session, unreadable, or tampered
    }
  }

  save(session: CloudSession): void {
    mkdirSync(app.getPath('userData'), { recursive: true });
    const json = JSON.stringify(session);
    let env: Envelope;
    if (safeStorage.isEncryptionAvailable()) {
      env = { mode: 'safeStorage', blob: safeStorage.encryptString(json).toString('base64') };
    } else {
      const key = this.ensureKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const blob = Buffer.concat([cipher.update(json, 'utf-8'), cipher.final()]);
      env = { mode: 'aesgcm', blob: blob.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    }
    this.writeSecure(this.file(), Buffer.from(JSON.stringify(env), 'utf-8'));
  }

  clear(): void {
    try { rmSync(this.file()); } catch { /* already gone */ }
  }

  /** A stable 32-byte key for the fallback path (created once, 0600). */
  private ensureKey(): Buffer {
    try {
      const k = readFileSync(this.keyFile());
      if (k.length === 32) return k;
    } catch { /* create below */ }
    const key = randomBytes(32);
    this.writeSecure(this.keyFile(), key);
    return key;
  }

  private writeSecure(path: string, data: Buffer): void {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(path, data, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* non-POSIX filesystem */ }
  }
}

// ── IPC wiring ──────────────────────────────────

/**
 * Register the `cloud:*` IPC handlers. `loadCore` returns the Cascade core
 * bundle (same loader `main.ts` uses for the backend), from which we pull the
 * shared `CloudClient` and default cloud URL.
 */
export function registerCloudAuthIpc(loadCore: () => unknown, hooks: ConfigHooks): void {
  const store = new SafeStorageSessionStore();
  const core = () => loadCore() as CoreExports;
  const serverUrl = (process.env['CASCADE_CLOUD_URL'] || '').trim().replace(/\/$/, '') || core().DEFAULT_CLOUD_URL;
  const client = (): CloudClientLike => new (core().CloudClient)(serverUrl, undefined, store);

  let loginAbort: AbortController | null = null;

  const status = () => {
    const s = store.load();
    return { signedIn: !!s, user: s?.user ?? null, serverUrl, storage: store.storageMode() };
  };

  ipcMain.handle('cloud:status', () => status());

  ipcMain.handle('cloud:login', async (_e, provider: unknown) => {
    loginAbort?.abort(); // a fresh attempt supersedes any in-flight one
    loginAbort = new AbortController();
    const p: 'google' | 'github' = provider === 'github' ? 'github' : 'google';
    try {
      await client().runLoopbackLogin((url) => { void shell.openExternal(url); }, { provider: p, signal: loginAbort.signal });
      return { ok: true, ...status() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Sign-in failed.' };
    } finally {
      loginAbort = null;
    }
  });

  ipcMain.handle('cloud:cancelLogin', () => { loginAbort?.abort(); return { ok: true }; });

  ipcMain.handle('cloud:logout', async () => {
    try { await client().logout(); } catch { /* revoke is best-effort; local state still clears */ }
    return { ok: true, ...status() };
  });

  ipcMain.handle('cloud:sessions', async () => {
    try { return { ok: true, conversations: await client().listConversations() }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Could not load your cloud chats.', conversations: [] }; }
  });

  ipcMain.handle('cloud:messages', async (_e, id: unknown) => {
    try { return { ok: true, messages: await client().getMessages(String(id)) }; }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Could not load that chat.', messages: [] }; }
  });

  // ── Key sync (E2E-encrypted settings) ──

  ipcMain.handle('cloud:syncPush', async (_e, passphrase: unknown) => {
    const pass = String(passphrase ?? '');
    const cfg = hooks.getConfig();
    if (!cfg) return { ok: false, error: 'Your settings are not ready yet.' };
    if (!pass) return { ok: false, error: 'Enter a passphrase.' };
    try {
      const { gatherSyncBundle, encryptSyncBlob } = core();
      const blob = await encryptSyncBlob(gatherSyncBundle(cfg), pass);
      const r = await client().pushSecrets(blob);
      return { ok: true, version: r.version };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Sync failed.' };
    }
  });

  ipcMain.handle('cloud:syncPull', async (_e, passphrase: unknown) => {
    const pass = String(passphrase ?? '');
    const cfg = hooks.getConfig();
    if (!cfg) return { ok: false, error: 'Your settings are not ready yet.' };
    if (!pass) return { ok: false, error: 'Enter a passphrase.' };
    let blob: EncBlob | null;
    try {
      ({ blob } = await client().pullSecrets());
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not reach your account.' };
    }
    if (!blob) return { ok: true, empty: true };
    try {
      const { decryptSyncBlob, applySyncBundle } = core();
      const bundle = await decryptSyncBlob(blob, pass);
      const merged = applySyncBundle(bundle, cfg);
      // Apply onto the live config object in place so the running backend picks
      // it up without a restart (mirrors cascade:updateSettings), then persist.
      cfg.providers = merged.providers;
      if (merged.tools) {
        cfg.tools = cfg.tools ?? {};
        cfg.tools.webSearch = merged.tools.webSearch;
        cfg.tools.mcpServers = merged.tools.mcpServers;
      }
      cfg.models = merged.models;
      cfg.budget = merged.budget;
      cfg.autoBias = merged.autoBias;
      cfg.cascadeAuto = merged.cascadeAuto;
      cfg.extendedContext = merged.extendedContext;
      cfg.autonomy = merged.autonomy;
      await hooks.persistConfig();
      return { ok: true, applied: true };
    } catch {
      // AES-GCM's auth-tag check is what fails on a wrong passphrase.
      return { ok: false, error: 'Could not decrypt — check your passphrase.' };
    }
  });

  // ── MCP servers (OAuth connect) ──

  const safeName = (name: string) => name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 64) || 'server';
  const hostnameOf = (url: string) => { try { return new URL(url).hostname; } catch { return 'mcp-server'; } };

  ipcMain.handle('mcp:list', () => {
    const cfg = hooks.getConfig();
    const servers = (cfg?.tools?.mcpServers ?? []) as Array<{ name: string; url?: string; command?: string; headers?: unknown; oauthStore?: string }>;
    return {
      servers: servers.map((s) => ({
        name: s.name,
        target: s.url ?? s.command ?? '',
        kind: s.oauthStore ? 'oauth' : s.headers ? 'token' : s.command ? 'local' : 'open',
      })),
    };
  });

  ipcMain.handle('mcp:connectOAuth', async (_e, arg: unknown) => {
    const a = (arg ?? {}) as { url?: string; name?: string };
    const url = String(a.url ?? '').trim();
    const name = String(a.name ?? '').trim() || hostnameOf(url);
    if (!/^https:\/\//i.test(url)) return { ok: false, error: 'Enter an https MCP server URL.' };
    const cfg = hooks.getConfig();
    if (!cfg) return { ok: false, error: 'Your settings are not ready yet.' };
    const { connectMcpWithLoopbackOAuth, FileMcpOAuthStore } = core();
    const storePath = join(app.getPath('userData'), 'mcp-oauth', `${safeName(name)}.json`);
    try {
      await connectMcpWithLoopbackOAuth({
        serverUrl: url,
        store: new FileMcpOAuthStore(storePath),
        clientName: 'Cascade AI',
        openUrl: (u) => { void shell.openExternal(u); },
      });
      cfg.tools = cfg.tools ?? {};
      const servers = (cfg.tools.mcpServers ?? []) as Array<{ name: string }>;
      const entry = { name, url, oauthStore: storePath };
      const idx = servers.findIndex((s) => s.name === name);
      if (idx >= 0) servers[idx] = entry; else servers.push(entry);
      cfg.tools.mcpServers = servers;
      cfg.tools.mcpTrusted = Array.from(new Set([...(cfg.tools.mcpTrusted ?? []), name]));
      await hooks.persistConfig();
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not connect.' };
    }
  });

  ipcMain.handle('mcp:remove', async (_e, name: unknown) => {
    const cfg = hooks.getConfig();
    const n = String(name ?? '');
    if (cfg?.tools?.mcpServers) {
      const match = (cfg.tools.mcpServers as Array<{ name: string; oauthStore?: string }>).find((s) => s.name === n);
      cfg.tools.mcpServers = (cfg.tools.mcpServers as Array<{ name: string }>).filter((s) => s.name !== n);
      cfg.tools.mcpTrusted = (cfg.tools.mcpTrusted ?? []).filter((x: string) => x !== n);
      if (match?.oauthStore) { try { new (core().FileMcpOAuthStore)(match.oauthStore).clear(); } catch { /* gone */ } }
      await hooks.persistConfig();
    }
    return { ok: true };
  });
}
