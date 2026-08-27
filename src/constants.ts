// ─────────────────────────────────────────────
//  Cascade AI — Constants
// ─────────────────────────────────────────────

import type { ModelInfo, ProviderType, ThemeName } from './types.js';
import { resolvePricing } from './core/router/pricing.js';

// Injected at build time from package.json via tsup's `define` (see tsup.config.ts),
// so the compiled bundle's version can never drift from the published package again.
// The fallback applies only when running the un-bundled source directly (tests, tsx),
// and is kept in step with package.json.
export const CASCADE_VERSION = process.env.CASCADE_BUILD_VERSION ?? '0.12.18';
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
/** Machine-global provider credentials (API keys, Azure deployments) — chmod 600. */
export const GLOBAL_CREDENTIALS_FILE = 'credentials.json';
export const GLOBAL_RUNTIME_DB_FILE = 'runtime.db';

export const DEFAULT_DASHBOARD_PORT = 4891;
export const DEFAULT_API_PORT = 4892;
export const DEFAULT_CONTEXT_LIMIT = 200_000;
export const DEFAULT_AUTO_SUMMARIZE_AT = 150_000;
export const DEFAULT_MAX_SESSION_MESSAGES = 1000;
export const DEFAULT_RETENTION_DAYS = 90;

// ── Model Catalogue ───────────────────────────
//
// This is the ACTIVE cloud fallback catalogue, not a historical ledger. Provider
// discovery remains authoritative when it succeeds; this list exists so settings
// and offline/failure paths still know the current model capabilities. Retired or
// deprecated ids belong in pricing-data.json only when historical spend needs to
// remain resolvable — they must not be advertised as selectable models here.
//
// Pricing below is only a readable offline seed. core/router/pricing-data.json is
// authoritative and overwrites it by MODEL × PROVIDER (× region where relevant).

export const MODELS: Record<string, ModelInfo> = {
  // Anthropic — active Claude API models (2026-08-27).
  'claude-fable-5': {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.01,
    outputCostPer1kTokens: 0.05,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-opus-5': {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.005,
    outputCostPer1kTokens: 0.025,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-opus-4-8': {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.005,
    outputCostPer1kTokens: 0.025,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.005,
    outputCostPer1kTokens: 0.025,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.005,
    outputCostPer1kTokens: 0.025,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-opus-4-5': {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.005,
    outputCostPer1kTokens: 0.025,
    maxOutputTokens: 64_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.002,
    outputCostPer1kTokens: 0.01,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.003,
    outputCostPer1kTokens: 0.015,
    maxOutputTokens: 64_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-sonnet-4-5': {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.003,
    outputCostPer1kTokens: 0.015,
    maxOutputTokens: 64_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.001,
    outputCostPer1kTokens: 0.005,
    maxOutputTokens: 64_000,
    supportsStreaming: true,
    isLocal: false,
  },

  // OpenAI — active chat-capable models used by Cascade's Chat Completions path.
  'gpt-5.6-sol': {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    provider: 'openai',
    contextWindow: 1_050_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.004,
    outputCostPer1kTokens: 0.02,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5.6-terra': {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    provider: 'openai',
    contextWindow: 1_050_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.002,
    outputCostPer1kTokens: 0.012,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5.6-luna': {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    provider: 'openai',
    contextWindow: 1_050_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0002,
    outputCostPer1kTokens: 0.0012,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5.5': {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    provider: 'openai',
    contextWindow: 1_050_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.005,
    outputCostPer1kTokens: 0.03,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5.4': {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    provider: 'openai',
    contextWindow: 1_050_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0025,
    outputCostPer1kTokens: 0.015,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    provider: 'openai',
    contextWindow: 400_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00075,
    outputCostPer1kTokens: 0.0045,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5.4-nano': {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    provider: 'openai',
    contextWindow: 400_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0002,
    outputCostPer1kTokens: 0.00125,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5.2': {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    provider: 'openai',
    contextWindow: 400_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00175,
    outputCostPer1kTokens: 0.014,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5': {
    id: 'gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    contextWindow: 400_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00125,
    outputCostPer1kTokens: 0.01,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5-mini': {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    provider: 'openai',
    contextWindow: 400_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00025,
    outputCostPer1kTokens: 0.002,
    maxOutputTokens: 128_000,
    supportsStreaming: true,
    isLocal: false,
  },
  'gpt-5-nano': {
    id: 'gpt-5-nano',
    name: 'GPT-5 Nano',
    provider: 'openai',
    contextWindow: 400_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00005,
    outputCostPer1kTokens: 0.0004,
    maxOutputTokens: 128_000,
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
  'gpt-4o': {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0025,
    outputCostPer1kTokens: 0.01,
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

  // Google Gemini — active GA + preview chat models. Gemini 2.0/1.5 are no
  // longer advertised because the Gemini API shut those generations down.
  'gemini-3.7-flash': {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00075,
    outputCostPer1kTokens: 0.00375,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-3.6-flash': {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00075,
    outputCostPer1kTokens: 0.00375,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-3.5-flash': {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0015,
    outputCostPer1kTokens: 0.009,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0003,
    outputCostPer1kTokens: 0.0025,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash-Lite',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00025,
    outputCostPer1kTokens: 0.0015,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-3.1-pro-preview': {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.002,
    outputCostPer1kTokens: 0.012,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-3-flash-preview': {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0005,
    outputCostPer1kTokens: 0.003,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.00125,
    outputCostPer1kTokens: 0.01,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0003,
    outputCostPer1kTokens: 0.0025,
    maxOutputTokens: 65_536,
    supportsStreaming: true,
    isLocal: false,
  },
  'gemini-2.5-flash-lite': {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    provider: 'gemini',
    contextWindow: 1_048_576,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.0001,
    outputCostPer1kTokens: 0.0004,
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

// Make tool-capability explicit for every catalog model so the agent loop's
// native-vs-text decision is intentional rather than "undefined ⇒ assume
// native". Cloud models support native function-calling; hardcoded local
// entries fall back to the text-tool emulation path (discovered Ollama models
// get a per-family flag at runtime — see isToolCapable in providers/ollama.ts).
for (const _m of Object.values(MODELS)) {
  if (_m.supportsToolUse === undefined) _m.supportsToolUse = !_m.isLocal;
}

// The pricing dataset (core/router/pricing-data.json) is the authoritative
// baseline, so it overwrites the hand-maintained numbers above wherever it has
// an entry. Anything the dataset doesn't cover keeps its catalogue price rather
// than being zeroed; newly discovered cloud models use withResolvedPricing and
// explicitly report pricingUnknown when no provider-specific row exists.
for (const _m of Object.values(MODELS)) {
  const priced = resolvePricing(_m);
  if (priced.unknown || priced.free || priced.estimatedFromProvider) continue;
  _m.inputCostPer1kTokens = priced.input;
  _m.outputCostPer1kTokens = priced.output;
  _m.pricingUnknown = false;
}

// ── Tier Model Priority Chains ─────────────────
// These are candidate chains, not a declaration that the first item always
// wins: Cascade Auto still scores benchmark quality, observed outcomes and cost.

export const T1_MODEL_PRIORITY: string[] = [
  'gpt-5.6-sol',
  'claude-fable-5',
  'claude-opus-5',
  'gpt-5.5',
  'gpt-5.4',
  'gemini-3.1-pro-preview',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'gemini-3.7-flash',
  'gpt-5.2',
  'gpt-5',
  'gemini-2.5-pro',
  'gpt-4.1',
  'gpt-4o',
];

export const T2_MODEL_PRIORITY: string[] = [
  'gpt-5.6-terra',
  'claude-sonnet-5',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gpt-4.1-mini',
  'gpt-4o-mini',
  'llama3:70b',
];

export const T3_MODEL_PRIORITY: string[] = [
  'gpt-5.6-luna',
  'gpt-5.4-nano',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'claude-haiku-4-5',
  'gpt-5-nano',
  'gemini-2.5-flash-lite',
  'llama3.2:3b',
  'mistral:7b',
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'gemini-2.5-flash',
];

export const VISION_MODEL_PRIORITY: string[] = [
  'gpt-5.6-sol',
  'claude-fable-5',
  'claude-sonnet-5',
  'gemini-3.7-flash',
  'gpt-4o',
  'gemini-2.5-flash',
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
  REQUEST_WORKERS: 'request_workers',
} as const;

// Defaults that require approval.
// NOTE: `ToolRegistry.requiresApproval()` ORs this list together with
// isDangerous() — a tool that self-reports dangerous requires approval
// whether or not it's named here. This list still matters for two reasons:
// (a) it's the CONFIGURABLE surface (users add to `requireApprovalFor` by
// name, which only makes sense against a stable list of built-in names, not
// an internal isDangerous() flag), and (b) it lets a tool require approval
// for policy reasons even if it doesn't consider itself "dangerous". Keep it
// in sync with isDangerous() anyway where you can — file_edit and git were
// once omitted here, so the agent could rewrite files in place (file_edit)
// or push/checkout/commit (git) with no prompt while file_write/file_delete
// required one; isDangerous() alone wasn't consulted at the time, so that
// gap went unnoticed until it was reported directly.
export const DEFAULT_APPROVAL_REQUIRED = [
  TOOL_NAMES.SHELL,
  TOOL_NAMES.FILE_DELETE,
  TOOL_NAMES.FILE_WRITE,
  TOOL_NAMES.FILE_EDIT,
  TOOL_NAMES.GIT,
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
