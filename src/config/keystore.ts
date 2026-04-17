// ─────────────────────────────────────────────
//  Cascade AI — AES-256-GCM Encrypted Keystore
// ─────────────────────────────────────────────

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_LEN = 32;
const PBKDF2_ITERATIONS = 100_000;

export class Keystore {
  private storePath: string;
  private masterKey: Buffer | null = null;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  unlock(password: string): void {
    if (!fs.existsSync(this.storePath)) {
      // IMPORTANT: derive the master key and persist it against the SAME
      // salt. The previous implementation generated two independent random
      // salts (one for masterKey derivation, one written to disk) which
      // silently corrupted the store — subsequent unlock attempts would
      // derive a different key from the on-disk salt and fail to decrypt.
      const salt = crypto.randomBytes(SALT_LEN);
      this.masterKey = this.deriveKey(password, salt);
      this.writeWithSalt({}, salt);
      return;
    }
    const { salt } = this.readRaw();
    this.masterKey = this.deriveKey(password, salt);
    // Verify by attempting to decrypt
    this.loadAll();
  }

  lock(): void {
    this.masterKey = null;
  }

  isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  set(key: string, value: string): void {
    this.assertUnlocked();
    const all = this.loadAll();
    all[key] = value;
    this.saveAll(all);
  }

  get(key: string): string | undefined {
    this.assertUnlocked();
    return this.loadAll()[key];
  }

  delete(key: string): void {
    this.assertUnlocked();
    const all = this.loadAll();
    delete all[key];
    this.saveAll(all);
  }

  listKeys(): string[] {
    this.assertUnlocked();
    return Object.keys(this.loadAll());
  }

  // ── Private ──────────────────────────────────

  private assertUnlocked(): void {
    if (!this.masterKey) throw new Error('Keystore is locked. Call unlock(password) first.');
  }

  private loadAll(): Record<string, string> {
    if (!fs.existsSync(this.storePath)) return {};
    try {
      const { salt, ciphertext, iv, tag } = this.readRaw();
      const key = this.deriveKey('', salt, this.masterKey!);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv) as crypto.DecipherGCM;
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf-8')) as Record<string, string>;
    } catch {
      throw new Error('Failed to decrypt keystore. Wrong password?');
    }
  }

  private saveAll(data: Record<string, string>): void {
    const raw = this.readRaw();
    const key = this.deriveKey('', raw.salt, this.masterKey!);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;
    const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const out = Buffer.concat([raw.salt, iv, tag, ciphertext]);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, out);
  }

  /**
   * Writes a fresh keystore file using the caller-supplied salt. This is
   * used on first-time unlock to ensure the salt persisted to disk is
   * identical to the one that derived `masterKey`.
   */
  private writeWithSalt(data: Record<string, string>, salt: Buffer): void {
    if (!this.masterKey) throw new Error('writeWithSalt called before masterKey was set');
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv) as crypto.CipherGCM;
    const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const out = Buffer.concat([salt, iv, tag, ciphertext]);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, out);
  }

  private readRaw(): { salt: Buffer; iv: Buffer; tag: Buffer; ciphertext: Buffer } {
    const buf = fs.readFileSync(this.storePath);
    let offset = 0;
    const salt = buf.subarray(offset, offset + SALT_LEN); offset += SALT_LEN;
    const iv = buf.subarray(offset, offset + IV_LEN); offset += IV_LEN;
    const tag = buf.subarray(offset, offset + TAG_LEN); offset += TAG_LEN;
    const ciphertext = buf.subarray(offset);
    return { salt, iv, tag, ciphertext };
  }

  private deriveKey(password: string, salt: Buffer, existingKey?: Buffer): Buffer {
    if (existingKey) return existingKey;
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
  }
}
