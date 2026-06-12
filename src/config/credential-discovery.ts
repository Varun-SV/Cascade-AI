// ─────────────────────────────────────────────
//  Cascade AI — Credential Discovery
// ─────────────────────────────────────────────
//
//  Detects credentials the user already has on this machine from other
//  AI CLIs (Claude Code, OpenAI Codex, Gemini CLI, GitHub Copilot) plus
//  the standard provider env vars, so `cascade link` / `cascade init` can
//  reuse them instead of asking the user to paste keys again.
//
//  ⚠ Reusing another tool's stored credential — especially a subscription
//  OAuth token (Claude Code, ChatGPT, Copilot) — outside that tool may
//  violate the vendor's terms of service and can get an account flagged.
//  We only ever read the CURRENT user's own local files, classify each
//  credential, and surface a warning; nothing is adopted without an
//  explicit, risk-acknowledged action.
//
//  All reads go through an injectable home dir so this is unit-testable
//  without touching the real filesystem.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ProviderType } from '../types.js';

export type CredentialKind = 'api-key' | 'oauth';

export interface DiscoveredCredential {
  /** Which Cascade provider this maps to. */
  provider: ProviderType;
  /** Human-readable source, e.g. "Claude Code", "Environment". */
  sourceTool: string;
  kind: CredentialKind;
  /** The API key or OAuth access token. Never logged or printed in full. */
  secret: string;
  /**
   * True when the secret can be used directly against the standard provider
   * API (a real API key). OAuth subscription tokens are mostly vendor-locked,
   * so this is false for them except Anthropic, whose SDK accepts a bearer
   * token via the oauth beta.
   */
  directlyUsable: boolean;
  /** ToS / gray-area note shown before adoption. */
  warning?: string;
  /** File the credential came from (path only — never the secret). */
  sourcePath?: string;
}

export interface DiscoveryOptions {
  /** Override the home directory (tests). Defaults to os.homedir(). */
  homeDir?: string;
  /** Override env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const TOS_WARNING =
  'Reusing this subscription token outside its own CLI may violate the vendor’s terms of service.';

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Standard provider API keys exported as environment variables. */
function fromEnv(env: NodeJS.ProcessEnv): DiscoveredCredential[] {
  const map: Array<{ env: string; provider: ProviderType }> = [
    { env: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
    { env: 'OPENAI_API_KEY', provider: 'openai' },
    { env: 'GEMINI_API_KEY', provider: 'gemini' },
    { env: 'GOOGLE_API_KEY', provider: 'gemini' },
  ];
  const out: DiscoveredCredential[] = [];
  const seen = new Set<ProviderType>();
  for (const { env: name, provider } of map) {
    const secret = str(env[name]);
    if (!secret || seen.has(provider)) continue;
    seen.add(provider);
    out.push({ provider, sourceTool: `Environment (${name})`, kind: 'api-key', secret, directlyUsable: true });
  }
  return out;
}

/** Claude Code: ~/.claude/.credentials.json → { claudeAiOauth: { accessToken } }, or an API key. */
async function fromClaudeCode(home: string): Promise<DiscoveredCredential[]> {
  const file = path.join(home, '.claude', '.credentials.json');
  const data = await readJson(file);
  if (!data) return [];

  // OAuth subscription login (sk-ant-oat...). Usable as an Anthropic bearer
  // token, but gray-area outside Claude Code.
  const oauth = data['claudeAiOauth'] as Record<string, unknown> | undefined;
  const oauthToken = str(oauth?.['accessToken']);
  if (oauthToken) {
    return [{
      provider: 'anthropic',
      sourceTool: 'Claude Code',
      kind: 'oauth',
      secret: oauthToken,
      directlyUsable: true,
      warning: TOS_WARNING,
      sourcePath: file,
    }];
  }

  // Some setups store a raw API key.
  const apiKey = str(data['apiKey']) ?? str(data['anthropicApiKey']);
  if (apiKey) {
    return [{ provider: 'anthropic', sourceTool: 'Claude Code', kind: 'api-key', secret: apiKey, directlyUsable: true, sourcePath: file }];
  }
  return [];
}

/** OpenAI Codex CLI: ~/.codex/auth.json → { OPENAI_API_KEY } (usable) or ChatGPT { tokens } (locked). */
async function fromCodex(home: string): Promise<DiscoveredCredential[]> {
  const file = path.join(home, '.codex', 'auth.json');
  const data = await readJson(file);
  if (!data) return [];

  const apiKey = str(data['OPENAI_API_KEY']);
  if (apiKey) {
    return [{ provider: 'openai', sourceTool: 'Codex CLI', kind: 'api-key', secret: apiKey, directlyUsable: true, sourcePath: file }];
  }

  // ChatGPT-subscription OAuth: only works against ChatGPT's backend, not the
  // standard OpenAI API — surface it but mark it not directly usable.
  const tokens = data['tokens'] as Record<string, unknown> | undefined;
  const accessToken = str(tokens?.['access_token']);
  if (accessToken) {
    return [{
      provider: 'openai',
      sourceTool: 'Codex CLI (ChatGPT login)',
      kind: 'oauth',
      secret: accessToken,
      directlyUsable: false,
      warning: `${TOS_WARNING} This ChatGPT token is not accepted by the standard OpenAI API.`,
      sourcePath: file,
    }];
  }
  return [];
}

/** Gemini CLI: ~/.gemini/oauth_creds.json (Google OAuth — locked to Code Assist). */
async function fromGemini(home: string): Promise<DiscoveredCredential[]> {
  const file = path.join(home, '.gemini', 'oauth_creds.json');
  const data = await readJson(file);
  const accessToken = str(data?.['access_token']);
  if (!accessToken) return [];
  return [{
    provider: 'gemini',
    sourceTool: 'Gemini CLI (Google login)',
    kind: 'oauth',
    secret: accessToken,
    directlyUsable: false,
    warning: `${TOS_WARNING} This Google OAuth token targets the Code Assist API, not the standard Gemini API key endpoint.`,
    sourcePath: file,
  }];
}

/** GitHub Copilot CLI: ~/.config/github-copilot/{apps,hosts}.json (oauth_token, needs Copilot token exchange). */
async function fromCopilot(home: string): Promise<DiscoveredCredential[]> {
  for (const name of ['apps.json', 'hosts.json']) {
    const file = path.join(home, '.config', 'github-copilot', name);
    const data = await readJson(file);
    if (!data) continue;
    // Either file nests by host key: { "github.com:...": { oauth_token } }.
    for (const value of Object.values(data)) {
      const token = str((value as Record<string, unknown> | null)?.['oauth_token']);
      if (token) {
        return [{
          provider: 'openai-compatible',
          sourceTool: 'GitHub Copilot CLI',
          kind: 'oauth',
          secret: token,
          directlyUsable: false,
          warning: `${TOS_WARNING} The Copilot token must be exchanged for a short-lived token against GitHub’s Copilot endpoint before use.`,
          sourcePath: file,
        }];
      }
    }
  }
  return [];
}

/**
 * Discover all reusable credentials on this machine. Results are ordered
 * env-first (most likely the user's intended key), then per external tool.
 */
export async function discoverCredentials(opts: DiscoveryOptions = {}): Promise<DiscoveredCredential[]> {
  const home = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;

  const groups = await Promise.all([
    Promise.resolve(fromEnv(env)),
    fromClaudeCode(home),
    fromCodex(home),
    fromGemini(home),
    fromCopilot(home),
  ]);

  return groups.flat();
}

/** Mask a secret for display: keep a short prefix, redact the rest. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 6)}…${secret.slice(-2)}`;
}
