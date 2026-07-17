// ─────────────────────────────────────────────
//  Cascade AI — Embedders (Phase 1)
// ─────────────────────────────────────────────

import OpenAI from 'openai';
import type { ProviderConfig } from '../types.js';
import type { Embedder } from './types.js';

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

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => (t.trim() ? t : ' '));
      const res = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      });
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

/** Provider types that speak the OpenAI `/v1/embeddings` shape. */
const EMBED_CAPABLE = new Set(['openai', 'openai-compatible', 'ollama']);

/**
 * Pick an embeddings-capable provider from the user's configured providers and
 * build an Embedder, or return null when none can embed (e.g. an Anthropic-only
 * setup). Prefers a hosted OpenAI/compatible key over a local Ollama.
 */
export function embedderFromProviders(
  providers: ProviderConfig[],
  opts: { model?: string; dimensions?: number } = {},
): Embedder | null {
  const ranked = [...providers].sort((a, b) => rank(a.type) - rank(b.type));
  const chosen = ranked.find((p) => EMBED_CAPABLE.has(p.type) && (p.apiKey || p.type === 'ollama' || p.baseUrl));
  if (!chosen) return null;
  const model = opts.model || (chosen.type === 'ollama' ? DEFAULT_OLLAMA_EMBED_MODEL : DEFAULT_OPENAI_EMBED_MODEL);
  return new OpenAICompatibleEmbedder({
    apiKey: chosen.apiKey,
    baseURL: chosen.baseUrl,
    model,
    dimensions: opts.dimensions,
  });
}

function rank(type: string): number {
  if (type === 'openai') return 0;
  if (type === 'openai-compatible') return 1;
  if (type === 'ollama') return 2;
  return 9;
}
