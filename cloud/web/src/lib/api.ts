import type { CloudConversation, CloudMessage, CloudUser, Memory, Skill } from './types.js';

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

export function getMessages(
  conversationId: string,
): Promise<{ conversation?: { id: string; title: string | null; skillId: string | null }; messages: CloudMessage[] }> {
  return json(fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { credentials: 'include' }));
}

export function fetchSkills(): Promise<{ skills: Skill[] }> {
  return json(fetch('/api/skills', { credentials: 'include' }));
}

export function fetchMemories(): Promise<{ memories: Memory[] }> {
  return json(fetch('/api/memories', { credentials: 'include' }));
}

export function addMemory(content: string): Promise<{ memory: Memory }> {
  return json(
    fetch('/api/memories', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
  );
}

export function updateMemory(id: string, content: string): Promise<{ memory: Memory }> {
  return json(
    fetch(`/api/memories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
  );
}

export function deleteMemory(id: string): Promise<{ ok: boolean }> {
  return json(fetch(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }));
}

/** Uploads one image and returns its server id (referenced later in chat:run). */
export function uploadImage(mime: string, dataBase64: string): Promise<{ id: string; mime: string }> {
  return json(
    fetch('/api/uploads', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mime, dataBase64 }),
    }),
  );
}

/** Owner-scoped URL for rendering a previously-uploaded image in the transcript. */
export function uploadUrl(id: string): string {
  return `/api/uploads/${encodeURIComponent(id)}`;
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
