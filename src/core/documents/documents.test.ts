import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  chartKind,
  chartToTableRows,
  extractCharts,
  inlineRuns,
  parseBlocks,
  parseChartSpec,
  parseSlide,
  sniffImage,
  splitSlides,
} from './blocks.js';
import { isDocumentFormat, renderDocument, renderDocx, renderPptx, renderXlsx } from './render.js';

/**
 * A .docx/.pptx/.xlsx is a ZIP archive. Its first four bytes are the local-file
 * signature "PK\x03\x04" — the single cheapest proof that what we produced is a
 * real Office binary and not the plain text that made Word say "corrupted".
 */
const isZip = (b: Uint8Array): boolean =>
  b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Zip entry names live uncompressed in the local headers, so they're greppable. */
const entryNames = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);

/** A minimal PNG with a declared IHDR size — sniffImage only reads the header. */
const syntheticPng = (width: number, height: number): Uint8Array => {
  const buf = new Uint8Array(33);
  const dv = new DataView(buf.buffer);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  dv.setUint32(8, 13);
  buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  buf[24] = 8; buf[25] = 6;
  return buf;
};

describe('documents — block model', () => {
  it('parses the Markdown subset every renderer lays out', () => {
    const blocks = parseBlocks('# Title\n\ntext\n\n- one\n1. first\n\n> quote\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'para', 'bullet', 'bullet', 'quote', 'hr', 'table']);
    expect(blocks[0]).toMatchObject({ t: 'heading', level: 1, text: 'Title' });
    expect(blocks[6]).toMatchObject({ t: 'table', rows: [['a', 'b'], ['1', '2']] });
  });

  it('keeps an ordinary code fence a code block, info string and all', () => {
    const blocks = parseBlocks('```js\nconst a = 1;\n```\n');
    expect(blocks).toEqual([{ t: 'code', lines: ['const a = 1;'] }]);
  });

  it('splits inline emphasis into format-neutral runs', () => {
    expect(inlineRuns('a **b** c `d` [e](http://x)')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c ' },
      { text: 'd', code: true },
      { text: ' ' },
      { text: 'e (http://x)' },
    ]);
  });

  it('measures a PNG from its header without decoding it', () => {
    expect(sniffImage(syntheticPng(320, 240))).toEqual({ type: 'png', mime: 'image/png', width: 320, height: 240 });
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('documents — chart blocks', () => {
  it('normalises the chart type from the fence info string', () => {
    expect(chartKind('bar')).toBe('bar');
    expect(chartKind(' Column ')).toBe('bar');
    expect(chartKind('donut')).toBe('doughnut');
    expect(chartKind('sankey')).toBeNull();
  });

  it('parses a title line plus CSV into categories and series', () => {
    const spec = parseChartSpec('bar', 'title: Quarterly revenue\nQuarter,Revenue,Costs\nQ1,120,80\nQ2,150,95\n');
    expect(spec).toEqual({
      kind: 'bar',
      title: 'Quarterly revenue',
      categoryName: 'Quarter',
      categories: ['Q1', 'Q2'],
      series: [
        { name: 'Revenue', values: [120, 150] },
        { name: 'Costs', values: [80, 95] },
      ],
    });
  });

  it('coerces the decorated numbers models actually write', () => {
    // "$1,200", "42%", "(50)" and an em-dash for missing are all things a model
    // emits unprompted. One messy cell must not throw away the whole series.
    const spec = parseChartSpec('line', 'Month,Spend\nJan,"$1,200"\nFeb,42%\nMar,(50)\nApr,—\n');
    expect(spec?.series[0]?.values).toEqual([1200, 42, -50, 0]);
  });

  it('degrades an unparseable chart into a visible code block, never a silent drop', () => {
    // One row, so there is no data — and a fence type we cannot draw.
    expect(parseChartSpec('bar', 'Quarter,Revenue\n')).toBeNull();
    expect(parseBlocks('```chart:bar\nQuarter,Revenue\n```\n')).toEqual([{ t: 'code', lines: ['Quarter,Revenue'] }]);
    expect(parseBlocks('```chart:sankey\nA,1\nB,2\n```\n')).toEqual([{ t: 'code', lines: ['A,1', 'B,2'] }]);
  });

  it('surfaces a chart as its own block from parseBlocks', () => {
    const blocks = parseBlocks('# Deck\n\n```chart:pie\nSlice,Share\nA,60\nB,40\n```\n');
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'chart']);
    expect(blocks[1]).toMatchObject({ t: 'chart', spec: { kind: 'pie', categories: ['A', 'B'] } });
  });

  it('renders the same numbers as table rows for formats with no chart object', () => {
    const spec = parseChartSpec('bar', 'Quarter,Revenue\nQ1,120\nQ2,150\n')!;
    expect(chartToTableRows(spec)).toEqual([['Quarter', 'Revenue'], ['Q1', '120'], ['Q2', '150']]);
  });

  it('lifts a chart out of a slide instead of flattening it to bullets', () => {
    const slide = parseSlide('# Growth\n\n- context\n\n```chart:line\nYear,Users\n2024,10\n2025,25\n```\n');
    expect(slide.body).toEqual(['context']);
    expect(slide.charts).toHaveLength(1);
    expect(slide.charts[0]).toMatchObject({ kind: 'line', categories: ['2024', '2025'] });
    // Regression guard: the CSV rows must NOT show up as bullet text.
    expect(slide.body.join(' ')).not.toContain('2024');
  });

  it('keeps a slide that is nothing but a chart', () => {
    const slides = splitSlides('# One\n\ntext\n\n---\n\n```chart:bar\nA,B\nx,1\n```\n');
    expect(slides).toHaveLength(2);
    expect(slides[1]?.charts).toHaveLength(1);
  });

  it('separates chart blocks from the CSV body of a spreadsheet source', () => {
    const { charts, rest } = extractCharts('a,b\n1,2\n```chart:bar\nQ,V\nQ1,5\n```\nc,d\n');
    expect(charts).toHaveLength(1);
    expect(rest.split('\n').filter(Boolean)).toEqual(['a,b', '1,2', 'c,d']);
  });
});

describe('documents — real Office binaries', () => {
  it('knows which extensions it can render', () => {
    expect(isDocumentFormat('docx')).toBe(true);
    expect(isDocumentFormat('pptx')).toBe(true);
    expect(isDocumentFormat('xlsx')).toBe(true);
    expect(isDocumentFormat('pdf')).toBe(false);
    expect(isDocumentFormat('md')).toBe(false);
  });

  it('renders Markdown into a real .docx ZIP', async () => {
    const bytes = await renderDocx('# Title\n\nHello **world**.\n\n1. first\n2. second\n\n> a quote\n');
    expect(isZip(bytes)).toBe(true);
    expect(entryNames(bytes)).toContain('word/document.xml');
  }, 30_000);

  it('renders a Markdown deck into a real .pptx ZIP', async () => {
    const bytes = await renderPptx('# Slide one\n\n- point A\n\n---\n\n# Slide two\n\n- point B\n');
    expect(isZip(bytes)).toBe(true);
    expect(entryNames(bytes)).toContain('ppt/slides/slide2.xml');
  }, 30_000);

  it('renders CSV into a real .xlsx whose cells round-trip', async () => {
    const bytes = await renderXlsx('name,score\nAda,99\nGrace,97');
    expect(isZip(bytes)).toBe(true);

    const wb = XLSX.read(bytes, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]!]!;
    expect(ws['A1']?.v).toBe('name');
    // The CSV body is written VERBATIM — deliberately not type-coerced. Guessing
    // types over user-supplied CSV silently corrupts "007", "1-2" and leading-plus
    // phone numbers; only chart sheets (whose whole purpose is being charted) get
    // real numbers. See the chart-sheet test below.
    expect(ws['B2']?.v).toBe('99');
    expect(ws['A3']?.v).toBe('Grace');
  }, 30_000);

  it('routes each format through one entry point', async () => {
    for (const fmt of ['docx', 'pptx', 'xlsx'] as const) {
      expect(isZip(await renderDocument(fmt, '# x\n\na,b\n1,2\n'))).toBe(true);
    }
  }, 60_000);
});

describe('documents — charts in the rendered binaries', () => {
  const CHART_MD = '# Revenue\n\n```chart:bar\ntitle: Quarterly revenue\nQuarter,Revenue,Costs\nQ1,120,80\nQ2,150,95\n```\n';

  it('emits a REAL PowerPoint chart part, not a picture and not a table', async () => {
    const bytes = await renderPptx(CHART_MD);
    const names = entryNames(bytes);
    // A genuine editable chart object lives in its own part with its own rels.
    expect(names).toContain('ppt/charts/chart1.xml');
    // …and it is not smuggled in as an image.
    expect(names).not.toContain('ppt/media/image');

    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('ppt/charts/chart1.xml')!.async('string');
    expect(xml).toContain('<c:barChart>');
    // The model's exact numbers reach the chart's cached values.
    for (const v of ['120', '150', '80', '95']) expect(xml).toContain(v);
    expect(xml).toContain('Quarterly revenue');
  }, 30_000);

  it('produces no chart part when the deck has no chart block', async () => {
    const bytes = await renderPptx('# Slide\n\n- just a bullet\n');
    expect(entryNames(bytes)).not.toContain('ppt/charts/chart1.xml');
  }, 30_000);

  it('keeps every chart value in Word, which has no native chart object', async () => {
    const bytes = await renderDocx(CHART_MD);
    expect(isZip(bytes)).toBe(true);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    // Rendered as a real Word table, with the title above it — the data is
    // never silently dropped just because Word cannot draw it.
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('Quarterly revenue');
    for (const v of ['120', '150', '80', '95']) expect(xml).toContain(v);
  }, 30_000);

  it('lands chart data in Excel as real numeric rows on its own sheet', async () => {
    const bytes = await renderXlsx('region,total\nEMEA,5\n' + CHART_MD.slice(CHART_MD.indexOf('```')));
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toContain('Quarterly revenue');
    const ws = wb.Sheets['Quarterly revenue']!;
    expect(ws['A1']?.v).toBe('Quarter');
    expect(ws['B2']?.v).toBe(120);
    expect(ws['B2']?.t).toBe('n'); // a number the user can chart, not text
    // The surrounding CSV still becomes the main sheet.
    expect(wb.Sheets['Sheet1']!['A2']?.v).toBe('EMEA');
  }, 30_000);
});

describe('documents — embedded images', () => {
  const loader = (bytes: Uint8Array | null) => async () => bytes;

  it('embeds a standalone image reference into the .pptx', async () => {
    const bytes = await renderPptx('# Slide\n\n- point A\n\n![a cat](generated/cat.png)\n', {
      loadImageBytes: loader(syntheticPng(64, 64)),
    });
    expect(entryNames(bytes)).toContain('ppt/media/image');
  }, 30_000);

  it('accepts the reference as a list item, the way models usually write it', async () => {
    const bytes = await renderPptx('# Slide\n\n- ![a cat](generated/cat.png)\n', {
      loadImageBytes: loader(syntheticPng(64, 64)),
    });
    expect(entryNames(bytes)).toContain('ppt/media/image');
  }, 30_000);

  it('leaves a reference embedded in a sentence as prose', async () => {
    let called = 0;
    const bytes = await renderPptx('# Slide\n\n- see ![a cat](generated/cat.png) here\n', {
      loadImageBytes: async () => { called++; return syntheticPng(64, 64); },
    });
    expect(called).toBe(0);
    expect(entryNames(bytes)).not.toContain('ppt/media/image');
  }, 30_000);

  it('still exports when an image cannot be loaded', async () => {
    const bytes = await renderPptx('# Slide\n\n![gone](missing.png)\n', {
      loadImageBytes: async () => { throw new Error('ENOENT'); },
    });
    expect(isZip(bytes)).toBe(true);
    expect(entryNames(bytes)).not.toContain('ppt/media/image');
  }, 30_000);

  it('embeds into the .docx and caps a tall image to the printable page height', async () => {
    // Regression (shared with cloud/web): scaling on width alone let a 200x4000
    // portrait through at full height, overflowing the page — docx has no
    // auto-fit and renders the ImageRun at exactly the size given.
    const bytes = await renderDocx('# Report\n\n![tall](tall.png)\n', {
      loadImageBytes: loader(syntheticPng(200, 4000)),
    });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    const m = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBe(864 * 9525); // height is the binding constraint (EMUs)
    expect(Number(m![1])).toBeLessThan(600 * 9525);
  }, 30_000);

  it('falls back to text in the .docx when there is no image loader at all', async () => {
    const bytes = await renderDocx('# Report\n\n![gone](missing.png)\n');
    expect(isZip(bytes)).toBe(true);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).some((n) => n.startsWith('word/media/'))).toBe(false);
  }, 30_000);
});

describe('a table ends where the next block begins', () => {
  // scanTable continued while any line contained a pipe, so a block that
  // followed a table without a blank line between them — which Markdown does
  // not require — was eaten as table rows.
  const table = '| a | b |\n|---|---|\n| 1 | 2 |\n';

  it('does not swallow a heading', () => {
    const blocks = parseBlocks(`${table}## Notes | caveats`);
    expect(blocks.find((b) => b.t === 'table')).toEqual({ t: 'table', rows: [['a', 'b'], ['1', '2']] });
    expect(blocks.find((b) => b.t === 'heading')).toEqual({ t: 'heading', level: 2, text: 'Notes | caveats' });
  });

  it('does not swallow a list item', () => {
    const blocks = parseBlocks(`${table}- Choose A | B`);
    expect(blocks.find((b) => b.t === 'table')).toEqual({ t: 'table', rows: [['a', 'b'], ['1', '2']] });
    expect(blocks.find((b) => b.t === 'bullet')).toMatchObject({ t: 'bullet', text: 'Choose A | B' });
  });

  it('does not swallow a quote or a fence', () => {
    expect(parseBlocks(`${table}> quoted | aside`).find((b) => b.t === 'quote'))
      .toEqual({ t: 'quote', text: 'quoted | aside' });
    expect(parseBlocks(`${table}\`\`\`\na | b\n\`\`\``).find((b) => b.t === 'code'))
      .toEqual({ t: 'code', lines: ['a | b'] });
  });

  it('still reads a row whose first cell would otherwise look like a bullet', () => {
    // A leading pipe settles it: this is a row, not a list item.
    const blocks = parseBlocks('| a | b |\n|---|---|\n| - dash | 1 |');
    expect(blocks.find((b) => b.t === 'table')).toEqual({ t: 'table', rows: [['a', 'b'], ['- dash', '1']] });
  });

  it('still accepts the pipe-less alignment rule that looks like a bullet', () => {
    // `- | -` is a valid single-dash rule AND matches the bullet pattern, so
    // the rule has to be settled before the block-start check.
    const blocks = parseBlocks('A | B\n- | -\n1 | 2');
    expect(blocks.find((b) => b.t === 'table')).toEqual({ t: 'table', rows: [['A', 'B'], ['1', '2']] });
  });
});

describe('tilde fences are fences too', () => {
  // The backtick branch was added because a code sample containing `| in | out |`
  // had that line lifted out as a real table while its markers stayed in the
  // body. `~~~` is the other half of CommonMark's fence syntax and had the
  // identical bug.
  const sample = '~~~\n| in | out |\n|----|-----|\n~~~';

  it('keeps a tilde-fenced table-shaped block as code in parseBlocks', () => {
    const blocks = parseBlocks(`# T\n\n${sample}`);
    expect(blocks.find((b) => b.t === 'code')).toEqual({ t: 'code', lines: ['| in | out |', '|----|-----|'] });
    expect(blocks.find((b) => b.t === 'table')).toBeUndefined();
  });

  it('keeps a tilde-fenced table-shaped block out of a slide table', () => {
    const [slide] = splitSlides(`# T\n\n${sample}`);
    expect(slide!.tables).toHaveLength(0);
    expect(slide!.body.join('\n')).not.toContain('~~~');
  });

  it('does not let one fence character close the other', () => {
    // A ``` line inside a ~~~ block is content, not the closing fence.
    const blocks = parseBlocks('~~~\n```\n| a | b |\n~~~');
    expect(blocks.find((b) => b.t === 'code')).toEqual({ t: 'code', lines: ['```', '| a | b |'] });
    expect(blocks.find((b) => b.t === 'table')).toBeUndefined();
  });

  it('still parses a chart fence written with tildes', () => {
    const blocks = parseBlocks('~~~chart: bar\nQuarter,Revenue\nQ1,120\n~~~');
    expect(blocks.find((b) => b.t === 'chart')).toBeDefined();
  });
});

describe('an escaped pipe survives at the end of the last cell', () => {
  it('does not eat a trailing escaped pipe as the closing delimiter', () => {
    // No closing delimiter, and the final cell ends in a literal pipe. The
    // unconditional trailing-pipe strip removed it before the split ever saw
    // it, leaving a bare backslash behind.
    const blocks = parseBlocks('| a | b |\n|---|---|\n| x | ends with \\|');
    const table = blocks.find((b) => b.t === 'table') as { rows: string[][] };
    expect(table.rows[1]).toEqual(['x', 'ends with |']);
  });

  it('still strips a real unescaped closing delimiter', () => {
    const blocks = parseBlocks('| a | b |\n|---|---|\n| x | y |');
    const table = blocks.find((b) => b.t === 'table') as { rows: string[][] };
    expect(table.rows[1]).toEqual(['x', 'y']);
  });
});

describe('a fence opens at the indentation Markdown allows', () => {
  // parseBlocks required column zero while parseSlide trimmed before matching,
  // so the two parsers disagreed about what a code block is — the drift the
  // shared scanner exists to prevent. Up to three spaces still open a fence.
  for (const indent of ['', ' ', '  ', '   ']) {
    it(`treats a fence indented by ${indent.length} space(s) as code in both parsers`, () => {
      const md = `# T\n\n${indent}\`\`\`\n| in | out |\n${indent}\`\`\`\n\nAfter.`;
      const blocks = parseBlocks(md);
      expect(blocks.find((b) => b.t === 'code'), 'block parser').toEqual({ t: 'code', lines: ['| in | out |'] });
      expect(blocks.find((b) => b.t === 'table'), 'block parser').toBeUndefined();

      const [slide] = splitSlides(md);
      expect(slide!.tables, 'slide parser').toHaveLength(0);
    });
  }

  it('agrees with the slide parser on an indented tilde fence too', () => {
    const md = '# T\n\n  ~~~\n| in | out |\n  ~~~\n\nAfter.';
    expect(parseBlocks(md).find((b) => b.t === 'table')).toBeUndefined();
    expect(splitSlides(md)[0]!.tables).toHaveLength(0);
  });
});

describe('extractCharts uses the same fence rule as the parsers', () => {
  it('reads a chart fence written with tildes', () => {
    // Backtick-only here meant a `~~~chart:` block reached the spreadsheet as
    // raw CSV rows instead of becoming a chart.
    const { charts, rest } = extractCharts('~~~chart: bar\nQuarter,Revenue\nQ1,120\n~~~');
    expect(charts).toHaveLength(1);
    expect(charts[0]!.kind).toBe('bar');
    expect(rest).not.toContain('Q1,120');
  });

  it('leaves an ordinary fence alone', () => {
    const { charts, rest } = extractCharts('```\nnot a chart\n```');
    expect(charts).toHaveLength(0);
    expect(rest).toContain('not a chart');
  });
});
