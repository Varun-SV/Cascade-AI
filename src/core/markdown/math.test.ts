import { describe, expect, it } from 'vitest';
import { normalizeMath } from './math.js';

describe('normalizeMath — the delimiters GPT and Gemini write', () => {
  it('turns a \\[…\\] line into a display block (the reported answer)', () => {
    // As Gemini wrote it. Markdown reads `\[` as an escaped bracket, so this
    // reached the reader as "[ r = \operatorname{rank} E(\mathbb{Q}) ]".
    const answer = 'The rank is given by\n\\[ r = \\operatorname{rank} E(\\mathbb{Q}) \\]\nwhere r is finite.';
    expect(normalizeMath(answer)).toBe(
      'The rank is given by\n$$\nr = \\operatorname{rank} E(\\mathbb{Q}) \n$$\nwhere r is finite.',
    );
  });

  it('keeps a multi-line \\[ block whole, TeX line breaks included', () => {
    expect(normalizeMath('\\[\na &= b \\\\\nc &= d\n\\]')).toBe('$$\na &= b \\\\\nc &= d\n$$');
  });

  it('indents a display block to the list item it sits in', () => {
    // Unindented, the $$ lines would end the list and restart numbering.
    expect(normalizeMath('1. Area:\n   \\[\n   A = \\pi r^2\n   \\]\n2. Next')).toBe(
      '1. Area:\n   $$\n   A = \\pi r^2\n   $$\n2. Next',
    );
  });

  it('turns \\(…\\) into inline maths, single letters included', () => {
    expect(normalizeMath('where \\(n\\) is prime and \\(x_1 + x_2 = 1\\)')).toBe(
      'where $n$ is prime and $x_1 + x_2 = 1$',
    );
  });

  it('reads \\[…\\] inside a sentence as maths only when it holds a maths sign', () => {
    expect(normalizeMath('so \\[x^2\\] grows')).toBe('so $x^2$ grows');
    // How Markdown writes a literal bracket: a citation, a link-looking word.
    expect(normalizeMath('see \\[1\\] and \\[draft\\]')).toBe('see \\[1\\] and \\[draft\\]');
  });

  it('leaves prose that escaped its parentheses alone', () => {
    expect(normalizeMath('the \\(optional\\) flag')).toBe('the \\(optional\\) flag');
    expect(normalizeMath('\\[citation needed\\]')).toBe('\\[citation needed\\]');
  });

  it('wraps a bare display environment KaTeX can render', () => {
    expect(normalizeMath('\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}')).toBe(
      '$$\n\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}\n$$',
    );
  });

  it('does not wrap an environment KaTeX would reject, or one inside a sentence', () => {
    const itemize = '\\begin{itemize}\n\\item x\n\\end{itemize}';
    expect(normalizeMath(itemize)).toBe(itemize);
    const multline = '\\begin{multline}\na\n\\end{multline}';
    expect(normalizeMath(multline)).toBe(multline);
    expect(normalizeMath('use \\begin{cases} a \\end{cases} here')).toBe('use \\begin{cases} a \\end{cases} here');
  });

  it('lengthens the fence past any dollar inside the maths', () => {
    expect(normalizeMath('\\(\\text{cost } \\$5\\)')).toBe('$$\\text{cost } \\$5$$');
  });
});

describe('normalizeMath — dollars that are prices', () => {
  it('escapes prices, which remark-math would otherwise pair into maths', () => {
    // Rendered "5 and " as an equation before this.
    expect(normalizeMath('It costs $5 and $10 per month.')).toBe('It costs \\$5 and \\$10 per month.');
  });

  it('keeps real maths beside a price', () => {
    expect(normalizeMath('Between $5 and $10, i.e. $x$ dollars.')).toBe(
      'Between \\$5 and \\$10, i.e. $x$ dollars.',
    );
    expect(normalizeMath('$E = mc^2$ costs $5')).toBe('$E = mc^2$ costs \\$5');
  });

  it("applies Pandoc's rules: no space inside the delimiters, no digit after the closer", () => {
    expect(normalizeMath('$ x$')).toBe('\\$ x\\$');
    expect(normalizeMath('$x $')).toBe('\\$x \\$');
    expect(normalizeMath('$x$5')).toBe('\\$x\\$5');
  });

  it('never pairs dollars across a paragraph break', () => {
    expect(normalizeMath('$x\n\ny$')).toBe('\\$x\n\ny\\$');
  });

  it('leaves $…$ and $$…$$ maths exactly as written', () => {
    const md = 'Inline $x^2$ and\n\n$$\ny = mx + b\n$$\n\nand $$z$$ too';
    expect(normalizeMath(md)).toBe(md);
  });

  it('leaves the dollars in a URL alone', () => {
    // A lone `$` is what the guard is for: escaped, it would put a backslash
    // into the link. (A pair like `?$select=a&$filter=b` survives either way.)
    for (const md of [
      'Page with https://graph.microsoft.com/v1.0/users?$top=5 then stop',
      'See [the docs](https://example.com/api?$top=5) for more',
      'Call https://graph.microsoft.com/v1.0/users?$select=a&$filter=b now',
    ]) expect(normalizeMath(md)).toBe(md);
  });
});

describe('normalizeMath — what it must not touch', () => {
  it('leaves fenced code as written', () => {
    // A tilde fence, and a backtick fence with a blank line in it: neither can
    // be mistaken for a code span, so only fence detection protects them.
    const md = '~~~latex\n\\[ x^2 \\]\n~~~\n\n```\n$5 and $10\n\n\\(n\\)\n```\nafter \\(n\\)';
    expect(normalizeMath(md)).toBe(
      '~~~latex\n\\[ x^2 \\]\n~~~\n\n```\n$5 and $10\n\n\\(n\\)\n```\nafter $n$',
    );
  });

  it('leaves code spans as written', () => {
    const md = 'Use `\\(x\\)` or `$5 and $10` or ``a ` \\(b\\)``';
    expect(normalizeMath(md)).toBe(md);
  });

  it('treats an escaped backslash as a backslash, not an opener', () => {
    expect(normalizeMath('a \\\\[x^2\\\\] b')).toBe('a \\\\[x^2\\\\] b');
    expect(normalizeMath('price \\$5')).toBe('price \\$5');
  });

  it('leaves a delimiter still streaming in until its partner arrives', () => {
    expect(normalizeMath('The value is \\[ x = ')).toBe('The value is \\[ x = ');
    expect(normalizeMath('where \\(n')).toBe('where \\(n');
  });

  it('does not pair \\(…\\) across a paragraph break', () => {
    expect(normalizeMath('\\(x\n\ny\\)')).toBe('\\(x\n\ny\\)');
  });

  it('returns text with no backslash or dollar unchanged', () => {
    const md = 'Plain **markdown** with a [link](https://example.com).';
    expect(normalizeMath(md)).toBe(md);
  });

  it('is idempotent, because it runs again on every streamed token', () => {
    const samples = [
      'The rank\n\\[ r = \\operatorname{rank} \\]\nwhere \\(n\\) is $5 or $x$.',
      '1. Area:\n   \\[\n   A = \\pi r^2\n   \\]',
      '\\begin{align*}\na &= b\n\\end{align*}',
      '\\(\\text{cost } \\$5\\)',
    ];
    for (const md of samples) {
      const once = normalizeMath(md);
      expect(normalizeMath(once)).toBe(once);
    }
  });
});

describe('normalizeMath — cost', () => {
  it('stays linear on thousands of unmatched delimiters', () => {
    // Each of these, searched for its partner from scratch, is quadratic: tens
    // of billions of steps at this size. Memoised, it is one pass per kind.
    const hostile = [
      '\\('.repeat(40_000),
      '\\['.repeat(40_000),
      '$a '.repeat(40_000),
      '$$a '.repeat(40_000),
      '`'.repeat(3) + 'x ` y '.repeat(20_000),
    ].join(' ');
    const started = performance.now();
    normalizeMath(hostile);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
