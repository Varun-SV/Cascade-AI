// ─────────────────────────────────────────────
//  Cascade AI — Credential Discovery
// ─────────────────────────────────────────────
//
//  Detects credentials the user already has on this machine from other
//  AI CLIs (Claude Code, OpenAI Codex, Gemini CLI, GitHub Copilot) plus
//  the standard provider env vars, so `cascade link` / `cascade init` can
//  reuse them instead of asking the user to paste keys again.
//
//  ⚠ A subscription OAuth token (Claude Code, ChatGPT, Copilot, Gemini CLI)
//  belongs to the tool that minted it, and none of them are adopted. Each
//  targets its own vendor's backend rather than the public API, and
//  Anthropic's — the one that would otherwise have worked — is explicitly
//  prohibited for third-party clients and refused server-side. They are still
//  SURFACED, because "you have this, Cascade can't use it, here is why" is
//  more useful than silence.
//
//  We only ever read the CURRENT user's own local files.
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
   * API. Subscription OAuth tokens are vendor-locked — each targets its own
   * tool's backend, not the public API — so this is false for all of them.
   */
  directlyUsable: boolean;
  /**
   * Endpoint the secret belongs to, for OpenAI-compatible services that are
   * only identifiable by which env var carried the key. Adopting one without
   * this would configure a provider with nowhere to send a request.
   */
  baseUrl?: string;
  /**
   * Which OpenAI-compatible service this is ("openrouter", "groq", …). They
   * all map to the same provider type, so this is what lets `cascade link groq`
   * pick the Groq key rather than whichever one happened to be found first.
   */
  serviceId?: string;
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

/**
 * Anthropic's position is no longer a gray area, so this does not hedge.
 *
 * code.claude.com/docs/en/legal-and-compliance states that OAuth authentication
 * is "intended exclusively" for ordinary use of Claude Code and other native
 * Anthropic applications, and that Anthropic "does not permit third-party
 * developers to offer Claude.ai login or to route requests through Free, Pro,
 * or Max plan credentials on behalf of their users" — directing developers to
 * API keys instead. It is enforced server-side as well as contractually: a
 * subscription token presented by another client is refused with "This
 * credential is only authorized for use with Claude Code and cannot be used for
 * other API requests."
 *
 * So this token is surfaced (it is worth telling the user what is on their
 * machine) and never adopted. The old text said "may violate", which
 * understated it, and the old `directlyUsable: true` would today produce a
 * provider that fails on its first call.
 */
const ANTHROPIC_OAUTH_WARNING =
  'Anthropic does not permit third-party tools to route requests through Claude '
  + 'subscription credentials, and blocks them server-side. Use an API key from '
  + 'the Claude Console, or ANTHROPIC_AUTH_TOKEN with a gateway. '
  + 'See code.claude.com/docs/en/legal-and-compliance.';

/**
 * OpenAI-compatible services identifiable only by which variable carries the
 * key. Each needs its endpoint adopted alongside the secret, or the result is a
 * provider configured with nowhere to send a request.
 *
 * ALL matches are reported, not just the first. Only one openai-compatible
 * provider can be configured at a time, but that is a choice to make at
 * adoption — reporting one key and hiding the others meant `cascade link groq`
 * would silently configure OpenRouter because its variable sorted earlier.
 */
export const OPENAI_COMPATIBLE_ENV: Array<{
  id: string; env: string; label: string; baseUrl: string;
}> = [
  { id: 'openrouter', env: 'OPENROUTER_API_KEY', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'groq', env: 'GROQ_API_KEY', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'deepseek', env: 'DEEPSEEK_API_KEY', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'xai', env: 'XAI_API_KEY', label: 'xAI', baseUrl: 'https://api.x.ai/v1' },
  { id: 'mistral', env: 'MISTRAL_API_KEY', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'together', env: 'TOGETHER_API_KEY', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { id: 'fireworks', env: 'FIREWORKS_API_KEY', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1' },
];

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
    { env: 'AZURE_OPENAI_KEY', provider: 'azure' },
  ];
  const out: DiscoveredCredential[] = [];
  const seen = new Set<ProviderType>();
  for (const { env: name, provider } of map) {
    const secret = str(env[name]);
    if (!secret || seen.has(provider)) continue;
    seen.add(provider);
    out.push({ provider, sourceTool: `Environment (${name})`, kind: 'api-key', secret, directlyUsable: true });
  }

  // An Anthropic bearer token pointed at a gateway. This is the sanctioned use
  // of a bearer credential — Anthropic documents ANTHROPIC_AUTH_TOKEN for
  // exactly it — and it is unrelated to the subscription tokens above.
  const authToken = str(env['ANTHROPIC_AUTH_TOKEN']);
  if (authToken && !seen.has('anthropic')) {
    seen.add('anthropic');
    out.push({
      provider: 'anthropic',
      sourceTool: 'Environment (ANTHROPIC_AUTH_TOKEN)',
      kind: 'oauth',
      secret: authToken,
      directlyUsable: true,
    });
  }

  // Everything that speaks the OpenAI wire format at its own endpoint. Keys for
  // these are already sitting in most developers' shells, and asking for one
  // again is the friction `cascade link` exists to remove.
  for (const { id, env: name, label, baseUrl } of OPENAI_COMPATIBLE_ENV) {
    const secret = str(env[name]);
    if (!secret) continue;
    out.push({
      provider: 'openai-compatible',
      sourceTool: `Environment (${name}) — ${label}`,
      kind: 'api-key',
      secret,
      directlyUsable: true,
      baseUrl,
      serviceId: id,
    });
  }
  return out;
}

/**
 * Claude Code: ~/.claude/.credentials.json → { claudeAiOauth: { accessToken } },
 * or an API key.
 *
 * `CLAUDE_CONFIG_DIR` relocates this file, so it is honoured here.
 *
 * NOT read on macOS, where Claude Code has moved credentials into the Keychain
 * and deletes this file — so discovery finds nothing there. Reading the
 * Keychain would mean shelling out to `security`, which prompts the user by
 * name, and the only credential it would surface is the subscription token
 * below, which Cascade now declines to adopt. Left undone deliberately rather
 * than shipped unverified.
 */
async function fromClaudeCode(home: string, env: NodeJS.ProcessEnv): Promise<DiscoveredCredential[]> {
  const dir = str(env['CLAUDE_CONFIG_DIR']) ?? path.join(home, '.claude');
  const file = path.join(dir, '.credentials.json');
  const data = await readJson(file);
  if (!data) return [];

  // Subscription login (sk-ant-oat...). Surfaced so the user knows it is here,
  // never adopted: Anthropic prohibits third-party use of it and refuses it at
  // the API. See ANTHROPIC_OAUTH_WARNING.
  const oauth = data['claudeAiOauth'] as Record<string, unknown> | undefined;
  const oauthToken = str(oauth?.['accessToken']);
  if (oauthToken) {
    return [{
      provider: 'anthropic',
      sourceTool: 'Claude Code',
      kind: 'oauth',
      secret: oauthToken,
      directlyUsable: false,
      warning: ANTHROPIC_OAUTH_WARNING,
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
    fromClaudeCode(home, env),
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
