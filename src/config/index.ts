// ─────────────────────────────────────────────
//  Cascade AI — Config Manager
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CascadeConfig, Identity } from '../types.js';
import { CascadeConfigSchema } from './schema.js';
import { Keystore } from './keystore.js';
import { CascadeIgnore } from './ignore.js';
import { loadCascadeMd, type CascadeMdContent } from './cascade-md.js';
import { MemoryStore } from '../memory/store.js';
import {
  CASCADE_CONFIG_FILE,
  CASCADE_DB_FILE,
  GLOBAL_CONFIG_DIR,
  GLOBAL_DB_FILE,
  GLOBAL_KEYSTORE_FILE,
} from '../constants.js';

export class ConfigManager {
  private config!: CascadeConfig;
  private keystore!: Keystore;
  private ignore!: CascadeIgnore;
  private store!: MemoryStore;
  private cascadeMd: CascadeMdContent | null = null;
  private workspacePath: string;
  private globalDir: string;

  constructor(workspacePath = process.cwd()) {
    this.workspacePath = workspacePath;
    this.globalDir = path.join(os.homedir(), GLOBAL_CONFIG_DIR);
  }

  async load(): Promise<void> {
    // Load project config (or defaults)
    this.config = await this.loadConfig();

    // Load .cascadeignore
    this.ignore = new CascadeIgnore();
    await this.ignore.load(this.workspacePath);

    // Load CASCADE.md
    this.cascadeMd = await loadCascadeMd(this.workspacePath);

    // Load keystore
    const keystorePath = path.join(this.globalDir, GLOBAL_KEYSTORE_FILE);
    this.keystore = new Keystore(keystorePath);

    // Load memory store
    const dbPath = path.join(this.workspacePath, CASCADE_DB_FILE);
    this.store = new MemoryStore(dbPath);

    // Inject provider API keys from keystore (if unlocked via env)
    await this.injectEnvKeys();

    // Ensure default identity exists
    await this.ensureDefaultIdentity();
  }

  getConfig(): CascadeConfig {
    return this.config;
  }

  getKeystore(): Keystore {
    return this.keystore;
  }

  getIgnore(): CascadeIgnore {
    return this.ignore;
  }

  getStore(): MemoryStore {
    return this.store;
  }

  getCascadeMd(): CascadeMdContent | null {
    return this.cascadeMd;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async save(): Promise<void> {
    const configPath = path.join(this.workspacePath, CASCADE_CONFIG_FILE);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  async updateConfig(updates: Partial<CascadeConfig>): Promise<void> {
    this.config = { ...this.config, ...updates };
    await this.save();
  }

  // ── Provider keys (reads from env or keystore) ──

  getApiKey(provider: string): string | undefined {
    const envMap: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GOOGLE_API_KEY',
      azure: 'AZURE_OPENAI_KEY',
    };
    const envKey = envMap[provider];
    if (envKey && process.env[envKey]) return process.env[envKey];
    if (this.keystore.isUnlocked()) return this.keystore.get(`provider:${provider}`);
    return undefined;
  }

  // ── Private ──────────────────────────────────

  private async loadConfig(): Promise<CascadeConfig> {
    const configPath = path.join(this.workspacePath, CASCADE_CONFIG_FILE);
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return CascadeConfigSchema.parse(parsed);
    } catch {
      return CascadeConfigSchema.parse({});
    }
  }

  private async injectEnvKeys(): Promise<void> {
    const envProviders: Array<{ env: string; type: CascadeConfig['providers'][0]['type'] }> = [
      { env: 'ANTHROPIC_API_KEY', type: 'anthropic' },
      { env: 'OPENAI_API_KEY', type: 'openai' },
      { env: 'GOOGLE_API_KEY', type: 'gemini' },
      { env: 'AZURE_OPENAI_KEY', type: 'azure' },
    ];

    for (const { env, type } of envProviders) {
      const key = process.env[env];
      if (!key) continue;
      const existing = this.config.providers.find((p) => p.type === type);
      if (!existing) {
        this.config.providers.push({ type, apiKey: key });
      } else if (!existing.apiKey) {
        existing.apiKey = key;
      }
    }

    // Ollama: add if not configured but reachable
    if (!this.config.providers.find((p) => p.type === 'ollama')) {
      this.config.providers.push({ type: 'ollama' });
    }
  }

  private async ensureDefaultIdentity(): Promise<void> {
    const existing = this.store.getDefaultIdentity();
    if (existing) return;

    const identity: Identity = {
      id: randomUUID(),
      name: 'Default',
      description: 'Default Cascade identity',
      createdAt: new Date().toISOString(),
      isDefault: true,
    };
    this.store.createIdentity(identity);
    this.config.defaultIdentityId = identity.id;
  }
}
