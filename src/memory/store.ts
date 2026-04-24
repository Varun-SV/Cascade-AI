// ─────────────────────────────────────────────
//  Cascade AI — SQLite Memory Store
// ─────────────────────────────────────────────

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  AuditEntry,
  Identity,
  ModelInfo,
  ProviderType,
  RuntimeNode,
  RuntimeNodeLog,
  RuntimeSession,
  ScheduledTask,
  Session,
  StoredMessage,
} from '../types.js';

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    try {
      this.db = new Database(dbPath, { timeout: 5000 });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = NORMAL'); // Better concurrency with WAL
      this.migrate();
    } catch (err) {
      if (err instanceof Error && err.message.includes('Could not locate the bindings file')) {
        throw new Error(
          `Cascade AI failed to load its database (better-sqlite3). This is usually because native bindings for Node.js ${process.version} are missing.\n\n` +
          `Please try running: npm install better-sqlite3 --force\n` +
          `Original error: ${err.message}`
        );
      }
      throw err;
    }
  }

  // ── Async Write Queue ─────────────────────────

  private writeQueue: Array<() => void> = [];
  private isProcessingQueue = false;

  private async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    while (this.writeQueue.length > 0) {
      const op = this.writeQueue.shift();
      if (op) {
        let attempts = 0;
        while (attempts < 5) {
          try {
            op();
            break;
          } catch (err: unknown) {
            if (err instanceof Error && (err as any).code === 'SQLITE_BUSY') {
              attempts++;
              await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempts)));
            } else {
              console.error('Cascade AI: DB Write Error:', err);
              break;
            }
          }
        }
      }
    }
    this.isProcessingQueue = false;
  }

  private enqueueWrite(op: () => void) {
    this.writeQueue.push(op);
    this.processQueue().catch(console.error);
  }

  // ── Sessions ──────────────────────────────────

  createSession(session: Session): void {
    this.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at, identity_id, workspace_path, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.title, session.createdAt, session.updatedAt, session.identityId, session.workspacePath, JSON.stringify(session.metadata));
  }

  updateSession(id: string, updates: Partial<Session>): void {
    const parts: string[] = [];
    const values: unknown[] = [];
    if (updates.title) { parts.push('title = ?'); values.push(updates.title); }
    if (updates.updatedAt) { parts.push('updated_at = ?'); values.push(updates.updatedAt); }
    if (updates.identityId) { parts.push('identity_id = ?'); values.push(updates.identityId); }
    if (updates.metadata) { parts.push('metadata = ?'); values.push(JSON.stringify(updates.metadata)); }
    if (!parts.length) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbSession | undefined;
    if (!row) return null;
    const messages = this.getSessionMessages(id);
    return this.deserializeSession(row, messages);
  }

  listSessions(identityId?: string, limit = 50): Session[] {
    const rows = identityId
      ? this.db.prepare('SELECT * FROM sessions WHERE identity_id = ? ORDER BY updated_at DESC LIMIT ?').all(identityId, limit) as DbSession[]
      : this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit) as DbSession[];
    return rows.map((r) => this.deserializeSession(r, []));
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  deleteAllSessions(): void {
    this.db.prepare('DELETE FROM file_snapshots').run();
    this.db.prepare('DELETE FROM messages').run();
    this.db.prepare('DELETE FROM sessions').run();
  }

  deleteRuntimeSession(sessionId: string): void {
    this.db.prepare('DELETE FROM runtime_node_logs WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM runtime_nodes WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM runtime_sessions WHERE session_id = ?').run(sessionId);
  }

  deleteAllRuntimeNodes(): void {
    this.db.prepare('DELETE FROM runtime_node_logs').run();
    this.db.prepare('DELETE FROM runtime_nodes').run();
    this.db.prepare('DELETE FROM runtime_sessions').run();
  }

  branchSession(originalId: string, newId: string): void {
    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(originalId) as DbSession | undefined;
    if (!session) throw new Error(`Original session ${originalId} not found`);

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at, identity_id, workspace_path, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId, `${session.title} (Branch)`, now, now, session.identity_id, session.workspace_path, session.metadata);

    const messages = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(originalId) as DbMessage[];
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, tokens, agent_messages)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const msg of messages) {
      stmt.run(randomUUID(), newId, msg.role, msg.content, msg.timestamp, msg.tokens, msg.agent_messages);
    }

    const snapshots = this.db.prepare('SELECT * FROM file_snapshots WHERE session_id = ?').all(originalId) as DbFileSnapshot[];
    const snapStmt = this.db.prepare(`
      INSERT INTO file_snapshots (id, session_id, file_path, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const snap of snapshots) {
      snapStmt.run(randomUUID(), newId, snap.file_path, snap.content, snap.timestamp);
    }
  }

  // ── Runtime Sessions / Nodes ─────────────────

  upsertRuntimeSession(session: RuntimeSession): void {
    this.enqueueWrite(() => {
      this.db.prepare(`
        INSERT INTO runtime_sessions (session_id, title, workspace_path, status, started_at, updated_at, latest_prompt, is_global)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title,
          workspace_path = excluded.workspace_path,
          status = excluded.status,
          updated_at = excluded.updated_at,
          latest_prompt = excluded.latest_prompt,
          is_global = excluded.is_global
      `).run(
        session.sessionId,
        session.title,
        session.workspacePath,
        session.status,
        session.startedAt,
        session.updatedAt,
        session.latestPrompt ?? null,
        session.isGlobal ? 1 : 0,
      );
    });
  }

  listRuntimeSessions(limit = 100): RuntimeSession[] {
    const rows = this.db.prepare(`
      SELECT * FROM runtime_sessions ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as DbRuntimeSession[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      title: row.title,
      workspacePath: row.workspace_path,
      status: row.status as RuntimeSession['status'],
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      latestPrompt: row.latest_prompt ?? undefined,
      isGlobal: row.is_global === 1,
    }));
  }

  upsertRuntimeNode(node: RuntimeNode): void {
    this.enqueueWrite(() => {
      this.db.prepare(`
        INSERT INTO runtime_nodes (tier_id, session_id, parent_id, role, label, status, current_action, progress_pct, updated_at, workspace_path, is_global, output)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tier_id) DO UPDATE SET
          session_id = excluded.session_id,
          parent_id = excluded.parent_id,
          role = excluded.role,
          label = excluded.label,
          status = excluded.status,
          current_action = excluded.current_action,
          progress_pct = excluded.progress_pct,
          updated_at = excluded.updated_at,
          workspace_path = excluded.workspace_path,
          is_global = excluded.is_global,
          output = excluded.output
      `).run(
        node.tierId,
        node.sessionId,
        node.parentId ?? null,
        node.role,
        node.label,
        node.status,
        node.currentAction ?? null,
        node.progressPct ?? null,
        node.updatedAt,
        node.workspacePath ?? null,
        node.isGlobal ? 1 : 0,
        node.output ?? null,
      );
    });
  }

  listRuntimeNodes(sessionId?: string, limit = 500): RuntimeNode[] {
    const rows = sessionId
      ? this.db.prepare(`
          SELECT * FROM runtime_nodes WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?
        `).all(sessionId, limit) as DbRuntimeNode[]
      : this.db.prepare(`
          SELECT * FROM runtime_nodes ORDER BY updated_at DESC LIMIT ?
        `).all(limit) as DbRuntimeNode[];

    return rows.map((row) => ({
      tierId: row.tier_id,
      sessionId: row.session_id,
      parentId: row.parent_id ?? undefined,
      role: row.role as RuntimeNode['role'],
      label: row.label,
      status: row.status as RuntimeNode['status'],
      currentAction: row.current_action ?? undefined,
      progressPct: row.progress_pct ?? undefined,
      updatedAt: row.updated_at,
      workspacePath: row.workspace_path ?? undefined,
      isGlobal: row.is_global === 1,
      output: row.output ?? undefined,
    }));
  }

  addRuntimeNodeLog(log: RuntimeNodeLog): void {
    this.enqueueWrite(() => {
      this.db.prepare(`
        INSERT INTO runtime_node_logs (id, session_id, tier_id, role, label, status, current_action, progress_pct, timestamp, workspace_path, is_global, output)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        log.id,
        log.sessionId,
        log.tierId,
        log.role,
        log.label,
        log.status,
        log.currentAction ?? null,
        log.progressPct ?? null,
        log.timestamp,
        log.workspacePath ?? null,
        log.isGlobal ? 1 : 0,
        log.output ?? null,
      );

      this.db.prepare(`
        DELETE FROM runtime_node_logs
        WHERE id NOT IN (
          SELECT id FROM runtime_node_logs
          ORDER BY timestamp DESC
          LIMIT 2000
        )
      `).run();
    });
  }

  listRuntimeNodeLogs(sessionId?: string, tierId?: string, limit = 200): RuntimeNodeLog[] {
    let rows: DbRuntimeNodeLog[];

    if (sessionId && tierId) {
      rows = this.db.prepare(`
        SELECT * FROM runtime_node_logs
        WHERE session_id = ? AND tier_id = ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(sessionId, tierId, limit) as DbRuntimeNodeLog[];
    } else if (sessionId) {
      rows = this.db.prepare(`
        SELECT * FROM runtime_node_logs
        WHERE session_id = ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(sessionId, limit) as DbRuntimeNodeLog[];
    } else {
      rows = this.db.prepare(`
        SELECT * FROM runtime_node_logs
        ORDER BY timestamp DESC LIMIT ?
      `).all(limit) as DbRuntimeNodeLog[];
    }

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      tierId: row.tier_id,
      role: row.role as RuntimeNodeLog['role'],
      label: row.label,
      status: row.status as RuntimeNodeLog['status'],
      currentAction: row.current_action ?? undefined,
      progressPct: row.progress_pct ?? undefined,
      timestamp: row.timestamp,
      workspacePath: row.workspace_path ?? undefined,
      isGlobal: row.is_global === 1,
      output: row.output ?? undefined,
    }));
  }

  // ── Messages ──────────────────────────────────

  addMessage(message: StoredMessage): void {
    this.enqueueWrite(() => {
      this.db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp, tokens, agent_messages)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.sessionId,
        message.role,
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        message.timestamp,
        message.tokens ? JSON.stringify(message.tokens) : null,
        message.agentMessages ? JSON.stringify(message.agentMessages) : null,
      );
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(message.timestamp, message.sessionId);
    });
  }

  getSessionMessages(sessionId: string): StoredMessage[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as DbMessage[];
    return rows.map(this.deserializeMessage);
  }

  searchMessages(query: string, limit = 20): StoredMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM messages WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?
    `).all(`%${query}%`, limit) as DbMessage[];
    return rows.map(this.deserializeMessage);
  }

  // ── Identities ────────────────────────────────

  createIdentity(identity: Identity): void {
    this.db.prepare(`
      INSERT INTO identities (id, name, description, avatar, created_at, default_model, system_prompt, is_default)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(identity.id, identity.name, identity.description ?? null, identity.avatar ?? null,
      identity.createdAt, identity.defaultModel ?? null, identity.systemPrompt ?? null,
      identity.isDefault ? 1 : 0);
  }

  updateIdentity(id: string, updates: Partial<Identity>): void {
    const parts: string[] = [];
    const values: unknown[] = [];
    if (updates.name !== undefined) { parts.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { parts.push('description = ?'); values.push(updates.description); }
    if (updates.systemPrompt !== undefined) { parts.push('system_prompt = ?'); values.push(updates.systemPrompt); }
    if (updates.isDefault !== undefined) { parts.push('is_default = ?'); values.push(updates.isDefault ? 1 : 0); }
    if (!parts.length) return;
    values.push(id);
    this.db.prepare(`UPDATE identities SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  getIdentity(id: string): Identity | null {
    const row = this.db.prepare('SELECT * FROM identities WHERE id = ?').get(id) as DbIdentity | undefined;
    return row ? this.deserializeIdentity(row) : null;
  }

  getDefaultIdentity(): Identity | null {
    const row = this.db.prepare('SELECT * FROM identities WHERE is_default = 1 LIMIT 1').get() as DbIdentity | undefined;
    if (!row) {
      const first = this.db.prepare('SELECT * FROM identities LIMIT 1').get() as DbIdentity | undefined;
      return first ? this.deserializeIdentity(first) : null;
    }
    return this.deserializeIdentity(row);
  }

  listIdentities(): Identity[] {
    const rows = this.db.prepare('SELECT * FROM identities ORDER BY is_default DESC, name ASC').all() as DbIdentity[];
    return rows.map(this.deserializeIdentity);
  }

  deleteIdentity(id: string): void {
    this.db.prepare('DELETE FROM identities WHERE id = ?').run(id);
  }

  // ── Scheduled Tasks ───────────────────────────

  saveScheduledTask(task: ScheduledTask): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO scheduled_tasks (id, name, cron_expression, prompt, identity_id, workspace_path, created_at, last_run, next_run, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.name, task.cronExpression, task.prompt, task.identityId ?? null,
      task.workspacePath ?? null, task.createdAt, task.lastRun ?? null, task.nextRun ?? null, task.enabled ? 1 : 0);
  }

  listScheduledTasks(): ScheduledTask[] {
    const rows = this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY name').all() as DbScheduledTask[];
    return rows.map(this.deserializeScheduledTask);
  }

  deleteScheduledTask(id: string): void {
    this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  }

  // ── Audit Log ─────────────────────────────────

  addAuditEntry(entry: AuditEntry): void {
    this.enqueueWrite(() => {
      this.db.prepare(`
        INSERT INTO audit_log (id, session_id, timestamp, tier_id, action, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entry.id, entry.sessionId, entry.timestamp, entry.tierId, entry.action, JSON.stringify(entry.details));
    });
  }

  getAuditLog(sessionId: string, limit = 100): AuditEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit_log WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?').all(sessionId, limit) as DbAudit[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      timestamp: r.timestamp,
      tierId: r.tier_id,
      action: r.action as AuditEntry['action'],
      details: JSON.parse(r.details) as Record<string, unknown>,
    }));
  }

  // ── File Snapshots ────────────────────────────

  addFileSnapshot(sessionId: string, filePath: string, content: string): void {
    this.enqueueWrite(() => {
      this.db.prepare(`
        INSERT INTO file_snapshots (id, session_id, file_path, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), sessionId, filePath, content, new Date().toISOString());
    });
  }

  getLatestFileSnapshots(sessionId: string): Array<{ filePath: string; content: string }> {
    // Return the earliest snapshot per file — the "before" state used by
    // /rollback. ISO timestamps have millisecond resolution, so two rapid
    // calls can share a timestamp. The inner query picks a single winning
    // row per (session, path) by (timestamp ASC, rowid ASC), then the outer
    // query dedups to that row — avoiding the duplicate-row bug that
    // returned every snapshot for files written in the same millisecond.
    const rows = this.db.prepare(`
      SELECT fs.file_path, fs.content
      FROM file_snapshots fs
      WHERE fs.session_id = ?
        AND fs.rowid = (
          SELECT fs2.rowid
          FROM file_snapshots fs2
          WHERE fs2.session_id = fs.session_id
            AND fs2.file_path = fs.file_path
          ORDER BY fs2.timestamp ASC, fs2.rowid ASC
          LIMIT 1
        )
    `).all(sessionId) as Array<{ file_path: string; content: string }>;

    return rows.map((r) => ({ filePath: r.file_path, content: r.content }));
  }

  // ── Model Cache ───────────────────────────────

  upsertCachedModel(model: ModelInfo): void {
    this.db.prepare(`
      INSERT INTO model_cache (id, provider, model_id, name, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      `${model.provider}:${model.id}`,
      model.provider,
      model.id,
      model.name,
      JSON.stringify(model),
      new Date().toISOString(),
    );
  }

  getCachedModels(provider?: ProviderType): ModelInfo[] {
    const rows = provider
      ? this.db.prepare('SELECT metadata FROM model_cache WHERE provider = ?').all(provider) as { metadata: string }[]
      : this.db.prepare('SELECT metadata FROM model_cache').all() as { metadata: string }[];
    return rows.map(r => JSON.parse(r.metadata));
  }

  clearModelCache(provider?: ProviderType): void {
    if (provider) {
      this.db.prepare('DELETE FROM model_cache WHERE provider = ?').run(provider);
    } else {
      this.db.prepare('DELETE FROM model_cache').run();
    }
  }

  getCacheAge(): number {
    const row = this.db.prepare('SELECT MIN(updated_at) as oldest FROM model_cache').get() as { oldest: string | null };
    if (!row.oldest) return Infinity;
    return Date.now() - new Date(row.oldest).getTime();
  }

  saveModelProfile(modelId: string, provider: ProviderType, specializations: string[]): void {
    const cacheKey = `${provider}:${modelId}`;
    const existing = this.db.prepare('SELECT metadata FROM model_cache WHERE id = ?').get(cacheKey) as { metadata: string } | undefined;
    const meta: ModelInfo = existing
      ? JSON.parse(existing.metadata) as ModelInfo
      : { id: modelId, provider, name: modelId, contextWindow: 0, isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 0, supportsStreaming: false, isLocal: false };
    meta.specializations = specializations;
    this.db.prepare(`
      INSERT INTO model_cache (id, provider, model_id, name, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata, updated_at = excluded.updated_at
    `).run(cacheKey, provider, modelId, meta.name ?? modelId, JSON.stringify(meta), new Date().toISOString());
  }

  getModelProfile(modelId: string, provider: ProviderType): ModelInfo | undefined {
    const row = this.db.prepare('SELECT metadata FROM model_cache WHERE id = ?').get(`${provider}:${modelId}`) as { metadata: string } | undefined;
    return row ? JSON.parse(row.metadata) as ModelInfo : undefined;
  }

  getProfiledModelIds(): string[] {
    const rows = this.db.prepare(
      "SELECT model_id FROM model_cache WHERE json_extract(metadata, '$.specializations') IS NOT NULL"
    ).all() as { model_id: string }[];
    return rows.map(r => r.model_id);
  }

  // ── Tool Result Cache (in-memory, TTL-based) ──────────────────────────
  // Avoids redundant calls for read-only tools within a short window.
  // Not persisted to DB — cleared on process restart.

  private toolResultCache: Map<string, { result: string; expiresAt: number }> = new Map();

  private static CACHEABLE_TOOLS = new Set([
    'file_read', 'file_list',
  ]);

  private static TOOL_TTL_MS: Record<string, number> = {
    file_read:  60_000,
    file_list:  30_000,
  };

  /**
   * Returns a cached tool result, or null if not cached / expired.
   */
  getToolResult(toolName: string, input: Record<string, unknown>): string | null {
    if (!MemoryStore.CACHEABLE_TOOLS.has(toolName)) return null;
    const key = `${toolName}:${JSON.stringify(input)}`;
    const entry = this.toolResultCache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.toolResultCache.delete(key);
      return null;
    }
    return entry.result;
  }

  /**
   * Stores a tool result in the in-memory cache.
   * Only caches read-only/safe tools (see CACHEABLE_TOOLS).
   */
  setToolResult(toolName: string, input: Record<string, unknown>, result: string): void {
    if (!MemoryStore.CACHEABLE_TOOLS.has(toolName)) return;
    const ttl = MemoryStore.TOOL_TTL_MS[toolName] ?? 30_000;
    this.toolResultCache.set(`${toolName}:${JSON.stringify(input)}`, {
      result,
      expiresAt: Date.now() + ttl,
    });
  }

  /** Invalidate tool cache for a specific tool name, or all tools if omitted. */
  invalidateToolCache(toolName?: string): void {
    if (!toolName) { this.toolResultCache.clear(); return; }
    for (const key of this.toolResultCache.keys()) {
      if (key.startsWith(`${toolName}:`)) this.toolResultCache.delete(key);
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Migration ─────────────────────────────────

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        tokens TEXT,
        agent_messages TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);

      CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        avatar TEXT,
        created_at TEXT NOT NULL,
        default_model TEXT,
        system_prompt TEXT,
        is_default INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        prompt TEXT NOT NULL,
        identity_id TEXT,
        workspace_path TEXT,
        created_at TEXT NOT NULL,
        last_run TEXT,
        next_run TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        tier_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);

      CREATE TABLE IF NOT EXISTS runtime_sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        latest_prompt TEXT,
        is_global INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS runtime_nodes (
        tier_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_id TEXT,
        role TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        current_action TEXT,
        progress_pct INTEGER,
        updated_at TEXT NOT NULL,
        workspace_path TEXT,
        is_global INTEGER NOT NULL DEFAULT 0,
        output TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_nodes_session ON runtime_nodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_nodes_updated ON runtime_nodes(updated_at);

      CREATE TABLE IF NOT EXISTS runtime_node_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tier_id TEXT NOT NULL,
        role TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        current_action TEXT,
        progress_pct INTEGER,
        timestamp TEXT NOT NULL,
        workspace_path TEXT,
        is_global INTEGER NOT NULL DEFAULT 0,
        output TEXT
      );

      CREATE TABLE IF NOT EXISTS model_cache (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_logs_session ON runtime_node_logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_logs_tier ON runtime_node_logs(tier_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_logs_timestamp ON runtime_node_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_runtime_nodes_session_updated ON runtime_nodes(session_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_runtime_logs_session_timestamp ON runtime_node_logs(session_id, timestamp);

      CREATE TABLE IF NOT EXISTS file_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_file_snapshots_session ON file_snapshots(session_id);
    `);

    // Auto-migrate: Add 'output' column if missing
    try { this.db.exec('ALTER TABLE runtime_nodes ADD COLUMN output TEXT'); } catch { /* ignore */ }
    try { this.db.exec('ALTER TABLE runtime_node_logs ADD COLUMN output TEXT'); } catch { /* ignore */ }
  }

  // ── Deserializers ─────────────────────────────

  private deserializeSession(row: DbSession, messages: StoredMessage[]): Session {
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      identityId: row.identity_id,
      workspacePath: row.workspace_path,
      messages,
      metadata: JSON.parse(row.metadata) as Session['metadata'],
    };
  }

  private deserializeMessage(row: DbMessage): StoredMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role as StoredMessage['role'],
      content: row.content,
      timestamp: row.timestamp,
      tokens: row.tokens ? JSON.parse(row.tokens) : undefined,
      agentMessages: row.agent_messages ? JSON.parse(row.agent_messages) : undefined,
    };
  }

  private deserializeIdentity(row: DbIdentity): Identity {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      avatar: row.avatar ?? undefined,
      createdAt: row.created_at,
      defaultModel: row.default_model ?? undefined,
      systemPrompt: row.system_prompt ?? undefined,
      isDefault: row.is_default === 1,
    };
  }

  private deserializeScheduledTask(row: DbScheduledTask): ScheduledTask {
    return {
      id: row.id,
      name: row.name,
      cronExpression: row.cron_expression,
      prompt: row.prompt,
      identityId: row.identity_id ?? undefined,
      workspacePath: row.workspace_path ?? undefined,
      createdAt: row.created_at,
      lastRun: row.last_run ?? undefined,
      nextRun: row.next_run ?? undefined,
      enabled: row.enabled === 1,
    };
  }
}

// ── DB Row Types ──────────────────────────────

interface DbSession {
  id: string; title: string; created_at: string; updated_at: string;
  identity_id: string; workspace_path: string; metadata: string;
}
interface DbMessage {
  id: string; session_id: string; role: string; content: string;
  timestamp: string; tokens: string | null; agent_messages: string | null;
}
interface DbIdentity {
  id: string; name: string; description: string | null; avatar: string | null;
  created_at: string; default_model: string | null; system_prompt: string | null; is_default: number;
}
interface DbScheduledTask {
  id: string; name: string; cron_expression: string; prompt: string;
  identity_id: string | null; workspace_path: string | null;
  created_at: string; last_run: string | null; next_run: string | null; enabled: number;
}
interface DbAudit { id: string; session_id: string; timestamp: string; tier_id: string; action: string; details: string; }
interface DbFileSnapshot { id: string; session_id: string; file_path: string; content: string; timestamp: string; }
interface DbRuntimeSession {
  session_id: string; title: string; workspace_path: string; status: string;
  started_at: string; updated_at: string; latest_prompt: string | null; is_global: number;
}
interface DbRuntimeNode {
  tier_id: string; session_id: string; parent_id: string | null; role: string;
  label: string; status: string; current_action: string | null; progress_pct: number | null;
  updated_at: string; workspace_path: string | null; is_global: number; output: string | null;
}
interface DbRuntimeNodeLog {
  id: string; session_id: string; tier_id: string; role: string; label: string;
  status: string; current_action: string | null; progress_pct: number | null; timestamp: string;
  workspace_path: string | null; is_global: number; output: string | null;
}
