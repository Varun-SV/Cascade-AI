// ─────────────────────────────────────────────
//  Cascade AI — Global credentials store
// ─────────────────────────────────────────────
//
//  Provider credentials (API keys, Azure deployments, custom endpoints) live in
//  ONE machine-global file — `~/.cascade-ai/credentials.json`, chmod 600 — the
//  same pattern as Claude Code's ~/.claude/.credentials.json or the gh CLI.
//
//  Why: keys used to exist only in the per-workspace `.cascade/config.json`, so
//  switching the desktop app (or CLI) to a different folder silently "forgot"
//  every key. Now ConfigManager merges this file into whatever workspace config
//  it loads, and syncs credential-bearing entries back on every save — enter a
//  key once, keep it everywhere. A workspace config that carries its own key
//  for a provider still wins (per-project override).

import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig } from '../types.js';
import { GLOBAL_CREDENTIALS_FILE } from '../constants.js';

interface CredentialsFile {
  version: 1;
  providers: ProviderConfig[];
}

export function credentialsPath(globalDir: string): string {
  return path.join(globalDir, GLOBAL_CREDENTIALS_FILE);
}

/**
 * Identity of a provider entry for merge purposes. Azure supports multiple
 * deployments, so its entries are keyed by deployment (name, else endpoint,
 * else label); every other provider type is a singleton keyed by type.
 */
function providerKey(p: ProviderConfig): string {
  if (p.type === 'azure') {
    return `azure:${p.deploymentName ?? p.baseUrl ?? p.label ?? ''}`;
  }
  return p.type;
}

/** An entry is worth persisting globally if it carries a credential or endpoint. */
function isPersistable(p: ProviderConfig): boolean {
  return Boolean(p.apiKey || p.authToken || p.type === 'azure' || p.baseUrl);
}

/** Read the global credentials file. Missing or corrupt → empty list (never throws). */
export function loadGlobalCredentials(globalDir: string): ProviderConfig[] {
  try {
    const raw = fs.readFileSync(credentialsPath(globalDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
    if (!Array.isArray(parsed.providers)) return [];
    return parsed.providers.filter(
      (p): p is ProviderConfig => Boolean(p) && typeof (p as { type?: unknown }).type === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Write the credential-bearing provider entries to the global file
 * (0600, directory 0700, atomic tmp+rename). The given list is authoritative:
 * ConfigManager merges the global file into its config at load time, so by
 * save time the config's providers are a superset of the global entries minus
 * anything the user explicitly removed — meaning removal sticks too.
 */
export function saveGlobalCredentials(globalDir: string, providers: ProviderConfig[]): void {
  const filePath = credentialsPath(globalDir);
  fs.mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  const body: CredentialsFile = { version: 1, providers: providers.filter(isPersistable) };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  // rename preserves the tmp file's 0600; chmod again defensively in case an
  // older file existed with looser permissions.
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
}

/**
 * Merge global credentials into a workspace's provider list.
 *
 * - A global entry with no workspace counterpart is appended.
 * - A workspace entry missing its key (or endpoint) is filled from the global
 *   entry for the same provider.
 * - A workspace entry that has its own key keeps it (per-project override).
 */
export function mergeGlobalCredentials(
  workspaceProviders: ProviderConfig[],
  globalProviders: ProviderConfig[],
): ProviderConfig[] {
  const merged = [...workspaceProviders];
  const byKey = new Map(merged.map((p) => [providerKey(p), p]));

  for (const g of globalProviders) {
    const existing = byKey.get(providerKey(g));
    if (!existing) {
      merged.push({ ...g });
      byKey.set(providerKey(g), merged[merged.length - 1]!);
      continue;
    }
    if (!existing.apiKey && g.apiKey) existing.apiKey = g.apiKey;
    if (!existing.authToken && g.authToken) existing.authToken = g.authToken;
    if (!existing.baseUrl && g.baseUrl) existing.baseUrl = g.baseUrl;
    if (!existing.apiVersion && g.apiVersion) existing.apiVersion = g.apiVersion;
    if (!existing.label && g.label) existing.label = g.label;
  }
  return merged;
}
