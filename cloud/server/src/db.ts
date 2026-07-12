// ─────────────────────────────────────────────
//  Cascade Cloud Server — SQLite Store
// ─────────────────────────────────────────────
//
// Per-tenant data lives here (users, conversations, messages, usage). This
// is intentionally separate from ~/.cascade-ai/* — that store is
// machine-global and single-tenant by design (see src/config/global-credentials.ts);
// a hosted multi-tenant server must never read or write it.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export type OAuthProvider = 'github' | 'google' | 'dev';

export interface CloudUser {
  id: string;
  provider: OAuthProvider;
  providerId: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  plan: string;
  createdAt: number;
}

export interface CloudConversation {
  id: string;
  userId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CloudMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  model: string | null;
  costUsd: number | null;
  createdAt: number;
}

interface DbUserRow {
  id: string;
  provider: string;
  provider_id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  plan: string;
  created_at: number;
}

interface DbConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

interface DbMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  cost_usd: number | null;
  created_at: number;
}

export class CloudStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { timeout: 5000 });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        email TEXT,
        name TEXT,
        avatar TEXT,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at INTEGER NOT NULL,
        UNIQUE(provider, provider_id)
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        cost_usd REAL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

      CREATE TABLE IF NOT EXISTS usage (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        runs INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, date)
      );
    `);
  }

  // ── Users ─────────────────────────────────────

  upsertUser(input: {
    provider: OAuthProvider;
    providerId: string;
    email: string | null;
    name: string | null;
    avatar: string | null;
  }): CloudUser {
    const existing = this.db
      .prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?')
      .get(input.provider, input.providerId) as DbUserRow | undefined;

    if (existing) {
      this.db
        .prepare('UPDATE users SET email = ?, name = ?, avatar = ? WHERE id = ?')
        .run(input.email, input.name, input.avatar, existing.id);
      return this.deserializeUser({ ...existing, email: input.email, name: input.name, avatar: input.avatar });
    }

    const row: DbUserRow = {
      id: randomUUID(),
      provider: input.provider,
      provider_id: input.providerId,
      email: input.email,
      name: input.name,
      avatar: input.avatar,
      plan: 'free',
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO users (id, provider, provider_id, email, name, avatar, plan, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.provider, row.provider_id, row.email, row.name, row.avatar, row.plan, row.created_at);
    return this.deserializeUser(row);
  }

  getUserById(id: string): CloudUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUserRow | undefined;
    return row ? this.deserializeUser(row) : null;
  }

  // ── Conversations ─────────────────────────────

  createConversation(userId: string, title: string | null = null): CloudConversation {
    const now = Date.now();
    const row: DbConversationRow = { id: randomUUID(), user_id: userId, title, created_at: now, updated_at: now };
    this.db
      .prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.title, row.created_at, row.updated_at);
    return this.deserializeConversation(row);
  }

  listConversations(userId: string, limit = 50): CloudConversation[] {
    // Tie-break on rowid: two conversations created in the same millisecond
    // otherwise sort in an unspecified (SQLite-internal) order instead of
    // most-recently-created-first.
    const rows = this.db
      .prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?')
      .all(userId, limit) as DbConversationRow[];
    return rows.map((r) => this.deserializeConversation(r));
  }

  getConversation(id: string, userId: string): CloudConversation | null {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(id, userId) as DbConversationRow | undefined;
    return row ? this.deserializeConversation(row) : null;
  }

  touchConversation(id: string): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // ── Messages ──────────────────────────────────

  addMessage(input: {
    conversationId: string;
    role: string;
    content: string;
    model?: string | null;
    costUsd?: number | null;
  }): CloudMessage {
    const row: DbMessageRow = {
      id: randomUUID(),
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      model: input.model ?? null,
      cost_usd: input.costUsd ?? null,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, model, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.conversation_id, row.role, row.content, row.model, row.cost_usd, row.created_at);
    this.touchConversation(input.conversationId);
    return this.deserializeMessage(row);
  }

  getMessages(conversationId: string): CloudMessage[] {
    // Tie-break on rowid for the same reason as listConversations — messages
    // can be persisted faster than the millisecond clock advances.
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(conversationId) as DbMessageRow[];
    return rows.map((r) => this.deserializeMessage(r));
  }

  // ── Usage / entitlements ──────────────────────

  incrementUsage(userId: string, date: string): number {
    this.db
      .prepare(
        `INSERT INTO usage (user_id, date, runs) VALUES (?, ?, 1)
         ON CONFLICT(user_id, date) DO UPDATE SET runs = runs + 1`,
      )
      .run(userId, date);
    const row = this.db.prepare('SELECT runs FROM usage WHERE user_id = ? AND date = ?').get(userId, date) as
      | { runs: number }
      | undefined;
    return row?.runs ?? 0;
  }

  getUsage(userId: string, date: string): number {
    const row = this.db.prepare('SELECT runs FROM usage WHERE user_id = ? AND date = ?').get(userId, date) as
      | { runs: number }
      | undefined;
    return row?.runs ?? 0;
  }

  // ── Deserializers ─────────────────────────────

  private deserializeUser(row: DbUserRow): CloudUser {
    return {
      id: row.id,
      provider: row.provider as OAuthProvider,
      providerId: row.provider_id,
      email: row.email,
      name: row.name,
      avatar: row.avatar,
      plan: row.plan,
      createdAt: row.created_at,
    };
  }

  private deserializeConversation(row: DbConversationRow): CloudConversation {
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private deserializeMessage(row: DbMessageRow): CloudMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      model: row.model,
      costUsd: row.cost_usd,
      createdAt: row.created_at,
    };
  }
}
