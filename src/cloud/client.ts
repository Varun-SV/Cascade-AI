// ─────────────────────────────────────────────
//  Cascade AI — Cloud client (native login)
// ─────────────────────────────────────────────
//
// A thin HTTP client for the Cascade cloud's native-auth + read APIs, used by
// the CLI (and later the desktop). Drives the device-code sign-in, keeps the
// short-lived access token fresh via the stored refresh token, and reads the
// user's cloud chats. Only talks to the Cascade server — never to an OAuth
// provider directly.

import {
  type CloudSession, type CloudUser, loadCloudSession, saveCloudSession, clearCloudSession,
} from './session-store.js';

export const DEFAULT_CLOUD_URL = 'https://app.cascadeai.in';
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

export class CloudClient {
  constructor(
    private readonly serverUrl: string,
    private readonly dir?: string,
  ) {}

  /** Build a client from a stored session, or null if not signed in. */
  static fromSession(dir?: string): CloudClient | null {
    const s = loadCloudSession(dir);
    return s ? new CloudClient(s.serverUrl, dir) : null;
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
    saveCloudSession(session, this.dir);
    return session;
  }

  // ── Token lifecycle ───────────────────────────

  private session(): CloudSession {
    const s = loadCloudSession(this.dir);
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
      clearCloudSession(this.dir); // refresh rejected → sign-in is dead
      throw new Error('Your session expired. Run `cascade login` again.');
    }
    const tokens = (await res.json()) as TokenResponse;
    const next: CloudSession = {
      ...s,
      accessToken: tokens.access_token,
      accessExpiresAt: Date.now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token, // rotated
    };
    saveCloudSession(next, this.dir);
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
    const s = loadCloudSession(this.dir);
    if (s) {
      try {
        await fetch(this.url('/api/native/logout'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: s.refreshToken }),
        });
      } catch { /* revoke is best-effort; we still clear locally */ }
    }
    clearCloudSession(this.dir);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}
