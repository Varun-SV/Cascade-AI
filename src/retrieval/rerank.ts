// ─────────────────────────────────────────────
//  Cascade AI — Reranking (Phase 2)
// ─────────────────────────────────────────────
//
// A reranker re-scores first-stage candidates by reading query + passage
// together, which is the single biggest grounding lever. Phase 1's hybrid
// retrieval fuses two *ranked lists* (cheap, no cross-attention); reranking then
// reorders the survivors with real relevance judgment.
//
// The default LLMReranker does listwise reranking through a caller-provided
// completion function, so it reuses whatever model the user already configured
// (no ONNX runtime, no separate rerank API/key). A cross-encoder or hosted
// Rerank API can slot in behind the same interface later.

import OpenAI from 'openai';
import type { ProviderConfig } from '../types.js';
import type { ScoredChunk } from './types.js';

export interface Reranker {
  readonly name: string;
  /** Reorder candidates for a query; return the best `topK`, best-first. */
  rerank(query: string, candidates: ScoredChunk[], topK: number): Promise<ScoredChunk[]>;
}

/** A minimal text-completion function (prompt in, text out). */
export type CompleteFn = (prompt: string) => Promise<string>;

const RERANK_INSTRUCTIONS =
  'You are a search reranker. Given a query and numbered passages, return the passage numbers ordered from MOST to LEAST relevant to the query. Respond with ONLY a comma-separated list of numbers (e.g. "3,1,4"). Include only clearly relevant passages; omit irrelevant ones.';

/** Parse a model's "3,1,4" answer into 0-based indices, keeping only valid,
 *  in-range, non-duplicate entries. Returns null when nothing parses. */
export function parseRankOrder(reply: string, count: number): number[] | null {
  const nums = (reply.match(/\d+/g) ?? []).map((n) => Number(n) - 1);
  const seen = new Set<number>();
  const order: number[] = [];
  for (const i of nums) {
    if (i >= 0 && i < count && !seen.has(i)) {
      seen.add(i);
      order.push(i);
    }
  }
  return order.length ? order : null;
}

export class LLMReranker implements Reranker {
  readonly name = 'llm-listwise';
  private complete: CompleteFn;
  /** Cap on candidates sent to the model (keeps the prompt + cost bounded). */
  private maxCandidates: number;

  constructor(opts: { complete: CompleteFn; maxCandidates?: number }) {
    this.complete = opts.complete;
    this.maxCandidates = opts.maxCandidates ?? 20;
  }

  async rerank(query: string, candidates: ScoredChunk[], topK: number): Promise<ScoredChunk[]> {
    if (candidates.length <= 1) return candidates.slice(0, topK);
    const pool = candidates.slice(0, this.maxCandidates);
    const numbered = pool
      .map((c, i) => `[${i + 1}] ${c.text.slice(0, 600).replace(/\s+/g, ' ').trim()}`)
      .join('\n');
    const prompt = `${RERANK_INSTRUCTIONS}\n\nQuery: ${query}\n\nPassages:\n${numbered}\n\nRanked passage numbers:`;

    let order: number[] | null = null;
    try {
      order = parseRankOrder(await this.complete(prompt), pool.length);
    } catch {
      order = null;
    }
    // On any failure, preserve the fused order (never drop to worse-than-input).
    if (!order) return candidates.slice(0, topK);

    const ranked = order.map((i, rank) => ({ ...pool[i]!, score: 1 / (rank + 1) }));
    // Append any candidates the model omitted, after the ranked ones, so we
    // never return fewer than requested when the pool has enough.
    if (ranked.length < topK) {
      const chosen = new Set(order);
      for (let i = 0; i < pool.length && ranked.length < topK; i++) {
        if (!chosen.has(i)) ranked.push({ ...pool[i]!, score: 0 });
      }
    }
    return ranked.slice(0, topK);
  }
}

/**
 * Build a completion function from the user's providers using an OpenAI-
 * compatible `/chat/completions` endpoint (OpenAI, compatible gateways, Ollama).
 * Returns null when no such provider is configured (reranking then no-ops and
 * the fused order stands). Mirrors embedderFromProviders so the same key powers
 * both stages.
 */
export function chatCompleterFromProviders(
  providers: ProviderConfig[],
  opts: { model?: string } = {},
): CompleteFn | null {
  const capable = new Set(['openai', 'openai-compatible', 'ollama']);
  const ranked = [...providers].sort((a, b) => rank(a.type) - rank(b.type));
  const chosen = ranked.find((p) => capable.has(p.type) && (p.apiKey || p.type === 'ollama' || p.baseUrl));
  if (!chosen) return null;
  const model = opts.model || chosen.model || (chosen.type === 'ollama' ? 'llama3' : 'gpt-4o-mini');
  const client = new OpenAI({ apiKey: chosen.apiKey || 'sk-none', baseURL: chosen.baseUrl });
  return async (prompt: string) => {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 60,
    });
    return res.choices[0]?.message?.content ?? '';
  };
}

function rank(type: string): number {
  if (type === 'openai') return 0;
  if (type === 'openai-compatible') return 1;
  if (type === 'ollama') return 2;
  return 9;
}
