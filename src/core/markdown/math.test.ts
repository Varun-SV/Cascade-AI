import { describe, expect, it } from 'vitest';
import { createMathNormalizer, normalizeMath } from './math.js';

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

describe('normalizeMath — structure comes from the parser (review round 1)', () => {
  it('leaves an indented code block as written', () => {
    const md = 'Example:\n\n    const price = "$5"\n    const m = "\\(x\\)"\n\nafter \\(n\\)';
    expect(normalizeMath(md)).toBe('Example:\n\n    const price = "$5"\n    const m = "\\(x\\)"\n\nafter $n$');
  });

  it('keeps display maths inside the blockquote it was written in', () => {
    // Was rewritten to `> $> x^2 >$`: inline maths with two stray `>`.
    expect(normalizeMath('> \\[\n> x^2\n> \\]')).toBe('> $$\n> x^2\n> $$');
    expect(normalizeMath('> > \\[\n> > a > b\n> > \\]')).toBe('> > $$\n> > a > b\n> > $$');
    // A continuation line keeps its quote marker out of the maths. (`> + b`
    // would not do: Markdown starts a list there, and the parser says so.)
    expect(normalizeMath('> where \\(a\n> = b\\) holds')).toBe('> where $a = b$ holds');
  });

  it('reads $$ inside a sentence as price tiers unless it holds maths', () => {
    expect(normalizeMath('Restaurant A: $$, restaurant B: $$.')).toBe('Restaurant A: \\$\\$, restaurant B: $$.');
    expect(normalizeMath('so $$x^2$$ grows')).toBe('so $$x^2$$ grows');
  });

  it('does not pair a price with a dollar inside a code span', () => {
    // remark-math pairs with the NEXT dollar, code or not: this rendered
    // "5; write `" as maths and broke the code sample.
    expect(normalizeMath('It costs $5; write `$x$` for value; another costs $10.')).toBe(
      'It costs \\$5; write `$x$` for value; another costs \\$10.',
    );
  });

  it('leaves every dollar in a link alone, however long the address', () => {
    const url = `https://example.com/${'a'.repeat(600)}?$top=5`;
    for (const md of [`See ${url} end`, `See <${url}> end`, `See [the report](${url}) for $5`]) {
      const out = normalizeMath(md);
      expect(out).toContain(url);
    }
    expect(normalizeMath(`See [the report](${url}) for $5`)).toBe(`See [the report](${url}) for \\$5`);
  });
});

describe('normalizeMath — review round 2', () => {
  it('does not let a price take the opening dollar of maths beside it', () => {
    // Rendered "5 (" as maths and left the real equation broken.
    expect(normalizeMath('It costs $5 ($x$ after conversion).')).toBe('It costs \\$5 ($x$ after conversion).');
    expect(normalizeMath('It costs $5,$x$ more')).toBe('It costs \\$5,$x$ more');
    // Maths does not end on an opening bracket, price or not.
    expect(normalizeMath('Let $a ($x$ here')).toBe('Let \\$a ($x$ here');
  });

  it('still pairs maths that happens to start with a digit, or ends on an escaped brace', () => {
    expect(normalizeMath('$2^n$,$x$')).toBe('$2^n$,$x$');
    expect(normalizeMath('$2$ and $3$')).toBe('$2$ and $3$');
    expect(normalizeMath('the set $\\{$')).toBe('the set $\\{$');
  });

  it('typesets display maths that opens a list item', () => {
    expect(normalizeMath('- \\begin{align*}\n  a &= b\n  \\end{align*}')).toBe(
      '- $$\n  \\begin{align*}\n  a &= b\n  \\end{align*}\n  $$',
    );
    // The same for \[…\], which collapsed to inline maths.
    expect(normalizeMath('- \\[\n  x^2\n  \\]')).toBe('- $$\n  x^2\n  $$');
    expect(normalizeMath('> 1. \\[\n>    x^2\n>    \\]')).toBe('> 1. $$\n>    x^2\n>    $$');
  });
});

describe('normalizeMath — review round 3', () => {
  it('typesets display maths the sentence punctuation follows, the punctuation inside', () => {
    // Left as raw TeX: the closer's line was not blank.
    expect(normalizeMath('\\begin{align*}\na &= b\n\\end{align*}.')).toBe('$$\n\\begin{align*}\na &= b\n\\end{align*}.\n$$');
    // Collapsed to inline maths.
    expect(normalizeMath('\\[ x^2 + y^2 \\].')).toBe('$$\nx^2 + y^2.\n$$');
    expect(normalizeMath('\\[\nx^2\n\\],')).toBe('$$\nx^2,\n$$');
    // Inside the container it was in.
    expect(normalizeMath('> \\[\n> x^2\n> \\].')).toBe('> $$\n> x^2.\n> $$');
    expect(normalizeMath('- \\begin{align*}\n  a &= b\n  \\end{align*};')).toBe('- $$\n  \\begin{align*}\n  a &= b\n  \\end{align*};\n  $$');
  });

  it('closes a $$ block the punctuation follows, which remark-math would leave open', () => {
    // `$$.` is no closing fence: the rest of the answer was read as maths.
    expect(normalizeMath('$$\nx^2\n$$.\n\nNext $x$ here.')).toBe('$$\nx^2.\n$$\n\nNext $x$ here.');
    expect(normalizeMath('$$\nx^2\n$$\n\nNext')).toBe('$$\nx^2\n$$\n\nNext');
  });

  it('still reads a closer that prose follows as it did', () => {
    expect(normalizeMath('\\[x^2\\]. Then more')).toBe('$x^2$. Then more');
    expect(normalizeMath('\\begin{align*}\na &= b\n\\end{align*} holds')).toBe('\\begin{align*}\na &= b\n\\end{align*} holds');
  });

  it('recognises prose in any script, not only English', () => {
    // Was `$任意选项$`, typeset as maths, while `\(optional\)` stayed text.
    expect(normalizeMath('\\(任意选项\\) and \\(optional\\)')).toBe('\\(任意选项\\) and \\(optional\\)');
    expect(normalizeMath('\\[引用所需\\]')).toBe('\\[引用所需\\]');
    expect(normalizeMath('\\(是\\), \\(opción\\), \\(пример\\)')).toBe('\\(是\\), \\(opción\\), \\(пример\\)');
    // Maths is still maths: short symbols, and words beside a maths sign.
    expect(normalizeMath('\\(x\\), \\(αβ\\), \\(速度 = d/t\\)')).toBe('$x$, $αβ$, $速度 = d/t$');
  });
});

/** mulberry32: a small seeded generator, so a failing case is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every construct the normaliser treats specially, and the Markdown around
// it that decides what is prose: code of each kind, quotes, lists, tables,
// headings, HTML, and openers that never close.
const FRAGMENTS = [
  'The rank is given by\n\\[ r = \\operatorname{rank} E(\\mathbb{Q}) \\]\nwhere r is finite.',
  'where \\(n\\) is prime and $x^2$ is even',
  'It costs $5 and $10 per month.',
  'It costs $5 ($x$ after conversion).',
  'Restaurant A: $$, restaurant B: $$.',
  '$$\ny = mx + b\n$$',
  '\\[\na &= b \\\\\n\nc &= d\n\\]',
  '\\begin{align*}\na &= b\n\\end{align*}',
  '```latex\n\\[ x^2 \\]\n$5 and $10\n```',
  '    const price = "$5"\n    const m = "\\(x\\)"',
  '> \\[\n> x^2\n> \\]',
  '> where \\(a\n> = b\\) holds',
  '1. Area:\n   \\[\n   A = \\pi r^2\n   \\]\n2. Cost $5 and \\(c\\)\n3. Done',
  '- \\begin{align*}\n  a &= b\n  \\end{align*}\n- next $x$',
  '| a | b |\n|---|---|\n| $5 | $x$ |',
  'Use `$x$` and `\\(y\\)` in code.',
  'See https://graph.microsoft.com/v1.0/users?$top=5 now.',
  '# Heading with \\(h\\)',
  'Title $x$\n===',
  '<!-- $5 \\(x\\) -->',
  'A stray \\[ opener with no closer',
  'A lone $$ tier',
  '$$\nunclosed block',
  '\\[\nunclosed display',
  'Plain text with no maths.',
  'Between $5 and $10, i.e. $x$ dollars.',
  '   \\[\n   x^2\n   \\]',
  ' - item \\(x\\)\n - item $y$\n   \\[\n   z\n   \\]',
  '\\begin{align*}\na &= b\n\\end{align*}.',
  '$$\nx^2\n$$.',
  '> \\[ x^2 \\],',
  '\\(任意选项\\) and \\(x\\)',
];
const SEPARATORS = ['\n', '\n\n', '\n\n\n', ' '];

describe('createMathNormalizer — a streamed answer', () => {
  it('equals normalizeMath at every step of a stream, whatever the answer', () => {
    // The property the incremental path rests on. Each generated answer is
    // streamed in random steps; after every step the incremental result must
    // be exactly what normalising the whole text gives.
    const random = prng(20260924);
    for (let doc = 0; doc < 120; doc++) {
      const parts = Array.from({ length: 3 + Math.floor(random() * 7) }, () => FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]);
      let text = parts[0];
      for (const part of parts.slice(1)) text += SEPARATORS[Math.floor(random() * SEPARATORS.length)] + part;
      const stream = createMathNormalizer();
      for (let n = 1 + Math.floor(random() * 20); ; n += 1 + Math.floor(random() * 40)) {
        const prefix = text.slice(0, Math.min(n, text.length));
        expect(stream(prefix), `doc ${doc}, ${prefix.length} of ${text.length} chars`).toBe(normalizeMath(prefix));
        if (n >= text.length) break;
      }
    }
  }, 60_000);

  it('equals normalizeMath on raw Markdown tokens, where half-written lines change the structure', () => {
    // Fragments are whole constructs; this is the opposite — list markers,
    // underlines, fences and delimiters thrown together, so a line is often
    // part-way to becoming something else when a boundary is chosen.
    const tokens = ['a', 'b', ' ', '\n', '\n\n', '$', '$5', '$x$', '$$', '\\(', '\\)', '\\[', '\\]', '`', '```',
      '    ', '  ', '- ', '-', '1. ', '2.', '> ', '>', '=', '*', '|', 'x^2', '\\begin{align*}', '\\end{align*}', '# ',
      'https://a.co/?$t=1', '.', '任意'];
    const random = prng(7);
    for (let doc = 0; doc < 150; doc++) {
      let text = '';
      const length = 30 + Math.floor(random() * 60);
      for (let t = 0; t < length; t++) text += tokens[Math.floor(random() * tokens.length)];
      const stream = createMathNormalizer();
      for (let n = 1; ; n += 1 + Math.floor(random() * 8)) {
        const prefix = text.slice(0, Math.min(n, text.length));
        expect(stream(prefix), `doc ${doc}: ${JSON.stringify(prefix)}`).toBe(normalizeMath(prefix));
        if (n >= text.length) break;
      }
    }
  }, 60_000);

  it('equals normalizeMath one character at a time', () => {
    const text = FRAGMENTS.join('\n\n');
    const stream = createMathNormalizer();
    for (let n = 1; n <= text.length; n++) {
      const prefix = text.slice(0, n);
      expect(stream(prefix), `${n} chars`).toBe(normalizeMath(prefix));
    }
  }, 60_000);

  it('does not start afresh after indented code, which the next block interrupts', () => {
    // After indented code — blank line or not — the parser reads `2)` as
    // interrupting it, and a list numbered from 2 cannot: the line is a
    // paragraph, and its `$5` a price. On its own it is a list item holding
    // code. Found by the token fuzz.
    const text = '    code\n\n2)     costs $5\nand more';
    const stream = createMathNormalizer();
    for (let n = 1; n <= text.length; n++) {
      const prefix = text.slice(0, n);
      expect(stream(prefix), `${n} chars`).toBe(normalizeMath(prefix));
    }
    expect(normalizeMath(text)).toBe('    code\n\n2)     costs \\$5\nand more');
  });

  it('starts again from scratch when the text is not an extension', () => {
    const stream = createMathNormalizer();
    stream('First answer with \\(x\\).\n\nAnd $5.\n\nMore');
    expect(stream('A different answer, $y$.')).toBe(normalizeMath('A different answer, $y$.'));
  });

  it('does not re-read what is final: a long answer streams in linear time', () => {
    // Normalising the whole answer at every token took 12 s here.
    const answer = 'The rank is \\(r\\) and\n\\[ x^2 + y^2 = z^2 \\]\nIt costs $5 and $10.\n\n'.repeat(120);
    const stream = createMathNormalizer();
    const started = performance.now();
    let last = '';
    for (let n = 8; n <= answer.length; n += 8) last = stream(answer.slice(0, n));
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(last).toBe(normalizeMath(answer.slice(0, answer.length - (answer.length % 8))));
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
    // Each of these, searched for its partner from scratch, is quadratic:
    // measured at 7 s unmemoised, against 1.3 s memoised — most of which is
    // the parse, linear and the same work react-markdown does on every render.
    // The limit leaves a slower CI machine room without letting 7 s through.
    const hostile = [
      '\\('.repeat(20_000),
      '\\['.repeat(20_000),
      '$a '.repeat(20_000),
      '$$a '.repeat(20_000),
    ].join(' ');
    const started = performance.now();
    normalizeMath(hostile);
    expect(performance.now() - started).toBeLessThan(4_500);
  });
});
