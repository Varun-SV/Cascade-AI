// ─────────────────────────────────────────────
//  Cascade AI — Keystore (keytar primary, AES-256-GCM fallback)
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

const KEYTAR_SERVICE = 'cascade-ai';

type KeytarModule = {
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
  findCredentials: (service: string) => Promise<Array<{ account: string; password: string }>>;
};

async function loadKeytar(): Promise<KeytarModule | null> {
  try {
    // Native module — may fail on headless containers, Alpine, etc.
    const mod = (await import('keytar')) as unknown as KeytarModule | { default: KeytarModule };
    const candidate = (mod as { default?: KeytarModule }).default ?? (mod as KeytarModule);
    if (typeof candidate.getPassword !== 'function') return null;
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Keystore with two backends:
 *  1. OS keychain via `keytar` — preferred when available (macOS Keychain,
 *     Windows Credential Vault, libsecret). No master password required.
 *  2. AES-256-GCM encrypted file — used when keytar is unavailable or the
 *     caller passes `{ forceFile: true }`. Requires a master password.
 *
 * On first successful keytar unlock we silently migrate any existing AES
 * entries into the OS keychain. The AES file is left in place as a backup
 * until the user explicitly deletes it via `cascade keys migrate --confirm`.
 */
export class Keystore {
  private storePath: string;
  private masterKey: Buffer | null = null;
  private keytar: KeytarModule | null = null;
  private cache: Record<string, string> = {};
  private backend: 'keytar' | 'file' | null = null;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  /**
   * Unlock the keystore.
   *
   * If `password` is omitted we try keytar only. If keytar is unavailable and
   * there are AES entries to read, unlock will fail — re-call with a password
   * to decrypt the file backend.
   */
  async unlock(password?: string, opts: { forceFile?: boolean } = {}): Promise<void> {
    if (!opts.forceFile) {
      this.keytar = await loadKeytar();
    }

    if (this.keytar) {
      const creds = await this.keytar.findCredentials(KEYTAR_SERVICE);
      this.cache = Object.fromEntries(creds.map((c) => [c.account, c.password]));
      this.backend = 'keytar';

      if (password && fs.existsSync(this.storePath)) {
        try {
          const fileEntries = this.decryptFile(password);
          for (const [k, v] of Object.entries(fileEntries)) {
            if (!(k in this.cache)) {
              await this.keytar.setPassword(KEYTAR_SERVICE, k, v);
              this.cache[k] = v;
            }
          }
        } catch {
          // Wrong password or no file — ignore; keytar cache is authoritative.
        }
      }
      return;
    }

    // Keytar unavailable — fall back to AES file backend.
    if (!password) {
      throw new Error(
        'Keystore unlock requires a password because the OS keychain (keytar) is not available on this system.',
      );
    }
    if (!fs.existsSync(this.storePath)) {
      const salt = crypto.randomBytes(SALT_LEN);
      this.masterKey = this.deriveKey(password, salt);
      this.writeWithSalt({}, salt);
      this.cache = {};
    } else {
      const { salt } = this.readRaw();
      this.masterKey = this.deriveKey(password, salt);
      this.cache = this.decryptFile(password, salt);
    }
    this.backend = 'file';
  }

  /** Synchronous legacy unlock kept for AES-only environments. */
  unlockSync(password: string): void {
    if (!fs.existsSync(this.storePath)) {
      const salt = crypto.randomBytes(SALT_LEN);
      this.masterKey = this.deriveKey(password, salt);
      this.writeWithSalt({}, salt);
      this.cache = {};
    } else {
      const { salt } = this.readRaw();
      this.masterKey = this.deriveKey(password, salt);
      this.cache = this.decryptFile(password, salt);
    }
    this.backend = 'file';
  }

  lock(): void {
    this.masterKey = null;
    this.cache = {};
    this.backend = null;
    this.keytar = null;
  }

  isUnlocked(): boolean {
    return this.backend !== null;
  }

  /** Report the active backend (`keytar` or `file`) for diagnostics. */
  getBackend(): 'keytar' | 'file' | null {
    return this.backend;
  }

  async set(key: string, value: string): Promise<void> {
    this.assertUnlocked();
    this.cache[key] = value;
    if (this.backend === 'keytar' && this.keytar) {
      await this.keytar.setPassword(KEYTAR_SERVICE, key, value);
      return;
    }
    this.saveAll(this.cache);
  }

  get(key: string): string | undefined {
    this.assertUnlocked();
    return this.cache[key];
  }

  async delete(key: string): Promise<void> {
    this.assertUnlocked();
    delete this.cache[key];
    if (this.backend === 'keytar' && this.keytar) {
      await this.keytar.deletePassword(KEYTAR_SERVICE, key);
      return;
    }
    this.saveAll(this.cache);
  }

  listKeys(): string[] {
    this.assertUnlocked();
    return Object.keys(this.cache);
  }

  // ── Private ──────────────────────────────────

  private assertUnlocked(): void {
    if (this.backend === null) {
      throw new Error('Keystore is locked. Call unlock() first.');
    }
  }

  private decryptFile(password: string, knownSalt?: Buffer): Record<string, string> {
    if (!fs.existsSync(this.storePath)) return {};
    try {
      const { salt, ciphertext, iv, tag } = this.readRaw();
      const useSalt = knownSalt ?? salt;
      const key = this.masterKey ?? this.deriveKey(password, useSalt);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv) as crypto.DecipherGCM;
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf-8')) as Record<string, string>;
    } catch {
      throw new Error('Failed to decrypt keystore. Wrong password?');
    }
  }

  private saveAll(data: Record<string, string>): void {
    if (!this.masterKey) return; // keytar backend — nothing to persist to file
    const raw = this.readRaw();
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv) as crypto.CipherGCM;
    const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const out = Buffer.concat([raw.salt, iv, tag, ciphertext]);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, out, { mode: 0o600 });
  }

  private writeWithSalt(data: Record<string, string>, salt: Buffer): void {
    if (!this.masterKey) throw new Error('writeWithSalt called before masterKey was set');
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv) as crypto.CipherGCM;
    const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const out = Buffer.concat([salt, iv, tag, ciphertext]);
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, out, { mode: 0o600 });
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

  private deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
  }
}
