// ─────────────────────────────────────────────
//  Cascade AI — Adaptive retrieval planning (Phase 2)
// ─────────────────────────────────────────────
//
// Decides HOW knowledge enters a run rather than always retrieving. Today the
// only retrievable corpus is attached documents, so the live decision is
// none / CAG / RAG. `graph` and `code` are reserved for Phases 3–4 (codebase
// index, world-state graph) — they're in the enum so callers can switch
// exhaustively as those corpora come online, but planRetrieval never returns
// them yet.

export type RetrievalMode = 'none' | 'cag' | 'rag' | 'graph' | 'code';

export interface RetrievalContext {
  /** Retrievable sources attached to this run (e.g. documents). */
  sourceCount: number;
  /** Total characters across those sources. */
  totalChars: number;
  /** Below this size, sources are injected in full (cache-augmented). */
  cagCharBudget: number;
  /** A single direct model call — no orchestration/retrieval machinery. */
  fastAnswer?: boolean;
}

export interface RetrievalPlan {
  mode: RetrievalMode;
  /** Human-readable rationale (surfaced in notices / decision logs). */
  reason: string;
}

/** Rough characters-per-token, the standard ~4:1 approximation for English text. */
export const CHARS_PER_TOKEN = 4;

/**
 * The character budget below which attached documents are injected in full
 * (CAG) rather than retrieved (RAG) — derived from the model context window
 * instead of a fixed byte cliff. Reserve most of the window for the system
 * prompt, conversation history, and the model's own output, and let attached
 * documents occupy up to `docFraction` of what the window can hold. A larger
 * window therefore admits larger documents in full; retrieval only kicks in
 * for corpora that genuinely wouldn't fit. (A 52 KB doc is ~13k tokens — it
 * fits comfortably in any modern window, so it should never be forced to RAG.)
 */
export function cagCharBudget(
  contextWindowTokens: number,
  opts: { docFraction?: number; charsPerToken?: number } = {},
): number {
  const docFraction = opts.docFraction ?? 0.5;
  const charsPerToken = opts.charsPerToken ?? CHARS_PER_TOKEN;
  return Math.max(0, Math.floor(contextWindowTokens * docFraction * charsPerToken));
}

/**
 * Choose the retrieval mode for a run. Pure and deterministic so it's unit-
 * testable and reusable across cloud, desktop, and CLI.
 */
export function planRetrieval(ctx: RetrievalContext): RetrievalPlan {
  if (ctx.sourceCount <= 0) return { mode: 'none', reason: 'no attached knowledge to retrieve' };
  // A fast answer skips the retrieval machinery but still reads the user's
  // attached context in full — they attached it to get a quick answer about it.
  if (ctx.fastAnswer) return { mode: 'cag', reason: 'fast answer — inject attached knowledge in full, no retrieval' };
  if (ctx.totalChars <= ctx.cagCharBudget) {
    return { mode: 'cag', reason: 'attached knowledge fits the context budget — inject in full' };
  }
  return { mode: 'rag', reason: 'attached knowledge exceeds the budget — retrieve relevant passages' };
}
