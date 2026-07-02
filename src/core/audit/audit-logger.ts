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
        encrypted_payload TEXT NOT NULL
      )
    `);
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

  public logEvent(eventType: string, tierId: string, payloadObj: any): string {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    
    const payload = JSON.stringify(payloadObj);
    const encryptedPayload = this.encrypt(payload);
    
    const stmt = this.db.prepare('INSERT INTO audit_logs (id, timestamp, event_type, tier_id, encrypted_payload) VALUES (?, ?, ?, ?, ?)');
    stmt.run(id, timestamp, eventType, tierId, encryptedPayload);

    this.dumpDebugIfNeeded();
    return id;
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
