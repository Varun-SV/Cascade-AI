// ─────────────────────────────────────────────
//  Cascade Cloud Server — Conversation Handoff Courier
// ─────────────────────────────────────────────
//
// "Open-and-continue" session continuation between the web app and the desktop
// app. The two surfaces don't share a store — desktop runs a local backend with
// the user's own keys; the cloud keeps conversations in its own DB — so this
// module makes the cloud a SHORT-LIVED COURIER, never a shared source of truth.
//
//   1. On surface A, the user asks to continue elsewhere → we snapshot the
//      transcript and mint a short, human-typable code (15-minute TTL).
//   2. On surface B, the user enters the code → we hand back the snapshot, which
//      B seeds a fresh conversation/session from and continues locally.
//
// Snapshots live in memory only and self-expire — nothing here is durable
// storage. Codes are the bearer secret (the read endpoint is unauthenticated so
// the keyless desktop app can pick one up), so they're high-entropy and the
// records are size-capped and swept aggressively.

import { randomInt } from 'node:crypto';

export interface HandoffMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface HandoffSnapshot {
  title: string | null;
  messages: HandoffMessage[];
  /** Optional prompt-preset id carried across so the far side keeps the skill. */
  skillId: string | null;
}

interface HandoffRecord extends HandoffSnapshot {
  createdAt: number;
  expiresAt: number;
}

export const HANDOFF_TTL_MS = 15 * 60 * 1000;
const MAX_MESSAGES = 200;
const MAX_CONTENT_LEN = 20_000; // mirrors the chat:run prompt ceiling
const MAX_TOTAL_CHARS = 500_000;
const MAX_TITLE_LEN = 200;
const MAX_SKILL_ID_LEN = 64;
// Bounds memory for a courier that anyone can POST to (rate-limited too). Well
// above any realistic count of simultaneously-pending handoffs.
const MAX_RECORDS = 5_000;

// Unambiguous alphabet — no O/0, I/1/L — so a code read off one screen and typed
// on another device doesn't get transcribed wrong. 31 symbols, 8 chars ≈ 40 bits.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** Raw storage key: uppercase, alphanumerics only (dash/space/case stripped). */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Display form: `XXXX-XXXX`, easier to read aloud and type than a run of 8. */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.length === CODE_LENGTH ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * Validate + normalize an untrusted request body into a snapshot, or return a
 * user-facing error. Drops empty-content messages and caps every dimension so a
 * single POST can't balloon the in-memory store.
 */
export function parseHandoffBody(body: unknown): HandoffSnapshot | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  const rawTitle = typeof b['title'] === 'string' ? b['title'].trim().slice(0, MAX_TITLE_LEN) : '';
  const title = rawTitle ? rawTitle : null;

  const skillRaw = typeof b['skillId'] === 'string' ? b['skillId'].trim().slice(0, MAX_SKILL_ID_LEN) : '';
  const skillId = skillRaw ? skillRaw : null;

  if (!Array.isArray(b['messages'])) return { error: 'messages must be an array' };
  const rawMessages = b['messages'] as unknown[];
  if (rawMessages.length > MAX_MESSAGES) return { error: `A chat can carry at most ${MAX_MESSAGES} messages` };

  const messages: HandoffMessage[] = [];
  let total = 0;
  for (const m of rawMessages) {
    if (!m || typeof m !== 'object') continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string') continue;
    const trimmed = content.slice(0, MAX_CONTENT_LEN);
    if (!trimmed.trim()) continue; // skip blank turns (e.g. an aborted stream)
    total += trimmed.length;
    if (total > MAX_TOTAL_CHARS) return { error: 'This chat is too large to transfer' };
    messages.push({ role, content: trimmed });
  }

  if (messages.length === 0) return { error: 'Nothing to continue — this chat has no messages yet' };
  return { title, messages, skillId };
}

export class HandoffStore {
  private records = new Map<string, HandoffRecord>();

  constructor(private now: () => number = Date.now) {}

  /** Store a snapshot and return its code + expiry. Sweeps + bounds on the way in. */
  create(snapshot: HandoffSnapshot): { code: string; expiresAt: number } {
    this.sweep();
    if (this.records.size >= MAX_RECORDS) this.evictOldest();

    let key = generateCode();
    while (this.records.has(key)) key = generateCode(); // collisions are astronomically rare

    const createdAt = this.now();
    const expiresAt = createdAt + HANDOFF_TTL_MS;
    this.records.set(key, { ...snapshot, createdAt, expiresAt });
    return { code: formatCode(key), expiresAt };
  }

  /**
   * Look up a snapshot by code. Returns null for an unknown or expired code —
   * the caller can't tell the two apart, which is the point (no enumeration
   * signal). Reads are non-consuming; the TTL alone reclaims the record, so a
   * failed import on the far side can be retried with the same code.
   */
  get(code: string): (HandoffSnapshot & { expiresAt: number }) | null {
    this.sweep();
    const rec = this.records.get(normalizeCode(code));
    if (!rec || rec.expiresAt <= this.now()) return null;
    return { title: rec.title, messages: rec.messages, skillId: rec.skillId, expiresAt: rec.expiresAt };
  }

  /** Test/introspection helper — count of live (unexpired) records. */
  size(): number {
    this.sweep();
    return this.records.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [key, rec] of this.records) {
      if (rec.expiresAt <= t) this.records.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, rec] of this.records) {
      if (rec.createdAt < oldest) { oldest = rec.createdAt; oldestKey = key; }
    }
    if (oldestKey) this.records.delete(oldestKey);
  }
}
