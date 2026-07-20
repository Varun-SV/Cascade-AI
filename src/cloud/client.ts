// ─────────────────────────────────────────────
//  Cascade AI — Cloud client (native login)
// ─────────────────────────────────────────────
//
// A thin HTTP client for the Cascade cloud's native-auth + read APIs, used by
// the CLI (and later the desktop). Drives the device-code sign-in, keeps the
// short-lived access token fresh via the stored refresh token, and reads the
// user's cloud chats. Only talks to the Cascade server — never to an OAuth
// provider directly.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import {
  type CloudSession, type CloudUser, loadCloudSession, saveCloudSession, clearCloudSession,
} from './session-store.js';

export const DEFAULT_CLOUD_URL = 'https://app.cascadeai.in';
/** Providers the loopback flow can start (must match the server's `/auth/native/:provider`). */
export type NativeProvider = 'google' | 'github';
/** Refresh the access token when it's within this window of expiring. */
const REFRESH_MARGIN_MS = 60_000;

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface CloudConversation {
  id: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CloudMessage {
  role: string;
  content: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export type DevicePollResult = 'pending' | 'slow_down' | 'expired' | { session: CloudSession };

/**
 * Where the signed-in session persists. The CLI uses the default file store
 * (`~/.cascade-ai/cloud-session.json`, 0600); the desktop injects a
 * `safeStorage`-backed one. Kept tiny so any host can implement it.
 */
export interface CloudSessionStore {
  load(): CloudSession | null;
  save(session: CloudSession): void;
  clear(): void;
}

/** Default store: the 0600 JSON file next to the global provider credentials. */
class FileCloudSessionStore implements CloudSessionStore {
  constructor(private readonly dir?: string) {}
  load(): CloudSession | null { return loadCloudSession(this.dir); }
  save(session: CloudSession): void { saveCloudSession(session, this.dir); }
  clear(): void { clearCloudSession(this.dir); }
}

export class CloudClient {
  private readonly store: CloudSessionStore;

  constructor(
    private readonly serverUrl: string,
    dir?: string,
    store?: CloudSessionStore,
  ) {
    this.store = store ?? new FileCloudSessionStore(dir);
  }

  /** Build a client from a stored session, or null if not signed in. */
  static fromSession(dir?: string, store?: CloudSessionStore): CloudClient | null {
    const src = store ?? new FileCloudSessionStore(dir);
    const s = src.load();
    return s ? new CloudClient(s.serverUrl, dir, src) : null;
  }

  private url(p: string): string {
    return `${this.serverUrl.replace(/\/$/, '')}${p}`;
  }

  // ── Device login ──────────────────────────────

  async startDevice(): Promise<DeviceStart> {
    const res = await fetch(this.url('/api/native/device'), { method: 'POST' });
    if (!res.ok) throw new Error(`Could not start sign-in (${res.status}).`);
    const b = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
    return { deviceCode: b.device_code, userCode: b.user_code, verificationUri: b.verification_uri, expiresIn: b.expires_in, interval: b.interval };
  }

  /** Single poll of the device grant. On approval, persists + returns the session. */
  async pollDevice(deviceCode: string): Promise<DevicePollResult> {
    const res = await fetch(this.url('/api/native/device/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    if (res.status === 428) return 'pending';
    if (res.status === 429) return 'slow_down';
    if (!res.ok) return 'expired';
    const tokens = (await res.json()) as TokenResponse;
    const session = await this.finishLogin(tokens);
    return { session };
  }

  /**
   * Run the full device flow: start it, hand the code to `onCode`, then poll at
   * the server's interval until approved or expired.
   */
  async runDeviceLogin(onCode: (d: DeviceStart) => void, opts: { signal?: AbortSignal } = {}): Promise<CloudSession> {
    const start = await this.startDevice();
    onCode(start);
    let interval = start.interval;
    const deadline = Date.now() + start.expiresIn * 1000;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('Sign-in cancelled.');
      await sleep(interval * 1000, opts.signal);
      const r = await this.pollDevice(start.deviceCode);
      if (r === 'slow_down') { interval += 5; continue; }
      if (r === 'pending') continue;
      if (r === 'expired') throw new Error('The sign-in code expired. Run `cascade login` again.');
      return r.session;
    }
    throw new Error('The sign-in code expired. Run `cascade login` again.');
  }

  // ── Loopback login (desktop) — RFC 8252 ───────

  /**
   * Run the loopback flow for a rich native client (the desktop). Opens a
   * one-shot listener on `http://127.0.0.1:<random>`, sends the user to the
   * provider in the system browser via `openUrl`, catches the one-time code on
   * the loopback redirect, and exchanges it (+ the PKCE verifier) for tokens.
   *
   * No secret is involved: PKCE S256 proves the client that started the flow is
   * the one redeeming the code. Storage-agnostic — persists through the same
   * session store as the device flow, so callers get a ready `CloudSession`.
   */
  async runLoopbackLogin(
    openUrl: (url: string) => void | Promise<void>,
    opts: { provider?: NativeProvider; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<CloudSession> {
    const provider = opts.provider ?? 'google';
    const { verifier, challenge } = makePkce();
    const appState = base64url(randomBytes(16));
    const listener = await startLoopbackListener(appState, opts);
    try {
      const authorizeUrl = this.url(
        `/auth/native/${encodeURIComponent(provider)}`
        + `?redirect_uri=${encodeURIComponent(listener.redirectUri)}`
        + `&code_challenge=${encodeURIComponent(challenge)}`
        + `&state=${encodeURIComponent(appState)}`,
      );
      await openUrl(authorizeUrl);
      const code = await listener.waitForCode;
      const res = await fetch(this.url('/api/native/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier }),
      });
      if (!res.ok) throw new Error('Sign-in could not be completed. Please try again.');
      const tokens = (await res.json()) as TokenResponse;
      return await this.finishLogin(tokens);
    } finally {
      listener.close();
    }
  }

  /** Exchange a fresh token response for a stored session (fetches the user). */
  private async finishLogin(tokens: TokenResponse): Promise<CloudSession> {
    const partial: CloudSession = {
      serverUrl: this.serverUrl,
      accessToken: tokens.access_token,
      accessExpiresAt: Date.now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token,
      user: { id: '', email: null, name: null },
    };
    const user = await this.fetchMe(partial.accessToken);
    const session = { ...partial, user };
    this.store.save(session);
    return session;
  }

  // ── Token lifecycle ───────────────────────────

  private session(): CloudSession {
    const s = this.store.load();
    if (!s) throw new Error('Not signed in. Run `cascade login`.');
    return s;
  }

  private async refresh(): Promise<CloudSession> {
    const s = this.session();
    const res = await fetch(this.url('/api/native/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refreshToken }),
    });
    if (!res.ok) {
      this.store.clear(); // refresh rejected → sign-in is dead
      throw new Error('Your session expired. Run `cascade login` again.');
    }
    const tokens = (await res.json()) as TokenResponse;
    const next: CloudSession = {
      ...s,
      accessToken: tokens.access_token,
      accessExpiresAt: Date.now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token, // rotated
    };
    this.store.save(next);
    return next;
  }

  private async accessToken(): Promise<string> {
    const s = this.session();
    if (s.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return s.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Authenticated GET that refreshes once on a 401 (e.g. server-side revoke). */
  private async authedGet<T>(path: string): Promise<T> {
    let token = await this.accessToken();
    let res = await fetch(this.url(path), { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      token = (await this.refresh()).accessToken;
      res = await fetch(this.url(path), { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!res.ok) throw new Error(`Request failed (${res.status}).`);
    return (await res.json()) as T;
  }

  private async fetchMe(token: string): Promise<CloudUser> {
    const res = await fetch(this.url('/api/me'), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Could not load your account (${res.status}).`);
    const b = (await res.json()) as { user?: CloudUser };
    return b.user ?? { id: '', email: null, name: null };
  }

  // ── Read API ──────────────────────────────────

  async me(): Promise<CloudUser> {
    const b = await this.authedGet<{ user?: CloudUser }>('/api/me');
    return b.user ?? { id: '', email: null, name: null };
  }

  async listConversations(): Promise<CloudConversation[]> {
    const b = await this.authedGet<{ conversations: CloudConversation[] }>('/api/conversations');
    return b.conversations ?? [];
  }

  async getMessages(conversationId: string): Promise<CloudMessage[]> {
    const b = await this.authedGet<{ messages: CloudMessage[] }>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);
    return b.messages ?? [];
  }

  async logout(): Promise<void> {
    const s = this.store.load();
    if (s) {
      try {
        await fetch(this.url('/api/native/logout'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: s.refreshToken }),
        });
      } catch { /* revoke is best-effort; we still clear locally */ }
    }
    this.store.clear();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

// ── PKCE (RFC 7636, S256) ───────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh PKCE verifier + its S256 challenge (the shape the server verifies). */
function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── Loopback listener (RFC 8252) ────────────────

interface LoopbackListener {
  /** The `http://127.0.0.1:<port>/cb` the browser is 302'd back to. */
  redirectUri: string;
  /** Resolves with the one-time code once the browser hits `/cb`. */
  waitForCode: Promise<string>;
  /** Idempotently stop the listener. */
  close: () => void;
}

/**
 * Bind a single-use HTTP listener on a random loopback port. It answers only
 * `/cb`, validating the echoed `state` before resolving the one-time code, and
 * shows the user a small "you can close this tab" page either way.
 */
function startLoopbackListener(
  expectedState: string,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<LoopbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const waitForCode = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

    let server: http.Server;
    const close = () => { try { server?.close(); } catch { /* already closed */ } };

    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const timer = setTimeout(() => { rejectCode(new Error('Sign-in timed out. Please try again.')); close(); }, timeoutMs);
    timer.unref?.();
    const settleCode = (code: string) => { clearTimeout(timer); resolveCode(code); };
    const failCode = (err: Error) => { clearTimeout(timer); rejectCode(err); };

    server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/cb') { res.writeHead(404).end(); return; }
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const err = reqUrl.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err || !code || state !== expectedState) {
        res.end(resultPage('Sign-in failed', 'Something went wrong. Return to Cascade and try again.'));
        failCode(new Error(err ? `Sign-in failed: ${err}` : 'The sign-in response was invalid.'));
        return;
      }
      res.end(resultPage('Signed in to Cascade', 'You can close this tab and return to the app.'));
      settleCode(code);
    });

    opts.signal?.addEventListener('abort', () => { failCode(new Error('Sign-in cancelled.')); close(); }, { once: true });
    server.on('error', (e) => { clearTimeout(timer); rejectListener(e); });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveListener({ redirectUri: `http://127.0.0.1:${port}/cb`, waitForCode, close });
    });
  });
}

/** Minimal self-contained page shown in the browser after the redirect. */
function resultPage(title: string, body: string): string {
  return '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title} · Cascade</title>`
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e6e8ee">'
    + '<div style="text-align:center;padding:40px">'
    + `<div style="font-size:15px;font-weight:600;margin-bottom:8px">${title}</div>`
    + `<div style="font-size:13px;color:#9aa3b2">${body}</div></div></body>`;
}
