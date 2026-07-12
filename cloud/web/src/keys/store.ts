import type { ProviderConfig } from '../lib/types.js';

const STORAGE_KEY = 'cascade-cloud-keys';

/**
 * Keys never leave the browser except as part of a chat:run payload — this
 * is the ONLY place they are persisted. See KeyVault.tsx for the same
 * promise surfaced in the UI copy.
 */
export function loadKeys(): ProviderConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveKeys(keys: ProviderConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}
