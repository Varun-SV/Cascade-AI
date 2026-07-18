// ─────────────────────────────────────────────
//  Cascade AI — Code-aware chunker (Phase 3)
// ─────────────────────────────────────────────
//
// Structural, dependency-free code chunking: segment a file at definition
// boundaries (functions / classes / types across common languages) so a chunk
// holds a coherent unit rather than an arbitrary line window, then size-bound
// and pack small segments together. This is a heuristic — good enough to keep
// most definitions intact without a parser. A tree-sitter AST chunker can slot
// in behind the CodeChunker interface later for exact boundaries.

export interface CodeChunker {
  chunk(text: string, opts?: { filename?: string }): Array<{ text: string; ord: number }>;
}

export interface CodeChunkOptions {
  targetChars?: number;
  /** Lines of trailing context carried into the next chunk when a segment is
   *  hard-split (0 for whole-definition segments, which don't need it). */
  overlapLines?: number;
  filename?: string;
}

const DEFAULTS = { targetChars: 1600, overlapLines: 2 };

// Start-of-definition patterns across JS/TS, Python, Go, Rust, Java/C#/C++.
// False positives just create an extra (harmless) boundary; false negatives
// fold into a larger segment that gets size-split — the heuristic degrades
// gracefully either way.
const BOUNDARY_RE = new RegExp(
  [
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+/, // JS/TS function
    /^\s*(export\s+)?(abstract\s+)?class\s+/, // class (JS/TS/PY/…)
    /^\s*(export\s+)?(interface|type|enum|namespace|module)\s+\w/, // TS declarations
    /^\s*(export\s+)?(const|let|var)\s+[\w$]+\s*[:=][^\n]*=>/, // arrow-fn const
    /^\s*(async\s+)?def\s+\w/, // Python def
    /^\s*(pub\s+)?(async\s+)?fn\s+\w/, // Rust fn
    /^\s*(pub\s+)?(struct|enum|trait|impl)\b/, // Rust items
    /^func\s+/, // Go func
    /^\s*(public|private|protected|internal|static|final|abstract)[\w\s<>,\[\]]*\s[\w$]+\s*\(/, // Java/C# member
  ]
    .map((r) => r.source)
    .join('|'),
);

function hardSplitByLines(lines: string[], targetChars: number, overlapLines: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const line of lines) {
    if (curLen + line.length > targetChars && cur.length) {
      out.push(cur.join('\n'));
      cur = overlapLines > 0 ? cur.slice(-overlapLines) : [];
      curLen = cur.reduce((n, l) => n + l.length + 1, 0);
    }
    cur.push(line);
    curLen += line.length + 1;
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

/**
 * Chunk source code into definition-aligned, size-bounded pieces. Returns
 * `{ text, ord }` in file order. Deterministic and dependency-free.
 */
export function chunkCode(text: string, opts: CodeChunkOptions = {}): Array<{ text: string; ord: number }> {
  const { targetChars, overlapLines } = { ...DEFAULTS, ...opts };
  const normalized = text.replace(/\r\n/g, '\n').replace(/\s+$/,'');
  if (!normalized.trim()) return [];
  const lines = normalized.split('\n');

  // Boundary line indices (always include 0 so the preamble is its own segment).
  const boundaries: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    if (BOUNDARY_RE.test(lines[i]!)) boundaries.push(i);
  }
  boundaries.push(lines.length);

  // Segments between consecutive boundaries.
  const segments: string[] = [];
  for (let b = 0; b < boundaries.length - 1; b++) {
    const seg = lines.slice(boundaries[b]!, boundaries[b + 1]!).join('\n').replace(/^\n+|\n+$/g, '');
    if (seg.trim()) segments.push(seg);
  }

  // Pack small segments together; hard-split oversize ones by lines.
  const chunks: string[] = [];
  let cur = '';
  for (const seg of segments) {
    if (seg.length > targetChars) {
      if (cur) { chunks.push(cur); cur = ''; }
      chunks.push(...hardSplitByLines(seg.split('\n'), targetChars, overlapLines));
      continue;
    }
    const candidate = cur ? `${cur}\n\n${seg}` : seg;
    if (candidate.length > targetChars && cur) { chunks.push(cur); cur = seg; }
    else cur = candidate;
  }
  if (cur.trim()) chunks.push(cur);

  return chunks.map((text, ord) => ({ text: text.replace(/^\n+|\n+$/g, ''), ord }));
}

/** Default heuristic implementation of the CodeChunker seam. */
export const heuristicCodeChunker: CodeChunker = {
  chunk: (text, opts) => chunkCode(text, opts),
};
