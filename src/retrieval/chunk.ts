// ─────────────────────────────────────────────
//  Cascade AI — Prose chunker (Phase 1)
// ─────────────────────────────────────────────
//
// Heading/paragraph-aware chunking. We split on blank lines (and keep markdown
// headings attached to the section they introduce), then greedily pack blocks
// into ~targetChars windows with a small overlap so a passage that straddles a
// boundary is still recoverable. Character budgets approximate token budgets at
// ~4 chars/token, which is close enough for chunk sizing and avoids a tokenizer
// dependency.

export interface ChunkOptions {
  /** Target chunk size in characters (~512 tokens by default). */
  targetChars?: number;
  /** Overlap carried from the end of one chunk into the next. */
  overlapChars?: number;
  /** Drop a trailing chunk smaller than this unless it's the only one. */
  minChars?: number;
}

const DEFAULTS: Required<ChunkOptions> = { targetChars: 2000, overlapChars: 200, minChars: 80 };

/** Split an over-long block on sentence boundaries, falling back to hard splits
 *  so no piece exceeds `max`. */
function splitLongBlock(block: string, max: number): string[] {
  if (block.length <= max) return [block];
  const out: string[] = [];
  const sentences = block.match(/[^.!?\n]+[.!?]*\s*/g) ?? [block];
  let cur = '';
  for (const s of sentences) {
    if (s.length > max) {
      // A single monster "sentence" (e.g. a table row / code line): hard-split.
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if (cur.length + s.length > max) { out.push(cur); cur = s; }
    else cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Take the last ~overlap chars of `text`, snapped to a word boundary. */
function overlapTail(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return text.length <= overlap ? text : '';
  const tail = text.slice(text.length - overlap);
  const sp = tail.indexOf(' ');
  return sp > 0 ? tail.slice(sp + 1) : tail;
}

/**
 * Chunk prose/markdown into overlapping windows. Returns `{ text, ord }` in
 * document order. Deterministic and dependency-free.
 */
export function chunkText(input: string, options: ChunkOptions = {}): Array<{ text: string; ord: number }> {
  const { targetChars, overlapChars, minChars } = { ...DEFAULTS, ...options };
  const normalized = input.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];

  // Blocks = paragraphs (blank-line separated), each split down to <= targetChars.
  const rawBlocks = normalized.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const blocks: string[] = [];
  for (const b of rawBlocks) blocks.push(...splitLongBlock(b, targetChars));

  const chunks: string[] = [];
  let cur = '';
  for (const block of blocks) {
    const candidate = cur ? `${cur}\n\n${block}` : block;
    if (candidate.length > targetChars && cur) {
      chunks.push(cur);
      const carry = overlapTail(cur, overlapChars);
      cur = carry ? `${carry}\n\n${block}` : block;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) {
    // Fold a tiny trailing remnant back into the previous chunk.
    if (chunks.length && cur.length < minChars) chunks[chunks.length - 1] += `\n\n${cur}`;
    else chunks.push(cur);
  }

  return chunks.map((text, ord) => ({ text: text.trim(), ord }));
}
