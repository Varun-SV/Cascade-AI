import Database, { type Database as SQLiteDatabase } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  eventType: string;
  tierId: string;
  payload: string;
}

export interface AuditChainVerification {
  ok: boolean;
  entries: number;
  /** rowid of the first entry whose hash doesn't match the recomputed chain. */
  firstBadRow?: number;
}

export class AuditLogger {
  private db: SQLiteDatabase;
  private keyPath: string;
  private dbPath: string;
  private encryptionKey!: Buffer;
  
  constructor(private workspacePath: string, private debugMode = false) {
    const cascadeDir = path.join(workspacePath, '.cascade');
    if (!fs.existsSync(cascadeDir)) {
      fs.mkdirSync(cascadeDir, { recursive: true });
    }
    this.keyPath = path.join(cascadeDir, 'audit_log.key');
    this.dbPath = path.join(cascadeDir, 'audit_log.db');
    
    this.initEncryptionKey();
    
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        tier_id TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        prev_hash TEXT NOT NULL DEFAULT '',
        hash TEXT NOT NULL DEFAULT ''
      )
    `);
    // Tamper-evidence columns for DBs created before the hash chain existed.
    const cols = (this.db.pragma('table_info(audit_logs)') as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('prev_hash')) this.db.exec(`ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('hash')) this.db.exec(`ALTER TABLE audit_logs ADD COLUMN hash TEXT NOT NULL DEFAULT ''`);
  }

  /** SHA-256 link over everything that identifies an entry, chained to the previous entry's hash. */
  private chainHash(prevHash: string, timestamp: string, eventType: string, tierId: string, encryptedPayload: string): string {
    return crypto.createHash('sha256')
      .update(`${prevHash}|${timestamp}|${eventType}|${tierId}|${encryptedPayload}`)
      .digest('hex');
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

  public logEvent(eventType: string, tierId: string, payloadObj: unknown): string {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const payload = JSON.stringify(payloadObj);
    const encryptedPayload = this.encrypt(payload);

    // Hash-chain each entry to its predecessor so any later modification or
    // deletion breaks every subsequent hash — verifiable via verifyChain().
    const last = this.db.prepare('SELECT hash FROM audit_logs ORDER BY rowid DESC LIMIT 1').get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? '';
    const hash = this.chainHash(prevHash, timestamp, eventType, tierId, encryptedPayload);

    const stmt = this.db.prepare('INSERT INTO audit_logs (id, timestamp, event_type, tier_id, encrypted_payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
    stmt.run(id, timestamp, eventType, tierId, encryptedPayload, prevHash, hash);

    this.dumpDebugIfNeeded();
    return id;
  }

  /**
   * Recompute the whole hash chain in insertion (rowid) order. Any edited,
   * removed, or reordered row makes every later hash mismatch. Rows written
   * before the chain existed (empty hash) fail verification too — integrity
   * can only be claimed for chained history.
   */
  public verifyChain(): AuditChainVerification {
    const rows = this.db.prepare(
      'SELECT rowid, timestamp, event_type, tier_id, encrypted_payload, prev_hash, hash FROM audit_logs ORDER BY rowid ASC',
    ).all() as Array<{ rowid: number; timestamp: string; event_type: string; tier_id: string; encrypted_payload: string; prev_hash: string; hash: string }>;

    let prevHash = '';
    for (const row of rows) {
      const expected = this.chainHash(prevHash, row.timestamp, row.event_type, row.tier_id, row.encrypted_payload);
      if (row.prev_hash !== prevHash || row.hash !== expected) {
        return { ok: false, entries: rows.length, firstBadRow: row.rowid };
      }
      prevHash = row.hash;
    }
    return { ok: true, entries: rows.length };
  }

  public getAllLogs(): AuditLogEntry[] {
    const stmt = this.db.prepare('SELECT id, timestamp, event_type, tier_id, encrypted_payload FROM audit_logs ORDER BY timestamp ASC');
    const rows = stmt.all() as any[];
    
    return rows.map(row => {
      let payload = '';
      try {
        payload = this.decrypt(row.encrypted_payload);
      } catch (err) {
        payload = '{"error":"[Decryption Failed - Payload Corrupted]"}';
      }
      return {
        id: row.id,
        timestamp: row.timestamp,
        eventType: row.event_type,
        tierId: row.tier_id,
        payload
      };
    });
  }

  private dumpDebugIfNeeded(): void {
    if (!this.debugMode) return;
    try {
      const dumpPath = path.join(os.tmpdir(), 'cascade_audit_logs_debug.json');
      const entries = this.getAllLogs();
      fs.writeFileSync(dumpPath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to dump debug audit logs', err);
    }
  }

  public close(): void {
    this.db.close();
  }
}
