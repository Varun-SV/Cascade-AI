// ─────────────────────────────────────────────
//  Cascade Cloud Server — Native auth (Phase 1)
// ─────────────────────────────────────────────
//
// Broker for desktop/CLI sign-in. Two flows, both against this server so no
// OAuth client secret ever ships in a native app (see docs/native-auth.md):
//   • Loopback (desktop): browser → this server's existing web OAuth → a
//     one-time code delivered to http://127.0.0.1:<port>, redeemed with PKCE.
//   • Device code (CLI): the CLI polls while the user approves a short code on
//     an authenticated web page.
// The stores here are in-memory + self-expiring (like handoff.ts); durable
// refresh tokens live in the DB (hashed).

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const PENDING_LOOPBACK_TTL_MS = 10 * 60 * 1000; // browser round-trip
export const LOOPBACK_CODE_TTL_MS = 60 * 1000;         // one-time code → token
export const DEVICE_TTL_MS = 10 * 60 * 1000;           // user has 10 min to approve
export const DEVICE_POLL_INTERVAL_S = 5;               // min seconds between polls

// ── PKCE (RFC 7636, S256) ──────────────────────

/** base64url(SHA-256(verifier)) — the challenge the client sends up front. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Constant-time check that a verifier matches a previously-supplied challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const a = Buffer.from(pkceChallenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Codes ──────────────────────────────────────

// Unambiguous alphabet (no I/L/O/0/1) so a user_code reads cleanly off a screen.
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateUserCode(): string {
  const block = () => Array.from({ length: 4 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join('');
  return `${block()}-${block()}`;
}

/** Normalize a user_code for lookup (uppercase, strip separators). */
export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only loopback hosts may receive the code — never a public URL (SSRF/theft). */
export function isLoopbackRedirect(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
}

// ── Store ──────────────────────────────────────

interface PendingLoopback { challenge: string; redirect: string; appState: string; expiresAt: number; }
interface LoopbackCode { userId: string; challenge: string; redirect: string; expiresAt: number; }
type DeviceStatus = 'pending' | 'approved' | 'consumed';
interface DeviceRecord { userCode: string; userId?: string; status: DeviceStatus; expiresAt: number; lastPollAt: number; }

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'approved'; userId: string };

/**
 * In-memory registry of in-flight native-auth artifacts. Single-process (like
 * handoff.ts); everything self-expires and is swept on access.
 */
export class NativeAuthStore {
  private pending = new Map<string, PendingLoopback>();
  private codes = new Map<string, LoopbackCode>();
  private devices = new Map<string, DeviceRecord>();
  private userCodeIndex = new Map<string, string>(); // normalized user_code → device_code

  constructor(private now: () => number = () => Date.now()) {}

  // ── Loopback ──
  createPendingLoopback(state: string, data: { challenge: string; redirect: string; appState: string }): void {
    this.sweep();
    this.pending.set(state, { ...data, expiresAt: this.now() + PENDING_LOOPBACK_TTL_MS });
  }

  consumePendingLoopback(state: string): PendingLoopback | null {
    const rec = this.pending.get(state);
    if (!rec) return null;
    this.pending.delete(state);
    return rec.expiresAt > this.now() ? rec : null;
  }

  createLoopbackCode(data: { userId: string; challenge: string; redirect: string }): string {
    this.sweep();
    const code = opaqueToken();
    this.codes.set(code, { ...data, expiresAt: this.now() + LOOPBACK_CODE_TTL_MS });
    return code;
  }

  /** Redeem a one-time loopback code with its PKCE verifier. Single-use. */
  consumeLoopbackCode(code: string, verifier: string): { userId: string } | null {
    const rec = this.codes.get(code);
    if (!rec) return null;
    this.codes.delete(code); // one-time — remove regardless of outcome
    if (rec.expiresAt <= this.now()) return null;
    if (!verifyPkce(verifier, rec.challenge)) return null;
    return { userId: rec.userId };
  }

  // ── Device ──
  createDevice(): { deviceCode: string; userCode: string; expiresIn: number; interval: number } {
    this.sweep();
    const deviceCode = opaqueToken();
    const userCode = generateUserCode();
    this.devices.set(deviceCode, { userCode, status: 'pending', expiresAt: this.now() + DEVICE_TTL_MS, lastPollAt: 0 });
    this.userCodeIndex.set(normalizeUserCode(userCode), deviceCode);
    return { deviceCode, userCode, expiresIn: Math.floor(DEVICE_TTL_MS / 1000), interval: DEVICE_POLL_INTERVAL_S };
  }

  /** Approve a pending device by its user_code (called by an authed web user). */
  approveDevice(userCode: string, userId: string): boolean {
    const deviceCode = this.userCodeIndex.get(normalizeUserCode(userCode));
    const rec = deviceCode ? this.devices.get(deviceCode) : undefined;
    if (!rec || rec.status !== 'pending' || rec.expiresAt <= this.now()) return false;
    rec.userId = userId;
    rec.status = 'approved';
    return true;
  }

  /** CLI poll. Enforces the min interval and one-time consumption on approval. */
  pollDevice(deviceCode: string): DevicePoll {
    const rec = this.devices.get(deviceCode);
    if (!rec || rec.expiresAt <= this.now() || rec.status === 'consumed') return { status: 'expired' };
    const now = this.now();
    // lastPollAt === 0 means "never polled" — the first poll is always allowed.
    if (rec.lastPollAt > 0 && now - rec.lastPollAt < DEVICE_POLL_INTERVAL_S * 1000) { rec.lastPollAt = now; return { status: 'slow_down' }; }
    rec.lastPollAt = now;
    if (rec.status === 'approved' && rec.userId) {
      rec.status = 'consumed';
      this.userCodeIndex.delete(normalizeUserCode(rec.userCode));
      return { status: 'approved', userId: rec.userId };
    }
    return { status: 'pending' };
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= t) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt <= t) this.codes.delete(k);
    for (const [k, v] of this.devices) {
      if (v.expiresAt <= t) { this.devices.delete(k); this.userCodeIndex.delete(normalizeUserCode(v.userCode)); }
    }
  }
}

/** SHA-256 hash for storing a refresh token at rest (tokens are high-entropy). */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
