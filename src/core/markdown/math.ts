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
//  cloud/web and the desktop renderer both import it through the
//  `@cascade/markdown` alias, so the two chat surfaces cannot disagree about
//  what counts as maths.
//
//  It runs on every streamed token, so each scan is linear. Every forward
//  search is memoised (see ProseScanner.find), because an answer can hold
//  thousands of unmatched delimiters and must not re-read a paragraph for each.

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
/** A word of four or more letters with no maths sign: prose in parentheses. */
const PROSE_WORD = /[A-Za-z]{4,}/;

/**
 * Rewrite `\(…\)`, `\[…\]` and bare display environments as `$…$` / `$$…$$`,
 * and escape every `$` that would not pair as maths under Pandoc's rules, so
 * remark-math cannot read a price as an equation. Code spans and fenced code
 * blocks are left exactly as written.
 */
export function normalizeMath(markdown: string): string {
  if (!markdown.includes('\\') && !markdown.includes('$')) return markdown;

  const out: string[] = [];
  let prose: string[] = [];
  let fence: Fence | null = null;
  const flush = (): void => {
    if (prose.length === 0) return;
    out.push(new ProseScanner(prose.join('\n')).run());
    prose = [];
  };

  for (const line of markdown.split('\n')) {
    if (fence) {
      out.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = opensFence(line);
    if (opened) {
      flush();
      fence = opened;
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join('\n');
}

interface Fence { char: string; length: number }

// Fence detection accepts any indentation, where CommonMark stops at three
// spaces, because a fence inside a nested list item is indented further. The
// error runs the safe way: text mistaken for a fence is left untouched.
function opensFence(line: string): Fence | null {
  let i = 0;
  while (line[i] === ' ' || line[i] === '\t') i++;
  const char = line[i];
  if (char !== '`' && char !== '~') return null;
  let length = 0;
  while (line[i + length] === char) length++;
  if (length < 3) return null;
  // A backtick fence's info string cannot contain a backtick (CommonMark 4.5);
  // a line like ```x``` is an inline code span, not a fence.
  if (char === '`' && line.includes('`', i + length)) return null;
  return { char, length };
}

function closesFence(line: string, fence: Fence): boolean {
  let i = 0;
  while (line[i] === ' ' || line[i] === '\t') i++;
  let length = 0;
  while (line[i + length] === fence.char) length++;
  return length >= fence.length && line.slice(i + length).trim() === '';
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
function inlineMath(content: string): string {
  let body = content.split('\n').map((l) => l.trim()).join(' ').trim();
  // A trailing backslash would sit against the closing fence; `\ ` is TeX's
  // control space, which renders as the space it looks like.
  if (body.endsWith('\\')) body += ' ';
  const fence = '$'.repeat(longestRun(body, '$') + 1);
  // A body that starts or ends with a dollar would merge into the fence.
  const pad = body.startsWith('$') || body.endsWith('$') ? ' ' : '';
  return `${fence}${pad}${body}${pad}${fence}`;
}

/** A `$$` block at `indent`, so it stays inside the list item it was in. */
function displayMath(indent: string, content: string): string {
  const lines = content.split('\n');
  while (lines.length > 0 && isBlank(lines[0])) lines.shift();
  while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
  const fence = '$'.repeat(Math.max(2, longestRun(content, '$') + 1));
  return [
    indent + fence,
    ...lines.map((line) => indent + line.trimStart()),
    indent + fence,
  ].join('\n');
}

interface Replacement {
  /** Where the replaced text begins, when that is before the opener: a display
   *  block replaces its line's indent too, then writes it back on every line. */
  start?: number;
  end: number;
  text: string;
}

/**
 * One left-to-right pass over prose (text outside fenced code). Escapes are
 * consumed in pairs, as Markdown reads them: `\\[` is a backslash and a
 * bracket, never an opener, and `\$` stays a literal dollar.
 */
class ProseScanner {
  private readonly out: string[] = [];
  private readonly blankLineStarts: number[];
  private readonly memo = new Map<string, { from: number; at: number }>();

  constructor(private readonly s: string) {
    this.blankLineStarts = blankLineStarts(s);
  }

  run(): string {
    const s = this.s;
    let i = 0;
    let emitted = 0;
    const replace = (start: number, r: Replacement): void => {
      this.out.push(s.slice(emitted, start), r.text);
      emitted = r.end;
      i = r.end;
    };

    while (i < s.length) {
      const ch = s[i];
      if (ch === '`') {
        i = this.skipCodeSpan(i);
        continue;
      }
      if (ch === '\\') {
        const next = s[i + 1];
        const r = next === '(' ? this.paren(i)
          : next === '[' ? this.bracket(i)
            : next === 'b' ? this.environment(i)
              : null;
        if (r) {
          replace(r.start ?? i, r);
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === '$') {
        const end = this.dollars(i);
        if (end === null) {
          replace(i, { end: i + 1, text: '\\$' });
          continue;
        }
        i = end;
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
    if (close === Infinity || close - open > MAX_INLINE || close >= this.paragraphEnd(open)) return null;
    const content = this.s.slice(open + 2, close);
    const body = content.trim();
    if (body === '' || (!MATH_SIGN.test(body) && PROSE_WORD.test(body))) return null;
    return { end: close + 2, text: inlineMath(content) };
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
    const content = s.slice(open + 2, close);
    const body = content.trim();
    if (body === '') return null;

    const lineStart = s.lastIndexOf('\n', open - 1) + 1;
    const indent = s.slice(lineStart, open);
    const lineEnd = s.indexOf('\n', close + 2);
    const rest = s.slice(close + 2, lineEnd === -1 ? s.length : lineEnd);
    if (isBlank(indent) && isBlank(rest)) {
      if (!MATH_SIGN.test(body) && PROSE_WORD.test(body)) return null;
      return { start: lineStart, end: close + 2, text: displayMath(indent, content) };
    }

    if (close - open > MAX_INLINE || close >= this.paragraphEnd(open)) return null;
    if (!MATH_SIGN.test(body)) return null;
    return { end: close + 2, text: inlineMath(content) };
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
    const indent = s.slice(lineStart, open);
    if (!isBlank(indent)) return null;

    const endToken = `\\end{${name}}`;
    const close = this.find(`end:${name}`, nameEnd, (from) => s.indexOf(endToken, from));
    if (close === Infinity || close - open > MAX_DISPLAY) return null;
    const end = close + endToken.length;
    const lineEnd = s.indexOf('\n', end);
    if (!isBlank(s.slice(end, lineEnd === -1 ? s.length : lineEnd))) return null;
    return { start: lineStart, end, text: displayMath(indent, s.slice(open, end)) };
  }

  /**
   * Where scanning resumes after a `$` run, or null when the dollar is not
   * maths and has to be escaped.
   *
   * A single `$` pairs with the NEXT unescaped `$` only, and only under
   * Pandoc's rules: the opener is followed by a non-space, the closer follows
   * one and is not followed by a digit. So "$5 and $10" is two prices, and so
   * is "$10k, while $x$" up to the `$x$`, which is still maths.
   */
  private dollars(open: number): number | null {
    const s = this.s;
    let run = 0;
    while (s[open + run] === '$') run++;

    // `?$select=` is part of an address. A GFM autolink already keeps it away
    // from remark-math, and escaping it would put a backslash in the link.
    if (this.inUrl(open)) return open + run;

    if (run >= 2) {
      // `$$…$$`, inline or as a block. An unclosed one is left as written: it
      // is most often the block the model is still streaming.
      const close = this.find(`dollars:${run}`, open + run, (from) => this.dollarRun(from, run));
      if (close === Infinity || close - open > MAX_DISPLAY) return open + run;
      return close + run;
    }

    if (isSpace(s[open + 1]) || open + 1 >= s.length) return null;
    const close = this.find('dollar', open + 1, (from) => this.unescapedDollar(from));
    if (close === Infinity || close - open > MAX_INLINE || close >= this.paragraphEnd(open)) return null;
    if (s[close + 1] === '$' || isSpace(s[close - 1]) || isDigit(s[close + 1])) return null;
    return close + 1;
  }

  /** True when `at` is inside a URL: the word it ends has a scheme or `www.`. */
  private inUrl(at: number): boolean {
    const s = this.s;
    const stop = Math.max(0, at - 512);
    let start = at;
    while (start > stop && !isSpace(s[start - 1])) start--;
    const word = s.slice(start, at);
    return word.includes('://') || word.includes('www.');
  }

  /** Skip a code span, or just its opening backticks when it never closes. */
  private skipCodeSpan(open: number): number {
    const s = this.s;
    let run = 0;
    while (s[open + run] === '`') run++;
    const close = this.find(`code:${run}`, open + run, (from) => this.backtickRun(from, run));
    if (close === Infinity || close >= this.paragraphEnd(open)) return open + run;
    return close + run;
  }

  private backtickRun(from: number, length: number): number {
    const s = this.s;
    let at = s.indexOf('`', from);
    while (at !== -1) {
      let run = 0;
      while (s[at + run] === '`') run++;
      if (run === length) return at;
      at = s.indexOf('`', at + run);
    }
    return -1;
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

  /** Where the paragraph holding `pos` ends: the next blank line, or the end. */
  private paragraphEnd(pos: number): number {
    const starts = this.blankLineStarts;
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= pos) lo = mid + 1;
      else hi = mid;
    }
    return lo < starts.length ? starts[lo] : this.s.length;
  }
}

/** The start index of every line that is empty or whitespace. */
function blankLineStarts(s: string): number[] {
  const starts: number[] = [];
  let lineStart = 0;
  let blank = true;
  for (let i = 0; i <= s.length; i++) {
    const ch = s[i];
    if (i === s.length || ch === '\n') {
      if (blank) starts.push(lineStart);
      lineStart = i + 1;
      blank = true;
    } else if (!isSpace(ch)) {
      blank = false;
    }
  }
  return starts;
}
