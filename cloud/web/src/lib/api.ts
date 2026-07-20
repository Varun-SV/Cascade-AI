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

// ── Key sync (E2E-encrypted settings relay) ──
// `blob` is opaque ciphertext ({ ciphertext, salt, iv } base64) — the server
// stores and returns it verbatim and cannot decrypt it. See docs/key-sync.md.

export interface KeySyncBlob { ciphertext: string; salt: string; iv: string }

export function pullKeySync(): Promise<{ blob: KeySyncBlob | null; version?: number; updatedAt?: number }> {
  return json(fetch('/api/keysync', { credentials: 'include' }));
}

export function pushKeySync(blob: KeySyncBlob): Promise<{ ok: boolean; version: number; updatedAt: number }> {
  return json(fetch('/api/keysync', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blob }),
  }));
}

/** Begin an OAuth "Connect" for an MCP server. `oauth:false` → no OAuth; paste a token. */
export function startMcpOAuth(payload: { connectorId?: string; name?: string; url?: string }): Promise<{ oauth: boolean; authorizeUrl?: string }> {
  return json(fetch('/api/mcp/oauth/start', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
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

export function renameConversation(id: string, title: string): Promise<{ ok: boolean; title: string }> {
  return json(
    fetch(`/api/conversations/${encodeURIComponent(id)}/title`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  );
}

export function fetchSkills(): Promise<{ skills: Skill[] }> {
  return json(fetch('/api/skills', { credentials: 'include' }));
}

export interface SkillInput {
  name: string;
  description: string;
  systemPrompt: string;
}

export function createSkill(input: SkillInput): Promise<{ skill: Skill }> {
  return json(
    fetch('/api/skills', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export function updateSkill(id: string, input: SkillInput): Promise<{ skill: Skill }> {
  return json(
    fetch(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export function deleteSkill(id: string): Promise<{ ok: boolean }> {
  return json(fetch(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }));
}

export function fetchTierMix(): Promise<{ mix: Array<{ tier: string; count: number }> }> {
  return json(fetch('/api/tier-mix', { credentials: 'include' }));
}

export function fetchMemories(): Promise<{ memories: Memory[] }> {
  return json(fetch('/api/memories', { credentials: 'include' }));
}

export function addMemory(content: string, category?: string | null): Promise<{ memory: Memory }> {
  return json(
    fetch('/api/memories', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, category: category ?? null }),
    }),
  );
}

export function updateMemory(id: string, content: string, category?: string | null): Promise<{ memory: Memory }> {
  return json(
    fetch(`/api/memories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, category: category ?? null }),
    }),
  );
}

export function deleteMemory(id: string): Promise<{ ok: boolean }> {
  return json(fetch(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }));
}

export interface UploadResult {
  id: string;
  mime: string;
  kind?: 'image' | 'document';
  filename?: string | null;
  charCount?: number | null;
  truncated?: boolean;
}

/** Uploads one image and returns its server id (referenced later in chat:run). */
export function uploadImage(mime: string, dataBase64: string): Promise<UploadResult> {
  return json(
    fetch('/api/uploads', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mime, dataBase64 }),
    }),
  );
}

/** Uploads one document (PDF/DOCX/text). The server parses it to text at upload
 *  and returns its id + extracted-char count (referenced later in chat:run). */
export function uploadDocument(mime: string, dataBase64: string, filename: string): Promise<UploadResult> {
  return json(
    fetch('/api/uploads', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mime, dataBase64, filename }),
    }),
  );
}

/** Owner-scoped URL for rendering a previously-uploaded image in the transcript. */
export function uploadUrl(id: string): string {
  return `/api/uploads/${encodeURIComponent(id)}`;
}

// ── Remote MCP servers & connectors ──

export interface ConnectorEntry {
  id: string;
  name: string;
  description: string;
  url?: string;
  authHeader: string;
  authPrefix: string;
  tokenLabel: string;
  docsUrl: string;
  requiresUrl: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  hasAuth: boolean;
  connectorId: string | null;
  enabled: boolean;
  createdAt: number;
}

export function fetchConnectors(): Promise<{ connectors: ConnectorEntry[] }> {
  return json(fetch('/api/mcp/connectors', { credentials: 'include' }));
}

export function fetchMcpServers(): Promise<{ servers: McpServer[] }> {
  return json(fetch('/api/mcp/servers', { credentials: 'include' }));
}

export function addMcpServer(input: {
  name?: string; url?: string; token?: string; authHeader?: string; connectorId?: string;
}): Promise<{ server: McpServer }> {
  return json(
    fetch('/api/mcp/servers', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export function setMcpServerEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }> {
  return json(
    fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  );
}

export function deleteMcpServer(id: string): Promise<{ ok: boolean }> {
  return json(fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }));
}

export interface BillingInfo {
  configured: boolean;
  keyId: string | null;
  priceLabel: string | null;
  plan: string;
  status: string | null;
  currentEnd: number | null;
  hasSubscription: boolean;
}

export function fetchBilling(): Promise<BillingInfo> {
  return json(fetch('/api/billing', { credentials: 'include' }));
}

export function startSubscription(): Promise<{ subscriptionId: string; keyId: string }> {
  return json(fetch('/api/billing/subscribe', { method: 'POST', credentials: 'include' }));
}

export function cancelSubscription(): Promise<{ ok: boolean }> {
  return json(fetch('/api/billing/cancel', { method: 'POST', credentials: 'include' }));
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

// ── Conversation handoff (open-and-continue, web ↔ desktop) ──

export interface HandoffMessage {
  role: string;
  content: string;
}

export interface HandoffInput {
  title: string | null;
  skillId: string | null;
  messages: HandoffMessage[];
}

/** Snapshot the current transcript into a short-lived code to continue elsewhere. */
export function createHandoff(input: HandoffInput): Promise<{ code: string; expiresAt: number }> {
  return json(
    fetch('/api/handoff', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

/** Redeem a code minted on another surface → its transcript snapshot. */
export function fetchHandoff(
  code: string,
): Promise<{ title: string | null; skillId: string | null; messages: HandoffMessage[]; expiresAt: number }> {
  return json(fetch(`/api/handoff/${encodeURIComponent(code)}`, { credentials: 'include' }));
}

/** Seed a NEW cloud conversation from a redeemed transcript (owner-scoped). */
export function importConversation(
  input: HandoffInput,
): Promise<{ conversation: { id: string; title: string | null; skillId: string | null } }> {
  return json(
    fetch('/api/conversations/import', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}
