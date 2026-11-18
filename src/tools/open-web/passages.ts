// ─────────────────────────────────────────────
//  Cascade AI — Open Web: the passages that answer a question
// ─────────────────────────────────────────────
//
//  A page split into passages of a few sentences, each under the heading it sits
//  under, and ranked against the query with BM25. A model asking "what is the
//  default timeout" gets the paragraph that says it, not the page.

export interface Passage {
  /** The heading the passage sits under, when there is one. */
  heading?: string;
  text: string;
  score: number;
}

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'its',
  'of', 'on', 'or', 'so', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'you', 'your', 'me', 'my', 'we', 'our', 'they', 'their', 'there', 'about', 'into', 'than', 'then', 'should', 'would', 'could',
]);

/** A text's words for matching: lower case, letters and digits, without the commonest. Exported for tests. */
export function terms(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
}

const TARGET = 600;
const MAX = 900;

/** A page's text in passages: paragraphs joined up to a size, long ones cut at sentences. */
export function split(text: string): Array<{ heading?: string; text: string }> {
  const out: Array<{ heading?: string; text: string }> = [];
  let heading: string | undefined;
  let buf = '';
  const push = (): void => {
    const t = buf.trim();
    if (t.length >= 40) out.push({ ...(heading ? { heading } : {}), text: t });
    buf = '';
  };
  let inCode = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (!inCode && /^#{1,6} /.test(line)) { push(); heading = line.replace(/^#+ /, '').slice(0, 120); continue; }
    if (!line.trim()) { if (buf.length >= TARGET) push(); continue; }
    if (buf.length + line.length + 1 <= MAX) { buf += (buf ? '\n' : '') + line; continue; }
    push();
    // One line longer than a passage: cut it at sentence ends.
    let rest = line;
    while (rest.length > MAX) {
      const cut = Math.max(rest.lastIndexOf('. ', MAX - 1), rest.lastIndexOf('? ', MAX - 1), rest.lastIndexOf('! ', MAX - 1));
      const at = cut > TARGET / 2 ? cut + 1 : MAX;
      buf = rest.slice(0, at);
      push();
      rest = rest.slice(at).trimStart();
    }
    buf = rest;
  }
  push();
  return out;
}

/**
 * The passages of `text` that best answer `query`, best first. BM25 over the
 * page's own passages; a heading's words count too. Passages that share none of
 * the query's words are left out.
 */
export function bestPassages(text: string, query: string, limit = 3): Passage[] {
  const q = [...new Set(terms(query))];
  const chunks = split(text);
  if (!q.length || !chunks.length) return [];
  const docs = chunks.map((c) => terms(`${c.heading ?? ''} ${c.text}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) if (q.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const scored: Passage[] = chunks.map((c, i) => {
    const d = docs[i]!;
    const tf = new Map<string, number>();
    for (const t of d) if (q.includes(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
    }
    // Most of the question's words, not one of them many times.
    score *= 0.5 + 0.5 * (tf.size / q.length);
    return { ...(c.heading ? { heading: c.heading } : {}), text: c.text, score };
  });
  return scored.filter((p) => p.score > 0).sort((a, b2) => b2.score - a.score).slice(0, limit);
}
