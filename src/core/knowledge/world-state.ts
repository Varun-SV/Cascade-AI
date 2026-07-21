import Database, { type Database as SQLiteDatabase } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

export interface WorldStateEntry {
  id: string;
  timestamp: string;
  summary: string;
  workerId: string;
}

/**
 * A single queryable fact in the project knowledge graph (world-state v2):
 * an `(entity, relation) → value` triple with provenance. Facts are upserted on
 * `(entity, relation)`, so a newer observation supersedes an older one instead of
 * appending — T1/T2 query relevant facts by entity rather than replaying the log.
 */
export interface WorldFact {
  entity: string;
  relation: string;
  value: string;
  sourceWorker: string;
  timestamp: string;
}

/** Normalize an entity/relation key so casing/whitespace don't fragment upserts. */
function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export class WorldStateDB {
  private db: SQLiteDatabase;
  private keyPath: string;
  private dbPath: string;
  private encryptionKey!: Buffer;
  
  constructor(private workspacePath: string, private debugMode = false) {
    const cascadeDir = path.join(workspacePath, '.cascade');
    if (!fs.existsSync(cascadeDir)) {
      fs.mkdirSync(cascadeDir, { recursive: true });
    }
    this.keyPath = path.join(cascadeDir, 'world_state.key');
    this.dbPath = path.join(cascadeDir, 'world_state.db');
    
    this.initEncryptionKey();
    
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS world_state (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL
      )
    `);

    // world-state v2: queryable fact store. `(entity, relation)` is the primary
    // key so a newer observation upserts (supersedes) the prior value. The value
    // is encrypted with the same key as the linear log; entity/relation stay
    // plaintext so they're indexable/queryable.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        entity TEXT NOT NULL,
        relation TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        source_worker TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (entity, relation)
      )
    `);

    // world-state v3: history-preserving writes. Before a fact is overwritten,
    // deleted, or cleared, its outgoing value is appended here (still encrypted
    // with the SAME key — value never leaves the AES-256-GCM envelope) so a bad
    // extraction can be inspected and undone. The current `facts` table stays
    // the single source of truth for reads, so planning is unchanged.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL,
        relation TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        source_worker TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT NOT NULL,
        change TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS facts_history_key
        ON facts_history(entity, relation, valid_to DESC);
    `);
  }

  /**
   * Append the CURRENTLY-stored fact for (e, r) to the history ledger before it
   * is overwritten/deleted, timestamped [its recorded time → now]. No-op when
   * there is no current row. The value stays encrypted with the same key.
   */
  private archiveCurrentFact(e: string, r: string, change: string, validTo: string): void {
    const row = this.db
      .prepare('SELECT encrypted_value, source_worker, timestamp FROM facts WHERE entity = ? AND relation = ?')
      .get(e, r) as { encrypted_value: string; source_worker: string; timestamp: string } | undefined;
    if (!row) return;
    this.db
      .prepare(
        `INSERT INTO facts_history (entity, relation, encrypted_value, source_worker, valid_from, valid_to, change)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e, r, row.encrypted_value, row.source_worker, row.timestamp, validTo, change);
  }

  private initEncryptionKey(): void {
    if (fs.existsSync(this.keyPath)) {
      this.encryptionKey = fs.readFileSync(this.keyPath);
    } else {
      this.encryptionKey = crypto.randomBytes(32);
      fs.writeFileSync(this.keyPath, this.encryptionKey);
    }
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  private decrypt(text: string): string {
    const parts = text.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted payload format');
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex!, 'hex');
    const authTag = Buffer.from(authTagHex!, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex!, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  public addEntry(workerId: string, summary: string): string {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    
    const payload = JSON.stringify({ summary });
    const encryptedPayload = this.encrypt(payload);
    
    const stmt = this.db.prepare('INSERT INTO world_state (id, timestamp, worker_id, encrypted_payload) VALUES (?, ?, ?, ?)');
    stmt.run(id, timestamp, workerId, encryptedPayload);

    this.dumpDebugIfNeeded();
    return id;
  }

  public getAllEntries(): WorldStateEntry[] {
    const stmt = this.db.prepare('SELECT id, timestamp, worker_id, encrypted_payload FROM world_state ORDER BY timestamp ASC');
    const rows = stmt.all() as any[];
    
    return rows.map(row => {
      try {
        const decrypted = this.decrypt(row.encrypted_payload);
        const parsed = JSON.parse(decrypted);
        return {
          id: row.id,
          timestamp: row.timestamp,
          workerId: row.worker_id,
          summary: parsed.summary
        };
      } catch (err) {
        return {
          id: row.id,
          timestamp: row.timestamp,
          workerId: row.worker_id,
          summary: '[Decryption Failed - Payload Corrupted]'
        };
      }
    });
  }

  public getFormattedState(): string {
    const entries = this.getAllEntries();
    if (entries.length === 0) return 'World State is currently empty.';
    
    return entries.map((e, idx) => `[${e.timestamp}] Step ${idx + 1} (${e.workerId}): ${e.summary}`).join('\n');
  }

  // ── world-state v2: queryable facts ──────────────

  /**
   * Upsert a fact. `(entity, relation)` is normalized so casing/whitespace don't
   * fragment the key; an existing pair is superseded (value + provenance updated)
   * rather than duplicated. Empty entity/relation/value are ignored.
   */
  public upsertFact(entity: string, relation: string, value: string, sourceWorker: string, timestamp?: string): void {
    const e = normalizeKey(entity);
    const r = normalizeKey(relation);
    const v = value.trim();
    if (!e || !r || !v) return;

    const now = timestamp ?? new Date().toISOString();
    const encrypted = this.encrypt(JSON.stringify({ value: v }));
    const upsert = this.db.prepare(`
      INSERT INTO facts (entity, relation, encrypted_value, source_worker, timestamp)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity, relation) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        source_worker   = excluded.source_worker,
        timestamp       = excluded.timestamp
    `);
    // Archive the outgoing value first — but only when it ACTUALLY changes, so
    // re-observing the same fact doesn't bloat history. All-or-nothing.
    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT encrypted_value FROM facts WHERE entity = ? AND relation = ?')
        .get(e, r) as { encrypted_value: string } | undefined;
      if (current) {
        let prevValue: string | null = null;
        try { prevValue = JSON.parse(this.decrypt(current.encrypted_value)).value; } catch { prevValue = null; }
        if (prevValue !== v) this.archiveCurrentFact(e, r, 'update', now);
      }
      upsert.run(e, r, encrypted, sourceWorker, now);
    });
    tx();
    this.dumpDebugIfNeeded();
  }

  private rowToFact(row: any): WorldFact {
    let value: string;
    try {
      value = JSON.parse(this.decrypt(row.encrypted_value)).value;
    } catch {
      value = '[Decryption Failed - Payload Corrupted]';
    }
    return { entity: row.entity, relation: row.relation, value, sourceWorker: row.source_worker, timestamp: row.timestamp };
  }

  /** All facts whose entity matches one of the (normalized) query entities. */
  public getFactsForEntities(entities: string[]): WorldFact[] {
    const keys = Array.from(new Set(entities.map(normalizeKey).filter(Boolean)));
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `SELECT entity, relation, encrypted_value, source_worker, timestamp FROM facts WHERE entity IN (${placeholders}) ORDER BY entity ASC, relation ASC`,
    );
    return (stmt.all(...keys) as any[]).map((row) => this.rowToFact(row));
  }

  /** Every fact (used for tests / debug / whole-graph views). */
  public getAllFacts(): WorldFact[] {
    const stmt = this.db.prepare('SELECT entity, relation, encrypted_value, source_worker, timestamp FROM facts ORDER BY entity ASC, relation ASC');
    return (stmt.all() as any[]).map((row) => this.rowToFact(row));
  }

  /**
   * A compact, human/LLM-readable fact block for T1/T2 planning. When `entities`
   * is given, only facts about those entities are included; otherwise all facts.
   * Returns '' when there are none so callers can fall back to the linear log.
   */
  public getFormattedFacts(entities?: string[]): string {
    const facts = entities && entities.length > 0 ? this.getFactsForEntities(entities) : this.getAllFacts();
    if (facts.length === 0) return '';
    return facts.map((f) => `- ${f.entity} ${f.relation} ${f.value}`).join('\n');
  }

  /**
   * A compact knowledge block for T1/T2 planning. When `prompt` is given, facts
   * whose entity/relation/value mention a prompt token are preferred (relevance
   * filter); otherwise, or when nothing matches, all facts are used (capped at
   * `limit`). Returns '' when there are no facts, so the caller can fall back to
   * the raw linear log — this replaces replaying the whole log during planning.
   */
  public getFormattedKnowledge(prompt?: string, limit = 40): string {
    const all = this.getAllFacts();
    if (all.length === 0) return '';
    let selected = all;
    if (prompt && prompt.trim()) {
      const tokens = Array.from(new Set(prompt.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []));
      if (tokens.length > 0) {
        const matched = all.filter((f) => {
          const hay = `${f.entity} ${f.relation} ${f.value}`.toLowerCase();
          return tokens.some((t) => hay.includes(t));
        });
        if (matched.length > 0) selected = matched;
      }
    }
    return selected.slice(0, limit).map((f) => `- ${f.entity} ${f.relation} ${f.value}`).join('\n');
  }

  /**
   * Delete one fact by its (normalized) entity + relation key. Returns whether
   * a row was actually removed. Powers the desktop Knowledge tab's per-fact
   * delete — users can prune what the planner remembers about their project.
   */
  public deleteFact(entity: string, relation: string): boolean {
    const e = normalizeKey(entity);
    const r = normalizeKey(relation);
    if (!e || !r) return false;
    // Archive the value before removing it so a deletion is recoverable.
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.archiveCurrentFact(e, r, 'delete', now);
      return this.db.prepare('DELETE FROM facts WHERE entity = ? AND relation = ?').run(e, r);
    });
    return tx().changes > 0;
  }

  /** Delete every fact. Returns how many were removed. History is preserved. */
  public clearFacts(): number {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare('SELECT entity, relation, encrypted_value, source_worker, timestamp FROM facts')
        .all() as Array<{ entity: string; relation: string; encrypted_value: string; source_worker: string; timestamp: string }>;
      const archive = this.db.prepare(
        `INSERT INTO facts_history (entity, relation, encrypted_value, source_worker, valid_from, valid_to, change)
         VALUES (?, ?, ?, ?, ?, ?, 'clear')`,
      );
      for (const row of rows) {
        archive.run(row.entity, row.relation, row.encrypted_value, row.source_worker, row.timestamp, now);
      }
      return this.db.prepare('DELETE FROM facts').run().changes;
    });
    return tx();
  }

  // ── History + restore (undo) ──────────────────

  /**
   * Prior values for one (entity, relation), newest-first — the durable trail of
   * what this fact used to be before it was overwritten or deleted. Decrypted
   * here (the ciphertext never leaves this process).
   */
  public getFactHistory(entity: string, relation: string): Array<{
    value: string; sourceWorker: string; validFrom: string; validTo: string; change: string;
  }> {
    const e = normalizeKey(entity);
    const r = normalizeKey(relation);
    if (!e || !r) return [];
    const rows = this.db
      .prepare(
        `SELECT encrypted_value, source_worker, valid_from, valid_to, change
         FROM facts_history WHERE entity = ? AND relation = ? ORDER BY valid_to DESC, id DESC`,
      )
      .all(e, r) as Array<{ encrypted_value: string; source_worker: string; valid_from: string; valid_to: string; change: string }>;
    return rows.map((row) => {
      let value: string;
      try { value = JSON.parse(this.decrypt(row.encrypted_value)).value; } catch { value = '[Decryption Failed]'; }
      return { value, sourceWorker: row.source_worker, validFrom: row.valid_from, validTo: row.valid_to, change: row.change };
    });
  }

  /**
   * Restore a historical value for (entity, relation) as the current fact. The
   * value currently in place (if any) is itself archived first, so restore is
   * undoable. When `validFrom` is given, restores that exact historical entry;
   * otherwise restores the most recent one. Returns whether anything was restored.
   */
  public restoreFact(entity: string, relation: string, validFrom?: string): boolean {
    const e = normalizeKey(entity);
    const r = normalizeKey(relation);
    if (!e || !r) return false;
    const row = (validFrom
      ? this.db.prepare(
          `SELECT encrypted_value, source_worker FROM facts_history
           WHERE entity = ? AND relation = ? AND valid_from = ? ORDER BY id DESC LIMIT 1`,
        ).get(e, r, validFrom)
      : this.db.prepare(
          `SELECT encrypted_value, source_worker FROM facts_history
           WHERE entity = ? AND relation = ? ORDER BY valid_to DESC, id DESC LIMIT 1`,
        ).get(e, r)) as { encrypted_value: string; source_worker: string } | undefined;
    if (!row) return false;
    let value: string;
    try { value = JSON.parse(this.decrypt(row.encrypted_value)).value; } catch { return false; }
    // Route through upsertFact so the current value is archived and normal
    // change-detection applies (a no-op restore of the same value is harmless).
    this.upsertFact(e, r, value, `${row.source_worker} (restored)`);
    return true;
  }

  // ── Export / Import ──────────────────────────
  //
  //  Knowledge travels DECRYPTED in the export bundle (a portable plaintext
  //  JSON file — the encryption key never leaves this machine) and re-encrypts
  //  with the LOCAL key on import.

  public exportKnowledge(): { facts: WorldFact[]; worldLog: WorldStateEntry[] } {
    return { facts: this.getAllFacts(), worldLog: this.getAllEntries() };
  }

  /**
   * Merge imported knowledge. Facts upsert on (entity, relation) with
   * newer-timestamp-wins (a local fact newer than the imported one is kept);
   * log entries append with fresh ids, skipping exact duplicates
   * (worker + timestamp + summary). Returns counts of what actually landed.
   */
  public importKnowledge(data: {
    facts?: Array<{ entity?: string; relation?: string; value?: string; sourceWorker?: string; timestamp?: string }>;
    worldLog?: Array<{ workerId?: string; summary?: string; timestamp?: string }>;
  }): { facts: number; logEntries: number } {
    let facts = 0;
    let logEntries = 0;

    if (Array.isArray(data.facts)) {
      const local = new Map(this.getAllFacts().map((f) => [`${f.entity} ${f.relation}`, f.timestamp]));
      for (const f of data.facts) {
        if (!f || typeof f.entity !== 'string' || typeof f.relation !== 'string' || typeof f.value !== 'string') continue;
        const key = `${normalizeKey(f.entity)} ${normalizeKey(f.relation)}`;
        const localTs = local.get(key);
        const importTs = f.timestamp ?? new Date().toISOString();
        if (localTs && localTs >= importTs) continue; // local fact is newer — keep it
        this.upsertFact(f.entity, f.relation, f.value, f.sourceWorker ?? 'imported', importTs);
        facts++;
      }
    }

    if (Array.isArray(data.worldLog)) {
      const seen = new Set(this.getAllEntries().map((e) => `${e.workerId} ${e.timestamp} ${e.summary}`));
      const stmt = this.db.prepare('INSERT INTO world_state (id, timestamp, worker_id, encrypted_payload) VALUES (?, ?, ?, ?)');
      for (const e of data.worldLog) {
        if (!e || typeof e.summary !== 'string') continue;
        const workerId = e.workerId ?? 'imported';
        const timestamp = e.timestamp ?? new Date().toISOString();
        const key = `${workerId} ${timestamp} ${e.summary}`;
        if (seen.has(key)) continue;
        stmt.run(crypto.randomUUID(), timestamp, workerId, this.encrypt(JSON.stringify({ summary: e.summary })));
        seen.add(key);
        logEntries++;
      }
    }

    return { facts, logEntries };
  }

  private dumpDebugIfNeeded(): void {
    if (!this.debugMode) return;
    
    try {
      const dumpPath = path.join(os.tmpdir(), 'cascade_world_state_debug.json');
      const entries = this.getAllEntries();
      fs.writeFileSync(dumpPath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to dump debug world state', err);
    }
  }

  public close(): void {
    this.db.close();
  }
}
