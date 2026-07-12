import type { CloudConversation, CloudMessage, CloudUser } from './types.js';

export interface CloudConfig {
  githubEnabled: boolean;
  googleEnabled: boolean;
  googleClientId: string | null;
  devLoginEnabled: boolean;
}

async function json<T>(fetchPromise: Promise<Response>): Promise<T> {
  const res = await fetchPromise;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchConfig(): Promise<CloudConfig> {
  return json(fetch('/api/config', { credentials: 'include' }));
}

export function fetchMe(): Promise<{ user: CloudUser | null }> {
  return json(fetch('/api/me', { credentials: 'include' }));
}

export function logout(): Promise<{ ok: boolean }> {
  return json(fetch('/auth/logout', { method: 'POST', credentials: 'include' }));
}

export function devLogin(name: string): Promise<{ user: CloudUser }> {
  return json(
    fetch('/auth/dev-login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
}

export function listConversations(): Promise<{ conversations: CloudConversation[] }> {
  return json(fetch('/api/conversations', { credentials: 'include' }));
}

export function getMessages(conversationId: string): Promise<{ messages: CloudMessage[] }> {
  return json(fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { credentials: 'include' }));
}

export interface UsageInfo {
  plan: string;
  dailyRuns: number;
  dailyRunLimit: number;
  maxConcurrentRuns: number;
}

export function fetchUsage(): Promise<UsageInfo> {
  return json(fetch('/api/usage', { credentials: 'include' }));
}
