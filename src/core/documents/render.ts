// ─────────────────────────────────────────────
//  Cascade AI — Office binary renderers (portable)
// ─────────────────────────────────────────────
//
//  Turns the shared block model (blocks.ts) into REAL OOXML binaries: a
//  `.docx`/`.pptx`/`.xlsx` is a ZIP of XML parts, not text with a suffix, which
//  is exactly why writing Markdown into a file named `report.docx` makes Word
//  say "corrupted".
//
//  Runs unchanged in the browser (cloud/web renders on download) and in Node
//  (the desktop/CLI `generate_document` tool writes to disk). The two things
//  that are NOT portable are passed in or feature-detected:
//
//    • fetching an image — the browser uses `fetch('/api/files/:id')` with the
//      session cookie, Node reads the workspace file that `generate_image`
//      already wrote. Callers supply `loadImageBytes`.
//    • base64 — `Buffer` in Node, chunked `btoa` in the browser (bytesToBase64).
//
//  Output is always a `Uint8Array`, so a caller can wrap it in a Blob or hand it
//  to `fs.writeFile` without this module knowing which world it is in.

import {
  type Block,
  type ChartSpec,
  type ImageRef,
  type LoadedImage,
  type Slide,
  bytesToBase64,
  chartToTableRows,
  extractCharts,
  inlineRuns,
  matchImageLine,
  parseBlocks,
  parseDelimited,
  sniffImage,
  splitSlides,
  stripInline,
  parseAnimationDirective,
} from './blocks.js';
import { animatePptx, DEFAULT_ANIMATION, type AnimationScheme } from './animate.js';

/** Office formats we can render into a real binary. */
export type DocumentFormat = 'docx' | 'pptx' | 'xlsx';

export const DOCUMENT_MIME: Record<DocumentFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function isDocumentFormat(ext: string): ext is DocumentFormat {
  return ext === 'docx' || ext === 'pptx' || ext === 'xlsx';
}

/**
 * Resolve a Markdown image URL to raw bytes, or null when it can't be had.
 *
 * Returning null rather than throwing is the contract: one dead image must
 * never cost the user the whole document.
 */
export type ImageByteLoader = (url: string) => Promise<Uint8Array | null>;

export interface RenderOptions {
  loadImageBytes?: ImageByteLoader;
  /** Target file name — only used to pick the CSV vs TSV delimiter for xlsx. */
  name?: string;
  /**
   * Host-level animation defaults for `.pptx`. A deck's own `animation:`
   * directive overrides these, because it lives in the document the user is
   * looking at.
   */
  animation?: Partial<AnimationScheme>;
}

/** Fetch + measure a referenced image, or null if either step fails. */
async function loadImage(ref: ImageRef, load?: ImageByteLoader): Promise<LoadedImage | null> {
  if (!load) return null;
  try {
    const bytes = await load(ref.url);
    if (!bytes || !bytes.length) return null;
    const info = sniffImage(bytes);
    if (!info || info.width <= 0 || info.height <= 0) return null;
    return { ...info, bytes, alt: ref.alt };
  } catch {
    return null;
  }
}

// ── Excel (SheetJS) ──────────────────────────────────────────────

/**
 * CSV → a real `.xlsx` workbook.
 *
 * SheetJS's community build can WRITE cells but not chart objects — charts are
 * not part of the open-source writer's feature set at any version we can
 * depend on. So a `chart:` block in a spreadsheet source does not become an
 * Excel chart; its data lands on its own worksheet as ordinary rows, which the
 * user can select and chart in one click. Dropping it would be the one
 * genuinely bad option.
 */
export async function renderXlsx(source: string, opts: RenderOptions = {}): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const { charts, rest } = extractCharts(source);
  const name = opts.name ?? '';
  const rows = parseDelimited(rest, name.toLowerCase().endsWith('.tsv') ? 'x.tsv' : 'x.csv');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.length ? rows : [['']]), 'Sheet1');

  const used = new Set(['Sheet1']);
  charts.forEach((spec, i) => {
    // Excel sheet names cap at 31 chars and reject : \ / ? * [ ].
    const base = (spec.title || `Chart ${i + 1}`).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 28) || `Chart ${i + 1}`;
    let sheetName = base;
    let n = 2;
    while (used.has(sheetName)) sheetName = `${base} ${n++}`.slice(0, 31);
    used.add(sheetName);
    // Numbers as numbers, not strings — the point of the fallback is that the
    // user can chart these rows themselves.
    const aoa: Array<Array<string | number>> = [
      [spec.categoryName, ...spec.series.map((s) => s.name)],
      ...spec.categories.map((cat, r) => [cat, ...spec.series.map((s) => s.values[r] ?? 0)]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  });

  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

// ── Word (docx) ──────────────────────────────────────────────────

// Word image caps, in px at 96dpi. Width alone isn't enough: a portrait image
// scaled only to fit 6.5in of width can still be far taller than the ~9in of
// vertical space between the default 1in margins, and docx has no auto-fit — it
// renders the ImageRun at exactly the size given, overflowing off the page.
const DOCX_MAX_W = 600; // ≈6.5in of body column
const DOCX_MAX_H = 864; // ≈9in of printable height (11in page − 1in top/bottom)

/**
 * Markdown → a real `.docx`.
 *
 * CHART GAP, stated explicitly: the `docx` library exposes no chart API (it
 * writes WordprocessingML; a Word chart needs a DrawingML chart part plus an
 * embedded workbook, which the library does not model). A `chart:` block
 * therefore renders as its title plus a real Word table of the same numbers —
 * every value preserved, nothing silently dropped. If a caller needs a drawn
 * chart in Word, the path is to render it to an image first and reference it
 * with ordinary `![alt](url)` syntax, which this renderer does embed.
 */
export async function renderDocx(md: string, opts: RenderOptions = {}): Promise<Uint8Array> {
  const d = await import('docx');
  const {
    Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType,
  } = d;
  const HEADINGS = [
    HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
  ];

  const runs = (text: string): InstanceType<typeof TextRun>[] =>
    inlineRuns(text).map((r) => new TextRun({
      text: r.text,
      ...(r.bold ? { bold: true } : {}),
      ...(r.italic ? { italics: true } : {}),
      ...(r.code ? { font: 'Courier New' } : {}),
    }));

  const tableOf = (rows: string[][]): InstanceType<typeof Table> => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((r) => new TableRow({
      children: r.map((c) => new TableCell({ children: [new Paragraph({ children: runs(c) })] })),
    })),
  });

  const imageParagraph = (img: LoadedImage): InstanceType<typeof Paragraph> => {
    // Scaled DOWN only, so a small image isn't blown out to a blurry full width.
    const scale = Math.min(1, DOCX_MAX_W / img.width, DOCX_MAX_H / img.height);
    return new Paragraph({
      children: [new ImageRun({
        type: img.type,
        data: img.bytes,
        transformation: { width: Math.round(img.width * scale), height: Math.round(img.height * scale) },
        ...(img.alt ? { altText: { name: img.alt, description: img.alt, title: img.alt } } : {}),
      })],
    });
  };
  // null → not an image line, or the load/sniff failed; either way the caller
  // falls through to rendering the line as text rather than losing it.
  const asImage = async (text: string): Promise<LoadedImage | null> => {
    const ref = matchImageLine(text);
    return ref ? await loadImage(ref, opts.loadImageBytes) : null;
  };

  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];
  for (const b of parseBlocks(md)) {
    switch (b.t) {
      case 'heading':
        children.push(new Paragraph({ heading: HEADINGS[Math.min(b.level, 6) - 1], children: runs(b.text) }));
        break;
      case 'para': {
        const img = await asImage(b.text);
        children.push(img ? imageParagraph(img) : new Paragraph({ children: runs(b.text) }));
        break;
      }
      case 'bullet': {
        // Models commonly write the reference as a list item.
        const img = await asImage(b.text);
        children.push(img ? imageParagraph(img) : new Paragraph({
          children: runs(b.text),
          ...(b.ordered ? { numbering: { reference: 'ol', level: 0 } } : { bullet: { level: 0 } }),
        }));
        break;
      }
      case 'code':
        for (const cl of b.lines) {
          children.push(new Paragraph({ children: [new TextRun({ text: cl || ' ', font: 'Courier New', size: 18 })] }));
        }
        break;
      case 'quote':
        children.push(new Paragraph({ indent: { left: 360 }, children: [new TextRun({ text: stripInline(b.text), italics: true })] }));
        break;
      case 'table':
        children.push(tableOf(b.rows));
        break;
      case 'chart':
        if (b.spec.title) {
          children.push(new Paragraph({ children: [new TextRun({ text: b.spec.title, bold: true })] }));
        }
        children.push(tableOf(chartToTableRows(b.spec)));
        break;
      case 'hr':
        children.push(new Paragraph({
          children: [],
          border: { bottom: { color: 'CCCCCC', space: 1, style: BorderStyle.SINGLE, size: 6 } },
        }));
        break;
    }
  }

  const doc = new Document({
    numbering: {
      config: [{ reference: 'ol', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }] }],
    },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [new TextRun('')] })] }],
  });
  // toArrayBuffer (not toBuffer/toBlob) is the one packer that works identically
  // in Node and in the browser — no Buffer global, no DOM Blob.
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

// ── PowerPoint (pptxgenjs) ───────────────────────────────────────

// pptxgenjs ships CommonJS-shaped types (an ESM `export default` inside a .d.ts
// belonging to a package with no `"type": "module"`), so under the SDK's
// NodeNext resolution TypeScript resolves the default export to the whole
// module NAMESPACE rather than to the class — even though Node loads the ESM
// build where `.default` really is the constructor. Naming the slice of the API
// this renderer uses is cheaper and clearer than a cast at every call site, and
// it type-checks identically under cloud/web's `bundler` resolution.
interface PptxChartSeries { name: string; labels: string[]; values: number[] }
interface PptxSlide {
  addText(text: string | Array<{ text: string; options?: Record<string, unknown> }>, options?: Record<string, unknown>): unknown;
  addImage(options: Record<string, unknown>): unknown;
  addChart(type: string, data: PptxChartSeries[], options?: Record<string, unknown>): unknown;
  addTable(
    rows: Array<Array<{ text: string; options?: Record<string, unknown> }>>,
    options?: Record<string, unknown>,
  ): unknown;
}
interface PptxPresentation {
  layout: string;
  readonly ChartType: Record<string, string>;
  addSlide(): PptxSlide;
  write(opts: { outputType: string }): Promise<unknown>;
}

/**
 * Find the constructor through whichever interop wrapper we were handed.
 *
 * Node ESM gives `{ default: Class }`; a CJS/bundled path can give
 * `{ default: { default: Class } }`. Walking to the first callable covers both
 * without pinning the renderer to one module system.
 */
function pptxConstructor(mod: unknown): new () => PptxPresentation {
  let c: unknown = mod;
  for (let i = 0; i < 3 && c && typeof c !== 'function'; i++) c = (c as { default?: unknown }).default;
  if (typeof c !== 'function') throw new Error('pptxgenjs did not export a constructor.');
  return c as new () => PptxPresentation;
}

/** LAYOUT_WIDE geometry, in inches. */
const SLIDE_H = 7.5;
const CONTENT_X = 0.6;
const CONTENT_W = 12.1;
const CONTENT_BOTTOM = 0.4;

/** A slide's visuals share one horizontal band; charts and pictures alike. */
type Visual =
  | { kind: 'image'; img: LoadedImage }
  | { kind: 'chart'; spec: ChartSpec }
  | { kind: 'table'; rows: string[][] };

/**
 * Markdown slides → a real `.pptx`.
 *
 * A `chart:` block becomes a genuine, editable PowerPoint chart via
 * `addChart` — the numbers live in the chart part's embedded workbook, so the
 * user can click Edit Data and see the exact values the model wrote. That is
 * the whole point of the convention: an image model cannot be trusted to draw
 * an accurate axis, and a Markdown table isn't a chart.
 */
export async function renderPptx(md: string, opts: RenderOptions = {}): Promise<Uint8Array> {
  // A deck-level directive can tune or switch off the animation; everything
  // else gets the default scheme without having to ask for it. See
  // parseAnimationDirective for why the vocabulary is not per element.
  const { rest, directive } = parseAnimationDirective(md);
  md = rest;
  const scheme = resolveAnimation(directive, opts.animation);
  const PptxGen = pptxConstructor(await import('pptxgenjs'));
  const pptx = new PptxGen();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 in

  const CHART_TYPES: Record<ChartSpec['kind'], string> = {
    bar: pptx.ChartType['bar']!,
    line: pptx.ChartType['line']!,
    pie: pptx.ChartType['pie']!,
    doughnut: pptx.ChartType['doughnut']!,
    area: pptx.ChartType['area']!,
    scatter: pptx.ChartType['scatter']!,
  };

  const slides = splitSlides(md);
  const blank: Slide = { title: '', body: [''], images: [], charts: [], tables: [] };
  for (const s of slides.length ? slides : [blank]) {
    const slide = pptx.addSlide();
    if (s.title) slide.addText(s.title, { x: 0.5, y: 0.35, w: 12.3, h: 0.9, fontSize: 28, bold: true, color: '1F2937' });
    const top = s.title ? 1.5 : 0.5;

    // Resolved before laying out the bullets: a slide that really has a visual
    // gives its text less vertical room, and whether it does isn't known until
    // the image loads come back. Failures drop out here, so a missing file
    // costs one picture rather than the export.
    const pics = (await Promise.all(s.images.map((r) => loadImage(r, opts.loadImageBytes))))
      .filter((p): p is LoadedImage => p !== null);
    const visuals: Visual[] = [
      ...s.charts.map((spec): Visual => ({ kind: 'chart', spec })),
      ...s.tables.map((rows): Visual => ({ kind: 'table', rows })),
      ...pics.map((img): Visual => ({ kind: 'image', img })),
    ];
    const bodyH = visuals.length ? 2.2 : 5.4;

    if (s.body.length) {
      slide.addText(
        s.body.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
        { x: CONTENT_X, y: top, w: CONTENT_W, h: bodyH, fontSize: 16, color: '374151', valign: 'top' },
      );
    }
    if (visuals.length) {
      const y = top + (s.body.length ? bodyH + 0.2 : 0);
      const h = Math.max(1, SLIDE_H - CONTENT_BOTTOM - y);
      const gap = 0.3;
      const w = (CONTENT_W - gap * (visuals.length - 1)) / visuals.length;
      visuals.forEach((v, i) => {
        const x = CONTENT_X + i * (w + gap);
        if (v.kind === 'image') {
          slide.addImage({
            data: `data:${v.img.mime};base64,${bytesToBase64(v.img.bytes)}`,
            x, y, w, h,
            // 'contain' keeps the aspect ratio inside the box — a stretched
            // render looks worse than a smaller correct one.
            sizing: { type: 'contain', w, h },
            ...(v.img.alt ? { altText: v.img.alt } : {}),
          });
        } else if (v.kind === 'table') {
          // A REAL table shape, not four bullets of pipe characters. The header
          // row is styled so the grid reads as a table at a glance; column
          // widths are even because Markdown carries no width information and
          // guessing from content length looks worse than a regular grid.
          const cols = Math.max(1, ...v.rows.map((r) => r.length));
          // pptxgenjs draws every row it is given and does not stop at the
          // slide edge — autoPage defaults off, so a long table simply runs
          // past the bottom and the rows below it are not in the deck at all.
          // Rows shrink to fit, and past the point where they would stop being
          // legible the table is cut with a count of what was dropped.
          const maxRows = Math.max(2, Math.floor(h / MIN_TABLE_ROW_H));
          const overflow = Math.max(0, v.rows.length - maxRows);
          const body = overflow > 0
            ? [...v.rows.slice(0, maxRows - 1), [`+${overflow} more rows`, ...Array(cols - 1).fill('')]]
            : v.rows;
          const rowH = Math.max(MIN_TABLE_ROW_H, Math.min(NATURAL_TABLE_ROW_H, h / body.length));
          slide.addTable(
            body.map((row, r) => padRow(row, cols).map((cell) => ({
              // addTable takes plain text, so inline markup is stripped HERE
              // rather than in the shared scanner — the Word renderer needs the
              // markers to style its cells.
              text: stripInline(cell),
              options: r === 0
                ? { bold: true, color: 'FFFFFF', fill: { color: '1F2937' } }
                : { color: '374151' },
            }))),
            {
              x, y, w,
              colW: Array.from({ length: cols }, () => w / cols),
              rowH,
              // Explicit rather than relying on the default: a future flip
              // would silently start appending slides mid-deck.
              autoPage: false,
              fontSize: 12,
              border: { type: 'solid', pt: 1, color: 'D1D5DB' },
              valign: 'middle',
            },
          );
        } else {
          slide.addChart(CHART_TYPES[v.spec.kind], chartData(v.spec), {
            x, y, w, h,
            showLegend: v.spec.series.length > 1 || v.spec.kind === 'pie' || v.spec.kind === 'doughnut',
            legendPos: 'b',
            showTitle: !!v.spec.title,
            ...(v.spec.title ? { title: v.spec.title } : {}),
            showValue: v.spec.kind === 'pie' || v.spec.kind === 'doughnut',
          });
        }
      });
    }
  }
  // 'arraybuffer' output avoids relying on a DOM Blob or a Node Buffer inside
  // the zip step, so it works identically in the browser, under jsdom, and in
  // plain Node.
  const bytes = new Uint8Array(await pptx.write({ outputType: 'arraybuffer' }) as ArrayBuffer);
  // pptxgenjs has no timeline of its own, so the animation is added to the
  // finished package. See animate.ts.
  return animatePptx(bytes, scheme);
}

/**
 * Resolve the animation scheme from the deck directive and the caller's option.
 *
 * Precedence is directive > caller > default: the directive is in the document
 * the user is looking at, so it should win over a host-wide setting.
 */
function resolveAnimation(
  directive: Record<string, string> | null,
  fromOpts: Partial<AnimationScheme> | undefined,
): AnimationScheme {
  const merged: AnimationScheme = { ...DEFAULT_ANIMATION, ...(fromOpts ?? {}) };
  // Every field is re-checked after the spread, whatever it came from.
  //
  // exactOptionalPropertyTypes is off, so a caller assembling this from
  // optional config can legally pass `{ durationMs: undefined }` — and a
  // spread puts that undefined over the default, emitting dur="NaN" or an
  // `undefined` transition child. PowerPoint reads either as a corrupt file,
  // which is the one outcome this whole path exists to avoid. Filtering
  // undefined out of the spread would fix that single case; validating the
  // result covers it along with every other way a host value can be wrong,
  // and a host value is no more trustworthy than the directive values that
  // were already being checked.
  if (!ANIMATION_VALUES.transition.includes(merged.transition)) merged.transition = DEFAULT_ANIMATION.transition;
  if (!ANIMATION_VALUES.entrance.includes(merged.entrance)) merged.entrance = DEFAULT_ANIMATION.entrance;
  if (!ANIMATION_VALUES.advance.includes(merged.advance)) merged.advance = DEFAULT_ANIMATION.advance;
  // Clamped and rounded, not merely checked for finiteness. OOXML wants an
  // unsigned integer here, and a large finite value serialises in scientific
  // notation — dur="1e+21" — which PowerPoint rejects or repairs. The
  // directive path has capped this all along; a host value is no different.
  merged.durationMs = Number.isFinite(merged.durationMs) && merged.durationMs > 0
    ? Math.round(Math.min(MAX_ANIMATION_MS, merged.durationMs))
    : DEFAULT_ANIMATION.durationMs;
  if (!directive) return merged;
  const pick = <K extends keyof AnimationScheme>(key: K, allowed: readonly string[]): void => {
    const raw = directive[key === 'durationMs' ? 'duration' : key];
    if (raw === undefined) return;
    if (key === 'durationMs') {
      const n = Number(raw);
      // A bad number is ignored rather than allowed to produce dur="NaN",
      // which PowerPoint reads as a corrupt file rather than a slow fade.
      if (Number.isFinite(n) && n > 0) merged.durationMs = Math.round(Math.min(MAX_ANIMATION_MS, n));
      return;
    }
    if (allowed.includes(raw)) (merged[key] as string) = raw;
  };
  pick('transition', ANIMATION_VALUES.transition);
  pick('entrance', ANIMATION_VALUES.entrance);
  pick('advance', ANIMATION_VALUES.advance);
  pick('durationMs', []);
  return merged;
}

/** Upper bound on an entrance duration, milliseconds. */
const MAX_ANIMATION_MS = 10_000;

/** The accepted values for each animation field, shared by both sources. */
const ANIMATION_VALUES = {
  transition: ['none', 'fade', 'push', 'wipe', 'split'],
  entrance: ['none', 'fade', 'appear', 'fly'],
  advance: ['click', 'auto'],
} as const satisfies Record<string, readonly string[]>;

/** Inches. Below this a 12pt row clips its own text. */
const MIN_TABLE_ROW_H = 0.28;
/** Inches. What a row gets when the slide has room for it. */
const NATURAL_TABLE_ROW_H = 0.4;

/**
 * Pad a table row out to the widest row's column count.
 *
 * A ragged Markdown table is ordinary — a trailing pipe left off one line is
 * enough — and pptxgenjs draws whatever cell count each row carries, so short
 * rows come out visibly misaligned rather than merely narrow.
 */
function padRow(row: string[], cols: number): string[] {
  return row.length >= cols ? row.slice(0, cols) : [...row, ...Array(cols - row.length).fill('')];
}

/** ChartSpec → pptxgenjs's series shape. */
function chartData(spec: ChartSpec): Array<{ name: string; labels: string[]; values: number[] }> {
  // Pie/doughnut hold exactly one series; handing them more draws only the
  // first anyway, so be explicit rather than silently ignoring the rest.
  const series = spec.kind === 'pie' || spec.kind === 'doughnut' ? spec.series.slice(0, 1) : spec.series;
  return series.map((s) => ({ name: s.name, labels: spec.categories, values: s.values }));
}

// ── Entry point ──────────────────────────────────────────────────

/**
 * Render a document source into the real binary for `format`.
 *
 * `source` is Markdown for docx, Markdown slides for pptx, and CSV for xlsx —
 * the same conventions the hosted `file:<name>.<ext>` blocks already use, so a
 * model that can produce one can produce the other.
 */
export async function renderDocument(
  format: DocumentFormat,
  source: string,
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  if (format === 'docx') return renderDocx(source, opts);
  if (format === 'pptx') return renderPptx(source, opts);
  return renderXlsx(source, opts);
}

export type { Block, ChartSpec, LoadedImage, Slide };
