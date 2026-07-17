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
  /** Razorpay subscription id backing a paid plan, or null. */
  subscriptionId: string | null;
  /** Razorpay subscription status (active/cancelled/…), or null. */
  subscriptionStatus: string | null;
  /** Unix seconds — end of the current billing period, or null. */
  subscriptionCurrentEnd: number | null;
  createdAt: number;
}

export interface CloudConversation {
  id: string;
  userId: string;
  title: string | null;
  skillId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CloudMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  model: string | null;
  /** Tier that produced this assistant message: 'T1' | 'T2' | 'T3'. */
  tier: string | null;
  /** JSON-encoded run-explorer report (decisions, savings, per-tier cost). */
  why: string | null;
  costUsd: number | null;
  createdAt: number;
}

export interface CloudMemory {
  id: string;
  userId: string;
  content: string;
  /** Optional user-assigned bucket (e.g. STACK / STYLE / PROJECT). */
  category: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CloudSkill {
  id: string;
  userId: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** How many runs have used this skill (drives the "used N×" badge). */
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface CloudAttachment {
  id: string;
  userId: string;
  messageId: string | null;
  kind: string; // 'image' | 'document'
  mime: string;
  path: string;
  /** Original upload filename (documents) — shown as a chip in the transcript. */
  filename: string | null;
  /** Extracted-text length for documents (0/null for images). Lets the client
   *  show "12k chars" without shipping the whole extracted body. */
  charCount: number | null;
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
  subscription_id: string | null;
  subscription_status: string | null;
  subscription_current_end: number | null;
  created_at: number;
}

interface DbConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  skill_id: string | null;
  created_at: number;
  updated_at: number;
}

interface DbMemoryRow {
  id: string;
  user_id: string;
  content: string;
  category: string | null;
  created_at: number;
  updated_at: number;
}

interface DbSkillRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  system_prompt: string;
  usage_count: number;
  created_at: number;
  updated_at: number;
}

interface DbAttachmentRow {
  id: string;
  user_id: string;
  message_id: string | null;
  kind: string;
  mime: string;
  path: string;
  filename: string | null;
  extracted_text: string | null;
  char_count: number | null;
  created_at: number;
}

/** A remote MCP server / app connector, as exposed to the client (auth redacted). */
export interface CloudMcpServer {
  id: string;
  userId: string;
  name: string;
  url: string;
  /** True when an auth header is stored — the header value itself is never sent. */
  hasAuth: boolean;
  /** Connector-catalog id when this came from a preset (e.g. 'github'); else null. */
  connectorId: string | null;
  enabled: boolean;
  createdAt: number;
}

interface DbMcpServerRow {
  id: string;
  user_id: string;
  name: string;
  url: string;
  headers_json: string | null;
  connector_id: string | null;
  enabled: number;
  created_at: number;
}

interface DbMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  tier: string | null;
  why_json: string | null;
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

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        mime TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id);

      -- Remote MCP servers + app connectors a user has added. headers_json
      -- carries auth (bearer token / API key) and is NEVER returned to the
      -- client; only a redacted "has auth" flag is exposed.
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        headers_json TEXT,
        connector_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id);
    `);

    // Additive columns — ALTER ... ADD COLUMN throws if the column already
    // exists, so guard on the current schema (this migrate() runs every boot).
    const hasCol = (table: string, col: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
    if (!hasCol('conversations', 'skill_id')) this.db.exec('ALTER TABLE conversations ADD COLUMN skill_id TEXT');
    // Run-explorer: which tier answered + the JSON /why report.
    if (!hasCol('messages', 'tier')) this.db.exec('ALTER TABLE messages ADD COLUMN tier TEXT');
    if (!hasCol('messages', 'why_json')) this.db.exec('ALTER TABLE messages ADD COLUMN why_json TEXT');
    // Per-user memory categories (STACK/STYLE/PROJECT/…).
    if (!hasCol('memories', 'category')) this.db.exec('ALTER TABLE memories ADD COLUMN category TEXT');
    // Document attachments: original filename + extracted text (parsed at upload)
    // so a run injects the text without re-parsing, plus a char count for display.
    if (!hasCol('attachments', 'filename')) this.db.exec('ALTER TABLE attachments ADD COLUMN filename TEXT');
    if (!hasCol('attachments', 'extracted_text')) this.db.exec('ALTER TABLE attachments ADD COLUMN extracted_text TEXT');
    if (!hasCol('attachments', 'char_count')) this.db.exec('ALTER TABLE attachments ADD COLUMN char_count INTEGER');
    // Razorpay subscription state.
    if (!hasCol('users', 'subscription_id')) this.db.exec('ALTER TABLE users ADD COLUMN subscription_id TEXT');
    if (!hasCol('users', 'subscription_status')) this.db.exec('ALTER TABLE users ADD COLUMN subscription_status TEXT');
    if (!hasCol('users', 'subscription_current_end')) this.db.exec('ALTER TABLE users ADD COLUMN subscription_current_end INTEGER');
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
      subscription_id: null,
      subscription_status: null,
      subscription_current_end: null,
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

  getUserBySubscriptionId(subscriptionId: string): CloudUser | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE subscription_id = ?')
      .get(subscriptionId) as DbUserRow | undefined;
    return row ? this.deserializeUser(row) : null;
  }

  /** Persist subscription state + the derived plan (webhook / subscribe / cancel). */
  setUserSubscription(
    userId: string,
    input: { subscriptionId: string | null; status: string | null; currentEnd: number | null; plan: string },
  ): void {
    this.db
      .prepare(
        'UPDATE users SET subscription_id = ?, subscription_status = ?, subscription_current_end = ?, plan = ? WHERE id = ?',
      )
      .run(input.subscriptionId, input.status, input.currentEnd, input.plan, userId);
  }

  // ── Conversations ─────────────────────────────

  createConversation(userId: string, title: string | null = null): CloudConversation {
    const now = Date.now();
    const row: DbConversationRow = { id: randomUUID(), user_id: userId, title, skill_id: null, created_at: now, updated_at: now };
    this.db
      .prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.title, row.created_at, row.updated_at);
    return this.deserializeConversation(row);
  }

  setConversationSkill(id: string, userId: string, skillId: string | null): void {
    this.db.prepare('UPDATE conversations SET skill_id = ? WHERE id = ? AND user_id = ?').run(skillId, id, userId);
  }

  /**
   * Create a conversation seeded with an imported transcript — the receiving
   * end of an "open-and-continue" handoff. Only user/assistant turns are kept
   * (system/other roles dropped); no per-message economics (model/tier/why/cost)
   * come across since they belonged to the other surface's run. Runs in one
   * transaction so a partial import can't leave a half-populated conversation.
   */
  importConversation(
    userId: string,
    title: string | null,
    skillId: string | null,
    messages: Array<{ role: string; content: string }>,
  ): CloudConversation {
    const insert = this.db.transaction(() => {
      const convo = this.createConversation(userId, title);
      if (skillId) this.setConversationSkill(convo.id, userId, skillId);
      for (const m of messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        if (typeof m.content !== 'string' || !m.content) continue;
        this.addMessage({ conversationId: convo.id, role: m.role, content: m.content });
      }
      return convo;
    });
    return insert();
  }

  /**
   * Rename a conversation (owner-scoped). Returns false if it isn't the user's.
   * Deliberately does NOT touch updated_at — a background auto-title shouldn't
   * bump the conversation to the top of the recency-sorted list.
   */
  renameConversation(id: string, userId: string, title: string): boolean {
    const info = this.db
      .prepare('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?')
      .run(title, id, userId);
    return info.changes > 0;
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
    tier?: string | null;
    why?: string | null;
    costUsd?: number | null;
  }): CloudMessage {
    const row: DbMessageRow = {
      id: randomUUID(),
      conversation_id: input.conversationId,
      role: input.role,
      content: input.content,
      model: input.model ?? null,
      tier: input.tier ?? null,
      why_json: input.why ?? null,
      cost_usd: input.costUsd ?? null,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, model, tier, why_json, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.conversation_id, row.role, row.content, row.model, row.tier, row.why_json, row.cost_usd, row.created_at);
    this.touchConversation(input.conversationId);
    return this.deserializeMessage(row);
  }

  /**
   * Tier mix for a user's runs since `sinceMs` — a count of assistant messages
   * grouped by the tier that produced them. Powers "Tier mix — today".
   */
  tierMixSince(userId: string, sinceMs: number): Array<{ tier: string; count: number }> {
    return this.db
      .prepare(
        `SELECT m.tier AS tier, COUNT(*) AS count
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_id = ? AND m.role = 'assistant' AND m.tier IS NOT NULL AND m.created_at >= ?
         GROUP BY m.tier ORDER BY count DESC`,
      )
      .all(userId, sinceMs) as Array<{ tier: string; count: number }>;
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

  // ── Memories (per-user persistent facts) ──────

  listMemories(userId: string): CloudMemory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(userId) as DbMemoryRow[];
    return rows.map((r) => this.deserializeMemory(r));
  }

  addMemory(userId: string, content: string, category: string | null = null): CloudMemory {
    const now = Date.now();
    const row: DbMemoryRow = { id: randomUUID(), user_id: userId, content, category, created_at: now, updated_at: now };
    this.db
      .prepare('INSERT INTO memories (id, user_id, content, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.content, row.category, row.created_at, row.updated_at);
    return this.deserializeMemory(row);
  }

  updateMemory(id: string, userId: string, content: string, category: string | null = null): CloudMemory | null {
    const info = this.db
      .prepare('UPDATE memories SET content = ?, category = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(content, category, Date.now(), id, userId);
    if (info.changes === 0) return null;
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as DbMemoryRow;
    return this.deserializeMemory(row);
  }

  deleteMemory(id: string, userId: string): boolean {
    const info = this.db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId);
    return info.changes > 0;
  }

  // ── Attachments (uploaded images, on-disk, referenced by row) ──

  addAttachment(input: {
    userId: string; messageId: string | null; kind: string; mime: string; path: string;
    filename?: string | null; extractedText?: string | null;
  }): CloudAttachment {
    const text = input.extractedText ?? null;
    const row: DbAttachmentRow = {
      id: randomUUID(),
      user_id: input.userId,
      message_id: input.messageId,
      kind: input.kind,
      mime: input.mime,
      path: input.path,
      filename: input.filename ?? null,
      extracted_text: text,
      char_count: text != null ? text.length : null,
      created_at: Date.now(),
    };
    this.db
      .prepare('INSERT INTO attachments (id, user_id, message_id, kind, mime, path, filename, extracted_text, char_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.message_id, row.kind, row.mime, row.path, row.filename, row.extracted_text, row.char_count, row.created_at);
    return this.deserializeAttachment(row);
  }

  /** The extracted text for a document attachment, owner-scoped. Kept separate
   *  from getOwnedAttachment so list/transcript queries never load the full body. */
  getOwnedAttachmentText(id: string, userId: string): string | null {
    const row = this.db
      .prepare('SELECT extracted_text FROM attachments WHERE id = ? AND user_id = ?')
      .get(id, userId) as { extracted_text: string | null } | undefined;
    return row?.extracted_text ?? null;
  }

  linkAttachmentToMessage(id: string, userId: string, messageId: string): void {
    this.db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND user_id = ?').run(messageId, id, userId);
  }

  getAttachmentsForMessage(messageId: string): CloudAttachment[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(messageId) as DbAttachmentRow[];
    return rows.map((r) => this.deserializeAttachment(r));
  }

  /** Fetch an attachment only if it belongs to the given user. */
  getOwnedAttachment(id: string, userId: string): CloudAttachment | null {
    const row = this.db
      .prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?')
      .get(id, userId) as DbAttachmentRow | undefined;
    return row ? this.deserializeAttachment(row) : null;
  }

  // ── MCP servers / connectors (remote tool sources) ──

  listMcpServers(userId: string): CloudMcpServer[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(userId) as DbMcpServerRow[];
    return rows.map((r) => this.deserializeMcpServer(r));
  }

  /** Enabled servers with their raw auth headers — for run wiring only, never
   *  exposed over the API. */
  listEnabledMcpServersWithAuth(userId: string): Array<{ name: string; url: string; headers?: Record<string, string> }> {
    const rows = this.db
      .prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY created_at ASC, rowid ASC')
      .all(userId) as DbMcpServerRow[];
    return rows.map((r) => ({
      name: r.name,
      url: r.url,
      ...(r.headers_json ? { headers: JSON.parse(r.headers_json) as Record<string, string> } : {}),
    }));
  }

  addMcpServer(input: {
    userId: string; name: string; url: string;
    headers?: Record<string, string> | null; connectorId?: string | null;
  }): CloudMcpServer {
    const row: DbMcpServerRow = {
      id: randomUUID(),
      user_id: input.userId,
      name: input.name,
      url: input.url,
      headers_json: input.headers && Object.keys(input.headers).length ? JSON.stringify(input.headers) : null,
      connector_id: input.connectorId ?? null,
      enabled: 1,
      created_at: Date.now(),
    };
    this.db
      .prepare('INSERT INTO mcp_servers (id, user_id, name, url, headers_json, connector_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.name, row.url, row.headers_json, row.connector_id, row.enabled, row.created_at);
    return this.deserializeMcpServer(row);
  }

  setMcpServerEnabled(id: string, userId: string, enabled: boolean): boolean {
    const info = this.db
      .prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ? AND user_id = ?')
      .run(enabled ? 1 : 0, id, userId);
    return info.changes > 0;
  }

  deleteMcpServer(id: string, userId: string): boolean {
    const info = this.db.prepare('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?').run(id, userId);
    return info.changes > 0;
  }

  // ── Deserializers ─────────────────────────────

  private deserializeMcpServer(row: DbMcpServerRow): CloudMcpServer {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      url: row.url,
      hasAuth: !!row.headers_json,
      connectorId: row.connector_id ?? null,
      enabled: !!row.enabled,
      createdAt: row.created_at,
    };
  }

  private deserializeUser(row: DbUserRow): CloudUser {
    return {
      id: row.id,
      provider: row.provider as OAuthProvider,
      providerId: row.provider_id,
      email: row.email,
      name: row.name,
      avatar: row.avatar,
      plan: row.plan,
      subscriptionId: row.subscription_id ?? null,
      subscriptionStatus: row.subscription_status ?? null,
      subscriptionCurrentEnd: row.subscription_current_end ?? null,
      createdAt: row.created_at,
    };
  }

  private deserializeConversation(row: DbConversationRow): CloudConversation {
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      skillId: row.skill_id ?? null,
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
      tier: row.tier ?? null,
      why: row.why_json ?? null,
      costUsd: row.cost_usd,
      createdAt: row.created_at,
    };
  }

  private deserializeMemory(row: DbMemoryRow): CloudMemory {
    return {
      id: row.id,
      userId: row.user_id,
      content: row.content,
      category: row.category ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Skills (per-user custom prompt presets) ──

  listUserSkills(userId: string): CloudSkill[] {
    const rows = this.db
      .prepare('SELECT * FROM skills WHERE user_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(userId) as DbSkillRow[];
    return rows.map((r) => this.deserializeSkill(r));
  }

  getUserSkill(id: string, userId: string): CloudSkill | null {
    const row = this.db
      .prepare('SELECT * FROM skills WHERE id = ? AND user_id = ?')
      .get(id, userId) as DbSkillRow | undefined;
    return row ? this.deserializeSkill(row) : null;
  }

  createUserSkill(userId: string, input: { name: string; description: string; systemPrompt: string }): CloudSkill {
    const now = Date.now();
    const row: DbSkillRow = {
      id: randomUUID(),
      user_id: userId,
      name: input.name,
      description: input.description,
      system_prompt: input.systemPrompt,
      usage_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO skills (id, user_id, name, description, system_prompt, usage_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.user_id, row.name, row.description, row.system_prompt, row.usage_count, row.created_at, row.updated_at);
    return this.deserializeSkill(row);
  }

  updateUserSkill(
    id: string,
    userId: string,
    input: { name: string; description: string; systemPrompt: string },
  ): CloudSkill | null {
    const info = this.db
      .prepare('UPDATE skills SET name = ?, description = ?, system_prompt = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(input.name, input.description, input.systemPrompt, Date.now(), id, userId);
    if (info.changes === 0) return null;
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as DbSkillRow;
    return this.deserializeSkill(row);
  }

  deleteUserSkill(id: string, userId: string): boolean {
    const info = this.db.prepare('DELETE FROM skills WHERE id = ? AND user_id = ?').run(id, userId);
    return info.changes > 0;
  }

  /** Bump a skill's usage counter after a run that used it (owner-scoped). */
  incrementSkillUsage(id: string, userId: string): void {
    this.db.prepare('UPDATE skills SET usage_count = usage_count + 1 WHERE id = ? AND user_id = ?').run(id, userId);
  }

  private deserializeSkill(row: DbSkillRow): CloudSkill {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      description: row.description,
      systemPrompt: row.system_prompt,
      usageCount: row.usage_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private deserializeAttachment(row: DbAttachmentRow): CloudAttachment {
    return {
      id: row.id,
      userId: row.user_id,
      messageId: row.message_id,
      kind: row.kind,
      mime: row.mime,
      path: row.path,
      filename: row.filename ?? null,
      charCount: row.char_count ?? null,
      createdAt: row.created_at,
    };
  }
}
