// ─────────────────────────────────────────────
//  Extended context — compaction primitives
// ─────────────────────────────────────────────
//
// Pure, provider-agnostic building blocks for handling content that exceeds a
// model's context window. The strategy is always divide → process → combine;
// which method to use depends on the shape of the overflow:
//
//   • conversation history over budget  → rolling summary (fold old turns)
//   • one oversized input               → structure-aware chunk + map-reduce
//
// Everything here is synchronous or takes an injected `summarize` function, so
// it unit-tests without a live provider. The router wires the real model in.

import type { ConversationMessage, MessageContent } from '../../types.js';

/** A model call that condenses `input` under `instruction`, returning the text. */
export type Summarize = (input: string, instruction: string) => Promise<string>;

/**
 * Rough token estimate. ~4 characters per token is a reasonable English-ish
 * heuristic — good enough for *budgeting* decisions (we deliberately leave
 * headroom), not for billing. Never returns less than a whole token for
 * non-empty text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Flatten a message's content (string or blocks) to plain text for budgeting. */
export function contentToText(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_result' ? c.content : `[${c.type}]`))
    .join(' ');
}

/** Total estimated tokens across a message list. */
export function messagesTokens(messages: ConversationMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(contentToText(m.content)), 0);
}

/**
 * Break `text` into units no larger than `maxChars`, preferring the largest
 * natural boundary (paragraph → line → sentence → word), and hard-splitting
 * anything still too big (e.g. a giant token with no separators). Preserves the
 * separators so re-joining is lossless.
 */
function atomize(text: string, maxChars: number): string[] {
  const seps = ['\n\n', '\n', '. ', ' '];
  let units = [text];
  for (const sep of seps) {
    if (units.every((u) => u.length <= maxChars)) break;
    const next: string[] = [];
    for (const u of units) {
      if (u.length <= maxChars) { next.push(u); continue; }
      const parts = u.split(sep);
      parts.forEach((p, i) => next.push(i < parts.length - 1 ? p + sep : p));
    }
    units = next;
  }
  const out: string[] = [];
  for (const u of units) {
    if (u.length <= maxChars) out.push(u);
    else for (let i = 0; i < u.length; i += maxChars) out.push(u.slice(i, i + maxChars));
  }
  return out;
}

/**
 * Structure-aware recursive chunking with overlap. Splits on natural
 * boundaries so a chunk rarely severs a sentence/paragraph, targets
 * `maxTokens` per chunk, and carries a small tail overlap (default ~10%) into
 * the next chunk so context isn't lost at the seams. Empty input → no chunks.
 */
export function chunkText(text: string, opts: { maxTokens: number; overlapRatio?: number }): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxTokens * 4));
  const overlap = Math.min(maxChars - 1, Math.max(0, Math.floor(maxChars * (opts.overlapRatio ?? 0.1))));
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const units = atomize(trimmed, maxChars);
  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length > maxChars) {
      chunks.push(cur.trim());
      cur = overlap > 0 ? cur.slice(-overlap) : '';
    }
    cur += u;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/**
 * True when `totalTokens` would overflow the model's usable window. `reserve`
 * (default 0.2) keeps headroom for the system prompt + the model's own output,
 * so we compact a bit *before* hitting the hard wall.
 */
export function needsCompaction(totalTokens: number, contextWindow: number, reserve = 0.2): boolean {
  if (!contextWindow || contextWindow <= 0) return false;
  return totalTokens > contextWindow * (1 - reserve);
}

export interface MapReduceOptions {
  summarize: Summarize;
  /** What each chunk-summary should aim to capture (task-specific). */
  instruction?: string;
  /** Target size for each chunk sent to the model. */
  chunkTokens: number;
  /** The compacted result should land under this. */
  targetTokens: number;
  /** Hard ceiling on input size (the 2×/3× cap, in tokens). Excess is truncated. */
  capTokens: number;
  /** Bound on reduce passes so a pathological input can't loop forever. */
  maxReducePasses?: number;
}

export interface MapReduceResult {
  text: string;
  chunks: number;
  /** Model calls made (map + reduce) — drives the cost estimate/notice. */
  calls: number;
  truncated: boolean;
}

/**
 * Compact a single oversized input via map-reduce: chunk it, summarize each
 * chunk (MAP, in parallel), then recursively combine the summaries (REDUCE)
 * until the result fits `targetTokens`. Input beyond `capTokens` is truncated
 * first (with a note) so cost/latency stay bounded.
 */
export async function mapReduceCompact(text: string, opts: MapReduceOptions): Promise<MapReduceResult> {
  const capChars = opts.capTokens * 4;
  let working = text;
  let truncated = false;
  if (working.length > capChars) {
    working = working.slice(0, capChars);
    truncated = true;
  }

  const instruction = opts.instruction ?? 'Summarize this content, preserving key facts, names, numbers, and decisions.';
  let chunks = chunkText(working, { maxTokens: opts.chunkTokens });
  if (chunks.length <= 1) return { text: working, chunks: chunks.length, calls: 0, truncated };

  let calls = 0;
  // MAP
  let parts = await Promise.all(
    chunks.map((c, i) => {
      calls++;
      return opts.summarize(c, `${instruction} (part ${i + 1} of ${chunks.length})`);
    }),
  );
  let combined = parts.join('\n\n');

  // REDUCE — collapse until it fits, bounded.
  const maxPasses = opts.maxReducePasses ?? 3;
  for (let pass = 0; pass < maxPasses && estimateTokens(combined) > opts.targetTokens; pass++) {
    const groups = chunkText(combined, { maxTokens: opts.chunkTokens });
    if (groups.length <= 1) break;
    parts = await Promise.all(
      groups.map((g) => {
        calls++;
        return opts.summarize(g, 'Merge these partial summaries into one cohesive summary; keep all distinct facts.');
      }),
    );
    combined = parts.join('\n\n');
  }

  const note = truncated ? '\n\n[Note: input exceeded the extended-context cap and was truncated.]' : '';
  return { text: combined + note, chunks: chunks.length, calls, truncated };
}

export interface RollingSummaryOptions {
  summarize: Summarize;
  /** How many of the most-recent messages to keep verbatim. */
  keepRecent: number;
  /** The summarized history should land under this. */
  targetTokens: number;
}

/**
 * Fold the oldest turns of an over-budget history into a single system summary,
 * keeping the most recent `keepRecent` messages verbatim. Returns the original
 * list unchanged when it's already short enough.
 */
export async function rollingSummary(
  messages: ConversationMessage[],
  opts: RollingSummaryOptions,
): Promise<ConversationMessage[]> {
  if (messages.length <= opts.keepRecent) return messages;
  const older = messages.slice(0, messages.length - opts.keepRecent);
  const recent = messages.slice(messages.length - opts.keepRecent);
  const transcript = older.map((m) => `${m.role}: ${contentToText(m.content)}`).join('\n');
  const summary = await opts.summarize(
    transcript,
    'Summarize this earlier conversation. Preserve facts, decisions, names, numbers, and any open threads or todos.',
  );
  const summaryMessage: ConversationMessage = {
    role: 'system',
    content: `Summary of earlier conversation (folded to fit the context window):\n${summary}`,
  };
  return [summaryMessage, ...recent];
}
