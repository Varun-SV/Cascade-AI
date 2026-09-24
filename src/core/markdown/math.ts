// ─────────────────────────────────────────────
//  Cascade AI — Maths in Markdown answers
// ─────────────────────────────────────────────
//
//  Models write maths in three dialects: `$…$` / `$$…$$` (Claude and most
//  open models), `\(…\)` / `\[…\]` (GPT and Gemini), and bare environments
//  such as `\begin{align*}…\end{align*}`. The chat renders with remark-math,
//  which reads only the first. The other two went wrong in two ways:
//
//  - In Markdown `\[` is an ESCAPED BRACKET, so `\[ r = \operatorname{rank} \]`
//    reached the reader as `[ r = \operatorname{rank} ]`, commands and all.
//  - remark-math pairs ANY two dollars, so "costs $5 and $10" rendered
//    "5 and " as maths. Prices are ordinary in a cost-routing product.
//
//  normalizeMath() rewrites an answer into the one dialect the renderer reads,
//  just before it is parsed. It is a rendering step only: what the model wrote
//  is what gets stored, copied and exported.
//
//  WHAT IS CODE, A LINK OR A PARAGRAPH IS THE PARSER'S ANSWER, NOT OURS. The
//  first version recognised fences, code spans and URLs by hand, and review
//  found indented code blocks, blockquotes and long URLs it read differently
//  from the renderer — each a place where it rewrote text the renderer shows
//  verbatim. The structure now comes from micromark, the parser react-markdown
//  itself runs, so the two cannot disagree about which text is prose.
//
//  cloud/web and the desktop renderer both import it through the
//  `@cascade/markdown` alias, so the two chat surfaces cannot disagree about
//  what counts as maths either.
//
//  It runs on every streamed token, so each scan is linear. Every forward
//  search is memoised (see ProseScanner.find), because an answer can hold
//  thousands of unmatched delimiters and must not re-read a paragraph for each.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes } from 'mdast';

/** Environments KaTeX renders in display mode. Checked against KaTeX 0.16:
 *  multline, eqnarray and flalign are absent on purpose — wrapping one would
 *  swap raw text for a red parse error. */
const DISPLAY_ENVIRONMENTS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
  'aligned', 'alignedat', 'gather', 'gather*', 'gathered', 'split', 'cases',
  'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix',
  'smallmatrix', 'array', 'CD',
]);

/** How far a delimiter may be from its partner. Beyond this the opener is
 *  treated as ordinary text, which bounds the work on a malformed answer. */
const MAX_INLINE = 2_000;
const MAX_DISPLAY = 20_000;

/** A character only maths uses. Its presence settles an ambiguous `\[x\]`. */
const MATH_SIGN = /[\\^_=<>{}+*/|]/;
/** A word of four or more letters with no maths sign: prose, not maths. */
const PROSE_WORD = /[A-Za-z]{4,}/;

/**
 * Rewrite `\(…\)`, `\[…\]` and bare display environments as `$…$` / `$$…$$`,
 * and escape every `$` that would not pair as maths under Pandoc's rules, so
 * remark-math cannot read a price as an equation. Code of every kind, link
 * addresses and raw HTML are left exactly as written.
 */
export function normalizeMath(markdown: string): string {
  if (!markdown.includes('\\') && !markdown.includes('$')) return markdown;
  return new ProseScanner(markdown, readStructure(markdown)).run();
}

/** A half-open range of source offsets, [start, end). */
interface Span { start: number; end: number }

interface Structure {
  /** Text the renderer shows verbatim or never shows: code, link addresses,
   *  raw HTML. Sorted and disjoint. */
  verbatim: Span[];
  /** Where inline constructs live: paragraphs, headings, table cells. A `$`
   *  or `\(` cannot pair across one's edge. Sorted and disjoint. */
  inline: Span[];
}

/**
 * The document's structure as the renderer will read it. Parsed WITHOUT the
 * maths extension on purpose: deciding what is maths is this module's job,
 * and a parser that had already paired "$5 and $" would hide the very dollars
 * that need escaping.
 */
function readStructure(markdown: string): Structure {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const verbatim: Span[] = [];
  const inline: Span[] = [];

  const visit = (node: Nodes): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    switch (node.type) {
      case 'code':
      case 'inlineCode':
      case 'html':
      case 'definition':
      case 'image':
        verbatim.push({ start, end });
        return;
      case 'link': {
        // `[text](address)`: the text is prose, the address is not. An
        // autolink — bare or in `<…>` — is address from end to end.
        const first = node.children[0]?.position?.start.offset;
        const last = node.children[node.children.length - 1]?.position?.end.offset;
        if (markdown[start] !== '[' || first === undefined || last === undefined) {
          verbatim.push({ start, end });
          return;
        }
        verbatim.push({ start: last, end });
        break;
      }
      case 'paragraph':
      case 'heading':
      case 'tableCell':
        inline.push({ start, end });
        break;
      default:
        break;
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(tree);

  return { verbatim: disjoint(verbatim), inline: disjoint(inline) };
}

function disjoint(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const span of spans) {
    const prev = out[out.length - 1];
    if (prev && span.start <= prev.end) prev.end = Math.max(prev.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/** The first span whose end is after `pos`, by binary search; spans.length if none. */
function firstEndingAfter(spans: Span[], pos: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].end <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** True when the character at `at` is escaped by an odd run of backslashes. */
function isEscaped(s: string, at: number): boolean {
  let n = 0;
  while (at - 1 - n >= 0 && s[at - 1 - n] === '\\') n++;
  return n % 2 === 1;
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isBlank(text: string): boolean {
  for (const ch of text) if (!isSpace(ch)) return false;
  return true;
}

/** Only container markup — indentation and blockquote `>` markers. */
function isContainerMarkup(text: string): boolean {
  for (const ch of text) if (ch !== '>' && !isSpace(ch)) return false;
  return true;
}

/** How many blockquotes deep a line's container markup puts it. */
function quoteDepth(markup: string): number {
  let depth = 0;
  for (const ch of markup) if (ch === '>') depth++;
  return depth;
}

/**
 * A continuation line with its container markup removed: leading space and
 * up to `depth` blockquote markers. Only as many markers as the opener's line
 * had — a `>` beyond that is part of the maths.
 */
function stripContainer(line: string, depth: number): string {
  let i = 0;
  let quotes = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') i++;
    else if (ch === '>' && quotes < depth) { quotes++; i++; }
    else break;
  }
  return line.slice(i);
}

function longestRun(text: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === char ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** `$…$` around `content`, lengthened past any dollars inside it. */
function inlineMath(content: string, depth: number): string {
  let body = content
    .split('\n')
    .map((line, n) => (n === 0 ? line : stripContainer(line, depth)).trim())
    .join(' ')
    .trim();
  // A trailing backslash would sit against the closing fence; `\ ` is TeX's
  // control space, which renders as the space it looks like.
  if (body.endsWith('\\')) body += ' ';
  const fence = '$'.repeat(longestRun(body, '$') + 1);
  // A body that starts or ends with a dollar would merge into the fence.
  const pad = body.startsWith('$') || body.endsWith('$') ? ' ' : '';
  return `${fence}${pad}${body}${pad}${fence}`;
}

/**
 * A `$$` block written with `prefix` — the indentation or `>` markers of the
 * line it replaces — on every line, so it stays inside the list item or
 * blockquote it was in.
 */
function displayMath(prefix: string, content: string): string {
  const depth = quoteDepth(prefix);
  const lines = content.split('\n').map((line, n) => (n === 0 ? line : stripContainer(line, depth)).trimStart());
  while (lines.length > 0 && isBlank(lines[0])) lines.shift();
  while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
  const fence = '$'.repeat(Math.max(2, longestRun(content, '$') + 1));
  return [prefix + fence, ...lines.map((line) => prefix + line), prefix + fence].join('\n');
}

interface Replacement {
  /** Where the replaced text begins, when that is before the opener: a display
   *  block replaces its line's container markup, then writes it on every line. */
  start?: number;
  end: number;
  text: string;
}

/**
 * One left-to-right pass. Verbatim spans are stepped over whole; elsewhere
 * escapes are consumed in pairs, as Markdown reads them: `\\[` is a backslash
 * and a bracket, never an opener, and `\$` stays a literal dollar.
 */
class ProseScanner {
  private readonly out: string[] = [];
  private readonly memo = new Map<string, { from: number; at: number }>();

  constructor(private readonly s: string, private readonly structure: Structure) {}

  run(): string {
    const s = this.s;
    const verbatim = this.structure.verbatim;
    let next = 0;          // the first verbatim span not yet passed
    let i = 0;
    let emitted = 0;
    const replace = (start: number, r: Replacement): void => {
      this.out.push(s.slice(emitted, start), r.text);
      emitted = r.end;
      i = r.end;
    };

    while (i < s.length) {
      while (next < verbatim.length && verbatim[next].end <= i) next++;
      if (next < verbatim.length && verbatim[next].start <= i) {
        i = verbatim[next].end;
        continue;
      }
      const ch = s[i];
      if (ch === '\\') {
        const after = s[i + 1];
        const r = after === '(' ? this.paren(i)
          : after === '[' ? this.bracket(i)
            : after === 'b' ? this.environment(i)
              : null;
        if (r) {
          replace(r.start ?? i, r);
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === '$') {
        const r = this.dollars(i);
        if (r.escape) replace(i, { end: r.end, text: '\\$'.repeat(r.end - i) });
        else i = r.end;
        continue;
      }
      i++;
    }
    this.out.push(s.slice(emitted));
    return this.out.join('');
  }

  /** `\(…\)` as inline maths, unless it is prose that escaped its parentheses. */
  private paren(open: number): Replacement | null {
    const close = this.closer('\\)', open + 2);
    if (close === Infinity || close - open > MAX_INLINE || close >= this.inlineEnd(open)) return null;
    if (this.crossesVerbatim(open, close + 2)) return null;
    const content = this.s.slice(open + 2, close);
    const body = content.trim();
    if (body === '' || (!MATH_SIGN.test(body) && PROSE_WORD.test(body))) return null;
    return { end: close + 2, text: inlineMath(content, quoteDepth(this.markupBefore(open))) };
  }

  /**
   * `\[…\]` on lines of its own is display maths. Inside a sentence it is only
   * maths when it holds a maths sign: `\[1\]` and `\[link\]` are how Markdown
   * writes a literal bracket, and must still read as one.
   */
  private bracket(open: number): Replacement | null {
    const s = this.s;
    const close = this.closer('\\]', open + 2);
    if (close === Infinity || close - open > MAX_DISPLAY) return null;
    if (this.crossesVerbatim(open, close + 2)) return null;
    const content = s.slice(open + 2, close);
    const body = content.trim();
    if (body === '') return null;

    const lineStart = s.lastIndexOf('\n', open - 1) + 1;
    const prefix = s.slice(lineStart, open);
    const lineEnd = s.indexOf('\n', close + 2);
    const rest = s.slice(close + 2, lineEnd === -1 ? s.length : lineEnd);
    if (isContainerMarkup(prefix) && isBlank(rest)) {
      if (!MATH_SIGN.test(body) && PROSE_WORD.test(body)) return null;
      return { start: lineStart, end: close + 2, text: displayMath(prefix, content) };
    }

    if (close - open > MAX_INLINE || close >= this.inlineEnd(open)) return null;
    if (!MATH_SIGN.test(body)) return null;
    return { end: close + 2, text: inlineMath(content, quoteDepth(this.markupBefore(open))) };
  }

  /** A bare `\begin{align*}…\end{align*}` on lines of its own, as display maths. */
  private environment(open: number): Replacement | null {
    const s = this.s;
    if (!s.startsWith('\\begin{', open)) return null;
    const nameStart = open + '\\begin{'.length;
    const nameEnd = s.indexOf('}', nameStart);
    if (nameEnd === -1 || nameEnd - nameStart > 16) return null;
    const name = s.slice(nameStart, nameEnd);
    if (!DISPLAY_ENVIRONMENTS.has(name)) return null;

    const lineStart = s.lastIndexOf('\n', open - 1) + 1;
    const prefix = s.slice(lineStart, open);
    if (!isContainerMarkup(prefix)) return null;

    const endToken = `\\end{${name}}`;
    const close = this.find(`end:${name}`, nameEnd, (from) => s.indexOf(endToken, from));
    if (close === Infinity || close - open > MAX_DISPLAY) return null;
    const end = close + endToken.length;
    if (this.crossesVerbatim(open, end)) return null;
    const lineEnd = s.indexOf('\n', end);
    if (!isBlank(s.slice(end, lineEnd === -1 ? s.length : lineEnd))) return null;
    return { start: lineStart, end, text: displayMath(prefix, s.slice(open, end)) };
  }

  /**
   * What to do with the `$` run at `open`: keep it (scanning resumes at `end`)
   * or escape every dollar up to `end`.
   *
   * A single `$` pairs with the NEXT unescaped `$` only — which is what
   * remark-math does, code span or not — and only under Pandoc's rules: the
   * opener is followed by a non-space, the closer follows one and is not
   * followed by a digit. So "$5 and $10" is two prices, and so is
   * "$10k, while $x$" up to the `$x$`, which is still maths.
   *
   * A `$$` run inside a sentence must hold maths too: "A: $$, B: $$" is two
   * price tiers, not an equation reading ", B: ".
   */
  private dollars(open: number): { end: number; escape: boolean } {
    const s = this.s;
    let run = 0;
    while (s[open + run] === '$') run++;

    if (run >= 2) {
      const close = this.find(`dollars:${run}`, open + run, (from) => this.dollarRun(from, run));
      const keep = { end: open + run, escape: false };
      // Unclosed, or closed only across code the renderer will not pair
      // through: left as written. An unclosed one is most often the block the
      // model is still streaming.
      if (close === Infinity || close - open > MAX_DISPLAY || this.crossesVerbatim(open, close + run)) return keep;
      const lineStart = s.lastIndexOf('\n', open - 1) + 1;
      const lineEnd = s.indexOf('\n', open + run);
      const block = isContainerMarkup(s.slice(lineStart, open))
        && isBlank(s.slice(open + run, lineEnd === -1 ? s.length : lineEnd));
      if (block) return { end: close + run, escape: false };
      if (close >= this.inlineEnd(open)) return keep;
      const body = s.slice(open + run, close).trim();
      if (body === '' || (!MATH_SIGN.test(body) && PROSE_WORD.test(body))) return { end: open + run, escape: true };
      return { end: close + run, escape: false };
    }

    const escape = { end: open + 1, escape: true };
    if (open + 1 >= s.length || isSpace(s[open + 1])) return escape;
    const close = this.find('dollar', open + 1, (from) => this.unescapedDollar(from));
    if (close === Infinity || close - open > MAX_INLINE || close >= this.inlineEnd(open)) return escape;
    if (this.crossesVerbatim(open, close + 1)) return escape;
    if (s[close + 1] === '$' || isSpace(s[close - 1]) || isDigit(s[close + 1])) return escape;
    return { end: close + 1, escape: false };
  }

  private dollarRun(from: number, length: number): number {
    const s = this.s;
    let at = s.indexOf('$', from);
    while (at !== -1) {
      let run = 0;
      while (s[at + run] === '$') run++;
      if (run === length && !isEscaped(s, at)) return at;
      at = s.indexOf('$', at + run);
    }
    return -1;
  }

  private unescapedDollar(from: number): number {
    const s = this.s;
    let at = s.indexOf('$', from);
    while (at !== -1 && isEscaped(s, at)) at = s.indexOf('$', at + 1);
    return at;
  }

  /** The next `\)` or `\]` that is not itself an escaped backslash. */
  private closer(token: '\\)' | '\\]', from: number): number {
    const s = this.s;
    return this.find(token, from, (start) => {
      let at = s.indexOf(token, start);
      while (at !== -1 && isEscaped(s, at)) at = s.indexOf(token, at + 1);
      return at;
    });
  }

  /** The container markup — indentation, `>` markers — before `pos` on its line. */
  private markupBefore(pos: number): string {
    const lineStart = this.s.lastIndexOf('\n', pos - 1) + 1;
    let end = lineStart;
    while (end < pos && (this.s[end] === '>' || isSpace(this.s[end]))) end++;
    return this.s.slice(lineStart, end);
  }

  /**
   * True when [start, end) overlaps a verbatim span. Maths that runs into
   * code would either pair with a dollar the renderer reads as maths inside
   * the code, or swallow the code whole; neither is maths.
   */
  private crossesVerbatim(start: number, end: number): boolean {
    const spans = this.structure.verbatim;
    const n = firstEndingAfter(spans, start);
    return n < spans.length && spans[n].start < end;
  }

  /** Where the paragraph, heading or table cell holding `pos` ends. */
  private inlineEnd(pos: number): number {
    const spans = this.structure.inline;
    const n = firstEndingAfter(spans, pos);
    if (n < spans.length && spans[n].start <= pos) return spans[n].end;
    const lineEnd = this.s.indexOf('\n', pos);
    return lineEnd === -1 ? this.s.length : lineEnd;
  }

  /**
   * The first position at or after `from` that `search` finds, memoised per
   * kind. An answer found from `a` is still the answer from anywhere between
   * `a` and itself, so no scan re-reads text an earlier scan of the same kind
   * has already passed.
   */
  private find(key: string, from: number, search: (from: number) => number): number {
    const hit = this.memo.get(key);
    if (hit && from >= hit.from && from <= hit.at) return hit.at;
    const found = search(from);
    const at = found === -1 ? Infinity : found;
    this.memo.set(key, { from, at });
    return at;
  }
}
