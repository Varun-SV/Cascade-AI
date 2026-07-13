export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'azure' | 'openai-compatible' | 'ollama';

export interface ProviderConfig {
  type: ProviderType;
  label?: string;
  apiKey?: string;
  baseUrl?: string;
  deploymentName?: string;
  apiVersion?: string;
  model?: string;
}

export interface CloudUser {
  id: string;
  provider: 'github' | 'google' | 'dev';
  providerId: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  plan: string;
  createdAt: number;
}

export interface CloudConversation {
  id: string;
  userId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageAttachment {
  id: string;
  mime: string;
  kind: string;
}

export interface CloudMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  model: string | null;
  tier: string | null;
  /** JSON-encoded WhyReport, or null. Parsed client-side on transcript load. */
  why: string | null;
  costUsd: number | null;
  createdAt: number;
  attachments?: MessageAttachment[];
}

export interface Skill {
  id: string;
  name: string;
  description: string;
}

export interface Memory {
  id: string;
  userId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** Run-explorer report: the decision trail + router economics of one run. */
export interface WhyReport {
  tier: string | null;
  model: string | null;
  decisions: Array<{ at: string; kind: string; detail: string }>;
  savedUsd: number;
  savedPct: number;
  totalCostUsd: number;
  totalTokens: number;
  durationMs: number;
  costByTier: Record<string, number>;
  tokensByTier: Record<string, number>;
  models: Record<string, string>;
}
