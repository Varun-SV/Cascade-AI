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
    
    return entries.map((e, idx) => `[${e.timestamp}] Step ${idx + 1} (${e.workerId}): ${e.summary}`).join('\\n');
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
