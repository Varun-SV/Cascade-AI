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

export interface CloudMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  model: string | null;
  costUsd: number | null;
  createdAt: number;
}
