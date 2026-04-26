// ─────────────────────────────────────────────
//  Cascade AI — Constants
// ─────────────────────────────────────────────

import type { ModelInfo, ProviderType, ThemeName } from './types.js';

export const CASCADE_VERSION = '0.5.1';
export const CASCADE_CONFIG_DIR = '.cascade';
export const CASCADE_MD_FILE = 'CASCADE.md';
export const CASCADE_IGNORE_FILE = '.cascadeignore';
export const CASCADE_CONFIG_FILE = '.cascade/config.json';
export const CASCADE_KEYSTORE_FILE = '.cascade/keystore.enc';
export const CASCADE_AUDIT_FILE = '.cascade/audit.log';
export const CASCADE_DB_FILE = '.cascade/memory.db';
export const CASCADE_DASHBOARD_SECRET_FILE = '.cascade/dashboard-secret';

export const GLOBAL_CONFIG_DIR = '.cascade-ai';
export const GLOBAL_DB_FILE = 'memory.db';
export const GLOBAL_KEYSTORE_FILE = 'keystore.enc';
export const GLOBAL_RUNTIME_DB_FILE = 'runtime.db';

export const DEFAULT_DASHBOARD_PORT = 4891;
export const DEFAULT_API_PORT = 4892;
export const DEFAULT_CONTEXT_LIMIT = 200_000;
export const DEFAULT_AUTO_SUMMARIZE_AT = 150_000;
export const DEFAULT_MAX_SESSION_MESSAGES = 1000;
export const DEFAULT_RETENTION_DAYS = 90;

// ── Model Catalogue ───────────────────────────

export const MODELS: Record<string, ModelInfo> = {
  // Anthropic
  'claude-opus-4': {
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    contextWindow: 200_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.015,
    outputCostPer1kTokens: 0.075,
    maxOutputTokens: 32_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-sonnet-4': {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    contextWindow: 200_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.003,
    outputCostPer1kTokens: 0.015,
    maxOutputTokens: 16_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-haiku-3-5': {
    id: 'claude-haiku-3-5-20251001',
    name: 'Claude Haiku 3.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0008,
    outputCostPer1kTokens: 0.004,
    maxOutputTokens: 8_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0008,
    outputCostPer1kTokens: 0.004,
    maxOutputTokens: 8_000,
    supportsStreaming: true,
    isLocal: false,
  },
  // OpenAI
  'gpt-4o': {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.005,
    outputCostPer1kTokens: 0.015,
    maxOutputTokens: 16_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.0006,
    maxOutputTokens: 16_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-4.1': {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    provider: 'openai',
    contextWindow: 1_047_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.002,
    outputCostPer1kTokens: 0.008,
    maxOutputTokens: 32_768,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-4.1-mini': {
    id: 'gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    provider: 'openai',
    contextWindow: 1_047_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0004,
    outputCostPer1kTokens: 0.0016,
    maxOutputTokens: 32_768,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-4.1-nano': {
    id: 'gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    provider: 'openai',
    contextWindow: 1_047_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0001,
    outputCostPer1kTokens: 0.0004,
    maxOutputTokens: 32_768,
    supportsStreaming: true,
    isLocal: false,
  },
  // Google
  'gemini-2.0-flash': {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'gemini',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0001,
    outputCostPer1kTokens: 0.0004,
    maxOutputTokens: 8_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-1.5-pro': {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    provider: 'gemini',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00125,
    outputCostPer1kTokens: 0.005,
    maxOutputTokens: 8_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-2.0-flash-lite': {
    id: 'gemini-2.0-flash-lite',
    name: 'Gemini 2.0 Flash-Lite',
    provider: 'gemini',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00005,
    outputCostPer1kTokens: 0.0002,
    maxOutputTokens: 8_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro-preview-05-06',
    name: 'Gemini 2.5 Pro',
    provider: 'gemini',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00125,
    outputCostPer1kTokens: 0.01,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash-preview-04-17',
    name: 'Gemini 2.5 Flash',
    provider: 'gemini',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.0006,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  // Local (Ollama)
  'llama3.2:3b': {
    id: 'llama3.2:3b',
    name: 'Llama 3.2 3B',
    provider: 'ollama',
    contextWindow: 128_000,
    isVisionCapable: false,
    inputCostPer1kTokens: 0,
    outputCostPer1kTokens: 0,
    maxOutputTokens: 4_000,
    supportsStreaming: true,
    isLocal: true,
    minSizeB: 3,
  },
  'llama3:70b': {
    id: 'llama3:70b',
    name: 'Llama 3 70B',
    provider: 'ollama',
    contextWindow: 128_000,
    isVisionCapable: false,
    inputCostPer1kTokens: 0,
    outputCostPer1kTokens: 0,
    maxOutputTokens: 8_000,
    supportsStreaming: true,
    isLocal: true,
    minSizeB: 70,
  },
  'mistral:7b': {
    id: 'mistral:7b',
    name: 'Mistral 7B',
    provider: 'ollama',
    contextWindow: 32_000,
    isVisionCapable: false,
    inputCostPer1kTokens: 0,
    outputCostPer1kTokens: 0,
    maxOutputTokens: 4_000,
    supportsStreaming: true,
    isLocal: true,
    minSizeB: 7,
  },
  'llava': {
    id: 'llava',
    name: 'LLaVA (Vision)',
    provider: 'ollama',
    contextWindow: 4_096,
    isVisionCapable: true,
    inputCostPer1kTokens: 0,
    outputCostPer1kTokens: 0,
    maxOutputTokens: 2_000,
    supportsStreaming: true,
    isLocal: true,
    minSizeB: 7,
  },
};

// ── Tier Model Priority Chains ─────────────────

export const T1_MODEL_PRIORITY: string[] = [
  'claude-opus-4',
  'claude-sonnet-4',
  'gemini-2.5-pro',
  'gpt-4.1',
  'gpt-4o',
  'gemini-1.5-pro',
];

export const T2_MODEL_PRIORITY: string[] = [
  'claude-sonnet-4',
  'claude-haiku-4-5',
  'claude-haiku-3-5',
  'gemini-2.5-flash',
  'gpt-4.1-mini',
  'gpt-4o-mini',
  'gemini-2.0-flash',
  'llama3:70b',
];

export const T3_MODEL_PRIORITY: string[] = [
  'llama3.2:3b',
  'mistral:7b',
  'claude-haiku-4-5',
  'claude-haiku-3-5',
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

export const VISION_MODEL_PRIORITY: string[] = [
  'claude-sonnet-4',
  'gpt-4o',
  'gemini-2.0-flash',
  'llava',
];

// ── Complexity → T2 count ──────────────────────

export const COMPLEXITY_T2_COUNT: Record<string, [number, number]> = {
  Simple: [1, 1],
  Moderate: [2, 3],
  Complex: [3, 5],
  'Highly Complex': [5, 8],
};

// ── Themes ────────────────────────────────────

export const THEME_NAMES: ThemeName[] = ['cascade', 'dark', 'light', 'dracula', 'nord', 'solarized'];
export const DEFAULT_THEME: ThemeName = 'cascade';

// ── Provider Endpoints ────────────────────────

export const OLLAMA_BASE_URL = 'http://localhost:11434';
export const LM_STUDIO_BASE_URL = 'http://localhost:1234';
export const AZURE_BASE_URL_TEMPLATE = 'https://{resource}.openai.azure.com';

// ── Slash Commands ────────────────────────────
// Command definitions live in src/cli/slash/index.ts.

// ── Tool Names ────────────────────────────────

export const TOOL_NAMES = {
  SHELL: 'shell',
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  FILE_EDIT: 'file_edit',
  FILE_DELETE: 'file_delete',
  FILE_LIST: 'file_list',
  GIT: 'git',
  GITHUB: 'github',
  BROWSER: 'browser',
  IMAGE_ANALYZE: 'image_analyze',
  PDF_CREATE: 'pdf_create',
  RUN_CODE: 'run_code',
  PEER_MESSAGE: 'peer_message',
  WEB_SEARCH: 'web_search',
} as const;

// Defaults that require approval
export const DEFAULT_APPROVAL_REQUIRED = [
  TOOL_NAMES.SHELL,
  TOOL_NAMES.FILE_DELETE,
  TOOL_NAMES.FILE_WRITE,
  TOOL_NAMES.BROWSER,
  TOOL_NAMES.GITHUB,
  'pdf_create',
  'run_code',
];

// ── Provider Names ────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  azure: 'Azure OpenAI',
  'openai-compatible': 'OpenAI-Compatible',
  ollama: 'Ollama (Local)',
};
