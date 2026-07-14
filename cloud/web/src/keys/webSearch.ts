import type { WebSearchSettings } from '../lib/types.js';

const STORAGE_KEY = 'cascade-cloud-web-search';

/** Like the provider keys, this is held only in the browser and travels with a
 *  chat:run payload — never persisted server-side. */
export function loadWebSearch(): WebSearchSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WebSearchSettings;
    return parsed && typeof parsed === 'object' && parsed.backend ? parsed : null;
  } catch {
    return null;
  }
}

export function saveWebSearch(settings: WebSearchSettings | null): void {
  try {
    if (settings) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

/** The subset the server needs, or null when nothing usable is configured. */
export function webSearchPayload(s: WebSearchSettings | null): {
  searxngUrl?: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
} | undefined {
  if (!s) return undefined;
  if (s.backend === 'brave' && s.braveApiKey?.trim()) return { braveApiKey: s.braveApiKey.trim() };
  if (s.backend === 'tavily' && s.tavilyApiKey?.trim()) return { tavilyApiKey: s.tavilyApiKey.trim() };
  if (s.backend === 'searxng' && s.searxngUrl?.trim()) return { searxngUrl: s.searxngUrl.trim() };
  return undefined;
}
