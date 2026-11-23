// ─────────────────────────────────────────────
//  Cascade AI — Embedders (Phase 1)
// ─────────────────────────────────────────────

import OpenAI from 'openai';
import type { ProviderConfig } from '../types.js';
import type { Embedder } from './types.js';
import { OLLAMA_BASE_URL } from '../constants.js';

const DEFAULT_OPENAI_EMBED_MODEL = 'text-embedding-3-small';
const DEFAULT_OLLAMA_EMBED_MODEL = 'nomic-embed-text';
/** Batch size per request — well under OpenAI's input/token caps. */
const BATCH = 96;

export interface OpenAIEmbedderOptions {
  apiKey?: string;
  baseURL?: string;
  model: string;
  /** Matryoshka truncation for text-embedding-3-* (e.g. 512). Omit for native. */
  dimensions?: number;
}

/**
 * Embedder backed by an OpenAI-compatible `/v1/embeddings` endpoint. Works
 * against OpenAI, OpenAI-compatible gateways, and Ollama (which exposes the same
 * route) — so the cloud uses a provider API and desktop/CLI can point at a local
 * Ollama with no separate runtime.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  private client: OpenAI;
  private dimensions: number | undefined;
  private resolvedDims = 0;

  constructor(opts: OpenAIEmbedderOptions) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    // A dummy key keeps the SDK happy for keyless local endpoints (Ollama).
    this.client = new OpenAI({ apiKey: opts.apiKey || 'sk-none', baseURL: opts.baseURL });
  }

  get dims(): number {
    return this.dimensions ?? this.resolvedDims;
  }

  async embed(texts: string[], opts: { signal?: AbortSignal } = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      // Checked per batch AND handed to the request, so a cancelled run stops
      // paying immediately rather than at the next batch boundary.
      opts.signal?.throwIfAborted();
      const batch = texts.slice(i, i + BATCH).map((t) => (t.trim() ? t : ' '));
      const res = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      }, { signal: opts.signal });
      // The API returns items with an `index`; sort to guarantee input order.
      const rows = [...res.data].sort((a, b) => a.index - b.index);
      for (const row of rows) {
        const vec = row.embedding as number[];
        if (!this.resolvedDims) this.resolvedDims = vec.length;
        out.push(vec);
      }
    }
    return out;
  }
}

/** Where Gemini answers in OpenAI's shape, under its API root. */
const GEMINI_ROOT = 'https://generativelanguage.googleapis.com';
const DEFAULT_GEMINI_EMBED_MODEL = 'gemini-embedding-001';

/** How to reach a provider through an OpenAI-shaped client: its key and the base URL to give the SDK. */
export interface OpenAIRoute {
  provider: ProviderConfig;
  apiKey: string;
  baseURL: string | undefined;
}

/**
 * The OpenAI-shaped route to `p`, or null when it has none, or not enough
 * configured to use one. A base URL is always given except for OpenAI itself:
 * the SDK falls back to api.openai.com, which is right for OpenAI and wrong for
 * everything else. That fallback is how a bare Ollama entry used to reach
 * OpenAI with a placeholder key and fail with 401.
 */
export function openAIRoute(p: ProviderConfig): OpenAIRoute | null {
  const trimmed = (u: string) => u.replace(/\/+$/, '');
  switch (p.type) {
    case 'openai':
      return p.apiKey || p.baseUrl ? { provider: p, apiKey: p.apiKey || 'sk-none', baseURL: p.baseUrl } : null;
    case 'openai-compatible':
      return p.baseUrl ? { provider: p, apiKey: p.apiKey || 'sk-none', baseURL: p.baseUrl } : null;
    case 'gemini':
      // Gemini's OpenAI-compatible surface (embeddings and chat), under the same root its own client uses.
      return p.apiKey ? { provider: p, apiKey: p.apiKey, baseURL: `${trimmed(p.baseUrl || GEMINI_ROOT)}/v1beta/openai/` } : null;
    case 'ollama': {
      const root = trimmed(p.baseUrl || OLLAMA_BASE_URL);
      return { provider: p, apiKey: p.apiKey || 'ollama', baseURL: /\/v1$/.test(root) ? root : `${root}/v1` };
    }
    default:
      return null;
  }
}

/**
 * The provider an OpenAI-shaped retrieval call should use: a hosted OpenAI or
 * compatible endpoint first, then an Ollama the user pointed at, then Gemini,
 * then the Ollama entry added by default (which may not be running at all).
 */
export function pickOpenAIRoute(providers: ProviderConfig[]): OpenAIRoute | null {
  const rank = (p: ProviderConfig): number => {
    if (p.type === 'openai') return 0;
    if (p.type === 'openai-compatible') return 1;
    if (p.type === 'ollama' && p.baseUrl) return 2;
    if (p.type === 'gemini') return 3;
    if (p.type === 'ollama') return 4;
    return 9;
  };
  for (const p of [...providers].sort((a, b) => rank(a) - rank(b))) {
    const route = rank(p) < 9 ? openAIRoute(p) : null;
    if (route) return route;
  }
  return null;
}

/** The embedding model a provider type is asked for, unless one is given. */
export function defaultEmbedModel(type: string): string {
  return type === 'ollama' ? DEFAULT_OLLAMA_EMBED_MODEL : type === 'gemini' ? DEFAULT_GEMINI_EMBED_MODEL : DEFAULT_OPENAI_EMBED_MODEL;
}

/**
 * Pick an embeddings-capable provider from the user's configured providers and
 * build an Embedder, or return null when none can embed (e.g. an Anthropic-only
 * setup). See pickOpenAIRoute for the order.
 */
export function embedderFromProviders(
  providers: ProviderConfig[],
  opts: { model?: string; dimensions?: number } = {},
): (Embedder & { provider: string }) | null {
  const route = pickOpenAIRoute(providers);
  if (!route) return null;
  const embedder = new OpenAICompatibleEmbedder({
    apiKey: route.apiKey,
    baseURL: route.baseURL,
    model: opts.model || defaultEmbedModel(route.provider.type),
    dimensions: opts.dimensions,
  });
  return Object.assign(embedder, { provider: route.provider.type });
}

/**
 * Why embedding failed, in a line: which provider and model, and what it said.
 * A refused key is said plainly. Nothing here repeats the key, the request or
 * the indexed text.
 */
export function describeEmbedFailure(err: unknown, embedder: { model: string; provider?: string }): string {
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined;
  const raw = err instanceof Error ? err.message : String(err);
  // The SDK's message can quote the key it sent ("Incorrect API key provided: sk-…"): not repeated.
  const said = raw.replace(/(api key provided:\s*)\S+/i, '$1[hidden]').split('\n')[0]!.slice(0, 300);
  const who = `${embedder.provider ?? 'the embeddings provider'} (${embedder.model})`;
  if (status === 401 || status === 403) return `${who} refused the key (HTTP ${status}). Check that provider's key in your config. ${said}`;
  if (status === 404) return `${who} has no such embeddings model or endpoint (HTTP 404). ${said}`;
  return `Embedding with ${who} failed: ${said}`;
}
