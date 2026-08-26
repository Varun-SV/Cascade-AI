// ─────────────────────────────────────────────
//  Cascade AI — Portable document block model
// ─────────────────────────────────────────────
//
//  The ONE parser behind every Office/PDF renderer, on every surface.
//
//  A run can only stream text, so a document deliverable always starts life as
//  Markdown (or CSV for a spreadsheet). Turning that into a `.docx`/`.pptx`/
//  `.xlsx` means parsing it into a small block model first, and that parsing is
//  identical whether it happens in the browser (cloud/web renders the binary on
//  download) or in Node (the desktop/CLI `generate_document` tool writes it to
//  disk). This module is that parser, and it is deliberately DOM-free and
//  dependency-free so both can import it.
//
//  Why it lives in the SDK rather than next to either caller: the layout logic
//  drifted once already — a docx image page-height cap was fixed in the browser
//  copy and there was nothing to keep a second copy honest. One module, two
//  importers, no drift.
//
//  Everything that needs a host (fetching an image, writing a file) is passed
//  IN by the caller; nothing here touches `fetch`, `fs`, `window` or `Buffer`.

// ── File names / delimited text ──────────────────────────────────

/** File extension (lowercased, no dot), or '' when there is none. */
export function fileExt(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Parse CSV/TSV into rows of cells. Handles quoted fields, escaped quotes (""),
 * and embedded newlines/commas inside quotes. Delimiter is auto-detected from the
 * extension (tsv → tab) or inferred from the first line. Bounded for safety.
 */
export function parseDelimited(text: string, name = ''): string[][] {
  const delim = fileExt(name) === 'tsv' || (text.indexOf('\t') !== -1 && text.indexOf(',') === -1) ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (ch === '\r') {
      // swallow — handled by the \n
    } else {
      cell += ch;
    }
    if (rows.length > 5000) break; // guard against a pathological file
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

// ── Charts ───────────────────────────────────────────────────────
//
// A model asked for "a chart of quarterly revenue" had exactly two options
// before this: draw it with an image model (which cannot be trusted to get the
// numbers, axes or labels right) or emit a flat Markdown table (which is not a
// chart). PowerPoint can hold a REAL, editable chart object, so there needed to
// be a way for the model to say "these exact numbers, drawn as bars".
//
// The convention is a fenced block whose info string names the chart type, and
// whose body is the same CSV the `.xlsx` convention already uses:
//
//     ```chart:bar
//     title: Quarterly revenue
//     Quarter,Revenue,Costs
//     Q1,120,80
//     Q2,150,95
//     ```
//
// CSV rather than JSON on purpose: models emit it far more reliably (no braces
// to balance, no trailing-comma hazard), it is the format they already know
// from the spreadsheet convention, and a malformed row degrades into "one bad
// row" rather than "the whole block failed to parse".

/** Chart shapes we can render. Anything else falls back to a table. */
export type ChartKind = 'bar' | 'line' | 'pie' | 'doughnut' | 'area' | 'scatter';

const CHART_ALIASES: Record<string, ChartKind> = {
  bar: 'bar', column: 'bar', bars: 'bar', barchart: 'bar', horizontalbar: 'bar',
  line: 'line', lines: 'line', linechart: 'line',
  pie: 'pie', piechart: 'pie',
  doughnut: 'doughnut', donut: 'doughnut',
  area: 'area', areachart: 'area',
  scatter: 'scatter', xy: 'scatter',
};

/** Normalise a fence's chart type, or null when it isn't one we can draw. */
export function chartKind(raw: string): ChartKind | null {
  return CHART_ALIASES[raw.trim().toLowerCase().replace(/[\s_-]/g, '')] ?? null;
}

export interface ChartSeries {
  name: string;
  values: number[];
}

/** A chart's data, format-independent. Renderers decide how to draw it. */
export interface ChartSpec {
  kind: ChartKind;
  /** Optional heading, from a leading `title:` line. */
  title?: string;
  /** Label for the category axis — the header row's first cell. */
  categoryName: string;
  categories: string[];
  series: ChartSeries[];
}

/**
 * Coerce a spreadsheet-ish cell to a number.
 *
 * Models write "$1,200", "42%", "1 234" and "—" for missing. Stripping the
 * decoration and treating the unparseable as 0 keeps one messy cell from
 * throwing away the surrounding series — the same "one dead image must not cost
 * the document" trade the image loader makes.
 */
function toNumber(cell: string): number {
  const cleaned = cell.replace(/[$£€¥,\s%]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a `chart:<kind>` fence body into a ChartSpec.
 *
 * Returns null for anything that isn't plausibly chartable (fewer than two
 * rows, or no series column). The caller then keeps the block as CODE rather
 * than dropping it, so a malformed chart is visible in the output instead of
 * silently missing.
 */
export function parseChartSpec(kind: ChartKind, body: string): ChartSpec | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let title: string | undefined;
  // An optional leading `title: …` line, consumed before the CSV starts.
  while (lines.length && !lines[0]!.trim()) lines.shift();
  const titleMatch = lines[0]?.match(/^\s*title\s*:\s*(.+)$/i);
  if (titleMatch) { title = titleMatch[1]!.trim(); lines.shift(); }

  const rows = parseDelimited(lines.join('\n').trim());
  if (rows.length < 2) return null;
  const header = rows[0]!.map((c) => c.trim());
  if (header.length < 2) return null;

  const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ''));
  if (!dataRows.length) return null;

  const categories = dataRows.map((r, i) => (r[0] ?? '').trim() || `Item ${i + 1}`);
  const series: ChartSeries[] = header.slice(1).map((name, col) => ({
    name: name || `Series ${col + 1}`,
    values: dataRows.map((r) => toNumber((r[col + 1] ?? '').trim())),
  }));
  if (!series.length) return null;

  return {
    kind,
    ...(title ? { title } : {}),
    categoryName: header[0]! || 'Category',
    categories,
    series,
  };
}

/**
 * The chart's data as table rows — the fallback for every format that cannot
 * hold a real chart object (Word and PDF; see render.ts).
 *
 * Losing the numbers would be strictly worse than the flat table this replaces,
 * so no renderer is allowed to just skip a chart block.
 */
export function chartToTableRows(spec: ChartSpec): string[][] {
  return [
    [spec.categoryName, ...spec.series.map((s) => s.name)],
    ...spec.categories.map((cat, i) => [cat, ...spec.series.map((s) => String(s.values[i] ?? 0))]),
  ];
}

// ── Block model ──────────────────────────────────────────────────
// A tiny subset of Markdown, parsed once into blocks that each renderer
// (PDF, Word, Excel) lays out in its own way.
/** True for a line that could be a row of a table already in progress. */
export function isTableRow(line: string): boolean {
  return line.includes('|');
}

/**
 * True when a table STARTS at `lines[i]`.
 *
 * Outer pipes are optional in Markdown — `Name | Score` over `--- | ---` is an
 * ordinary table — but a bare pipe is also ordinary prose punctuation, so a
 * line without the leading pipe only opens a table when the NEXT line is the
 * alignment rule. Requiring the leading pipe (as this did) silently left the
 * pipe-less form as bullet text; accepting any line with a pipe would turn
 * half of prose into tables.
 */
export function isTableStart(lines: string[], i: number): boolean {
  const line = (lines[i] ?? '').trim();
  if (!line.includes('|')) return false;
  // The alignment rule on the next line settles it either way.
  if (isAlignmentRule((lines[i + 1] ?? '').trim())) return true;
  // Otherwise a leading pipe needs a SECOND one to be a row rather than a line
  // that merely opens with a pipe — `| alternative syntax` is prose, and the
  // predicate this replaced required the closing delimiter for that reason.
  return line.startsWith('|') && line.indexOf('|', 1) !== -1;
}

/**
 * Consume a run of Markdown table lines starting at `start`.
 *
 * Shared by the block parser (docx/pdf) and the slide parser (pptx) so the two
 * cannot disagree about what a table is. They did: slides had no table branch
 * at all, so every row fell through to the bullet path and a deck showed
 * `|---|---|` as literal text where Word had shown a real table from the same
 * Markdown.
 */
/**
 * Is this the `|---|:--:|` rule under a table header?
 *
 * A character scan rather than the obvious `/^\|[\s:|-]+\|?\s*$/`, which is a
 * polynomial-backtracking regex and was flagged as such: `[\s:|-]+` and `\s*`
 * sit next to each other and BOTH match whitespace, so a line of `|` followed
 * by many tabs makes the engine try every split between them. Document text is
 * model-authored and can be arbitrarily long, which is exactly the input class
 * that turns quadratic matching into a hang.
 *
 * Each per-character test has no quantifier and cannot backtrack, so the whole
 * scan is linear in the row's length.
 */
function isAlignmentRule(row: string): boolean {
  if (row.length < 2) return false;
  let sawDash = false;
  let sawPipe = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (ch === '-') sawDash = true;
    else if (ch === '|') sawPipe = true;
    else if (ch !== ':' && !/\s/.test(ch)) return false;
  }
  // A dash is what makes it a RULE rather than a row of empty cells; the pipe
  // is what makes it a table rather than a horizontal rule.
  return sawDash && sawPipe;
}

/**
 * Split one table row into cells.
 *
 * `\|` is a literal pipe inside a cell — `| A \| B | union |` is a two-column
 * row, not three. Splitting on every pipe produced a phantom column and left
 * the backslash in the text, which the slide renderer then drew as a malformed
 * grid.
 */
function splitCells(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

export function scanTable(lines: string[], start: number): { rows: string[][]; next: number } {
  const rows: string[][] = [];
  let i = start;
  while (i < lines.length && isTableRow(lines[i] ?? '')) {
    const raw = (lines[i] ?? '').trim();
    // Skip the |---|:--:| alignment rule; it is punctuation, not data.
    if (!isAlignmentRule(raw)) {
      // Cells keep their inline markup. The Word renderer runs them through
      // inlineRuns, so stripping here silently flattened **bold** in every
      // docx table; a renderer that needs plain text (PowerPoint's addTable)
      // strips it itself.
      rows.push(splitCells(raw));
    }
    i++;
  }
  return { rows, next: i };
}

export type Block =
  | { t: 'heading'; level: number; text: string }
  | { t: 'para'; text: string }
  | { t: 'bullet'; ordered: boolean; index: number; text: string }
  | { t: 'code'; lines: string[] }
  | { t: 'quote'; text: string }
  | { t: 'table'; rows: string[][] }
  | { t: 'chart'; spec: ChartSpec }
  | { t: 'hr' };

export function parseBlocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let ordinal = 0; // running count within a contiguous ordered list
  const reset = () => { ordinal = 0; };
  while (i < lines.length) {
    const line = lines[i] ?? '';

    const fence = line.match(/^```+\s*(.*)$/);
    if (fence) { // code fence — or a `chart:` block wearing one
      const info = (fence[1] ?? '').trim();
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) { code.push(lines[i] ?? ''); i++; }
      i++; // closing fence
      const chartInfo = info.match(/^chart\s*:\s*(.+)$/i);
      const kind = chartInfo ? chartKind(chartInfo[1]!) : null;
      const spec = kind ? parseChartSpec(kind, code.join('\n')) : null;
      // An unparseable chart stays a code block: visible and fixable, never
      // silently dropped.
      out.push(spec ? { t: 'chart', spec } : { t: 'code', lines: code });
      reset();
      continue;
    }
    if (!line.trim()) { i++; reset(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push({ t: 'heading', level: h[1]!.length, text: h[2]! }); i++; reset(); continue; }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push({ t: 'hr' }); i++; reset(); continue; }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      ordinal = ordered ? ordinal + 1 : 0;
      out.push({ t: 'bullet', ordered, index: ordered ? ordinal : 0, text: li[3]! });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) { out.push({ t: 'quote', text: line.replace(/^>\s?/, '') }); i++; reset(); continue; }

    if (isTableStart(lines, i)) {
      const { rows, next } = scanTable(lines, i);
      i = next;
      out.push({ t: 'table', rows });
      reset();
      continue;
    }

    out.push({ t: 'para', text: line });
    i++;
    reset();
  }
  return out;
}

// ── Embedded images ──────────────────────────────────────────────
// A run can only stream text, so a generated picture reaches us as a Markdown
// image reference whose URL is whatever the host's media sink reported — a
// workspace path on desktop/CLI, `/api/files/:id` for a hosted run. Without the
// code below every renderer flattened that line through stripInline() into the
// caption "!alt (url)": the image exists, the deck just never shows it.

/** One `![alt](url)` reference lifted out of the Markdown. */
export interface ImageRef { alt: string; url: string }

/** A line that is NOTHING but a Markdown image. A line with prose around the
 *  image stays prose — only a standalone reference becomes a real picture. */
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

export function matchImageLine(s: string): ImageRef | null {
  const m = s.trim().match(IMAGE_LINE);
  return m ? { alt: m[1]!.trim(), url: m[2]!.trim() } : null;
}

/** Format + intrinsic size, sniffed from the bytes. */
export interface ImageInfo {
  /** Narrowed to the four raster types docx's ImageRun accepts. */
  type: 'png' | 'jpg' | 'gif' | 'bmp';
  mime: string;
  width: number;
  height: number;
}
export type LoadedImage = ImageInfo & { bytes: Uint8Array; alt: string };

/**
 * Read an image's format and pixel dimensions out of its header.
 *
 * Both renderers need this and neither can ask a host for it: docx must state
 * the type and a transformation in pixels up front, and decoding through an
 * <img> would make the exporter depend on the browser's image pipeline (and
 * fail under jsdom, and be unavailable in Node entirely). Returns null for
 * anything we can't measure, which the caller treats as "not embeddable" rather
 * than guessing a size.
 */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG — 8-byte signature, then the IHDR chunk's big-endian dimensions.
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: 'png', mime: 'image/png', width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF87a/GIF89a — little-endian, in the logical screen descriptor.
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { type: 'gif', mime: 'image/gif', width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // BMP — signed little-endian in the DIB header; a negative height just means
  // the rows are stored top-down, so the magnitude is the size either way.
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { type: 'bmp', mime: 'image/bmp', width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)) };
  }
  // JPEG — walk the segment chain to a start-of-frame marker, which is the only
  // place the dimensions live.
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      // SOF0–SOF15, minus DHT/JPG/DAC which share that marker range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpg', mime: 'image/jpeg', height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + dv.getUint16(i + 2);
    }
  }
  return null;
}

/**
 * base64 of raw bytes.
 *
 * Node's Buffer where it exists (desktop/CLI, and jsdom tests), otherwise a
 * chunked btoa so a multi-MB image can't blow the call stack through
 * String.fromCharCode's argument list. Read off globalThis rather than
 * referenced directly so a browser bundler never tries to resolve `Buffer`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as unknown as {
    Buffer?: { from(b: Uint8Array): { toString(enc: string): string } };
    btoa?: (s: string) => string;
  };
  if (g.Buffer) return g.Buffer.from(bytes).toString('base64');
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return g.btoa!(binary);
}

/** Strip inline Markdown emphasis to plain text (for renderers with no rich runs). */
export function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)');
}

/** One styled span of a line, from inlineRuns(). */
export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/**
 * Split a line's inline emphasis into styled spans.
 *
 * Kept format-neutral (plain objects, not docx TextRuns) so the Word renderer
 * and any future rich-text renderer share one understanding of what `**bold**`
 * means. A link becomes its "label (url)" text — no renderer here emits real
 * hyperlinks yet, and dropping the URL would lose information.
 */
export function inlineRuns(text: string): InlineRun[] {
  const acc: InlineRun[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]{1,500}\]\([^)]{1,2000}\)|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) acc.push({ text: text.slice(last, m.index) });
    const tok = m[0]!;
    if (tok.startsWith('**')) acc.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith('`')) acc.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith('[')) {
      const l = tok.match(/\[([^\]]{1,500})\]\(([^)]{1,2000})\)/);
      acc.push({ text: l ? `${l[1]} (${l[2]})` : tok });
    } else acc.push({ text: tok.slice(1, -1), italic: true });
    last = re.lastIndex;
  }
  if (last < text.length) acc.push({ text: text.slice(last) });
  return acc.length ? acc : [{ text }];
}

// ── Slides ───────────────────────────────────────────────────────

/**
 * A deck-level `animation:` directive, if the source opens with one.
 *
 * The vocabulary is deliberately deck-wide rather than per element. A model
 * writing Markdown will not reliably annotate thirty shapes, and a deck where
 * half the slides animate and half do not looks broken rather than designed.
 * Every deck gets a sane scheme for free; a directive tunes or disables it.
 *
 *   animation: none
 *   animation: transition=push entrance=fly advance=auto duration=300
 */
export function parseAnimationDirective(md: string): { rest: string; directive: Record<string, string> | null } {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const m = lines[i]?.match(/^[ \t]*animation[ \t]*:[ \t]*(.*)$/i);
  if (!m) return { rest: md, directive: null };
  const body = m[1]!.trim();
  const directive: Record<string, string> = {};
  if (/^none$/i.test(body)) {
    directive['transition'] = 'none';
    directive['entrance'] = 'none';
  } else {
    for (const pair of body.split(/[\s,]+/).filter(Boolean)) {
      const [k, v] = pair.split('=');
      if (k && v) directive[k.toLowerCase()] = v.toLowerCase();
    }
  }
  return { rest: lines.slice(i + 1).join('\n'), directive };
}

export interface Slide {
  title: string;
  body: string[];
  images: ImageRef[];
  charts: ChartSpec[];
  /**
   * Real tables, laid out as a grid on the slide.
   *
   * PowerPoint holds a genuine table shape, so a Markdown table has somewhere
   * to go. Before this existed, `parseSlide` had no branch for a `|…|` line
   * and every row fell through to the bullet path — a deck rendered
   * `|---|---|` as literal text where Word, from the same Markdown, showed a
   * proper table.
   */
  tables: string[][][];
}

/** Split a Markdown deck into slides: on `---` rules, else on top-level headings. */
export function splitSlides(md: string): Slide[] {
  const norm = md.replace(/\r\n/g, '\n').trim();
  let chunks = norm.split(/\n\s*-{3,}\s*\n/);
  if (chunks.length === 1) {
    const lines = norm.split('\n');
    const sections: string[] = [];
    let cur: string[] = [];
    for (const ln of lines) {
      if (/^#{1,2}\s+/.test(ln) && cur.some((l) => l.trim())) { sections.push(cur.join('\n')); cur = []; }
      cur.push(ln);
    }
    if (cur.length) sections.push(cur.join('\n'));
    if (sections.length > 1) chunks = sections;
  }
  return chunks.map(parseSlide)
    .filter((s) => s.title || s.body.length || s.images.length || s.charts.length || s.tables.length);
}

export function parseSlide(chunk: string): Slide {
  let title = '';
  const body: string[] = [];
  const images: ImageRef[] = [];
  const charts: ChartSpec[] = [];
  const tables: string[][][] = [];
  const lines = chunk.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    // A `chart:` fence is a real chart object, not bullet text. Pulled out here
    // (and its body skipped) so the numbers reach addChart() instead of being
    // flattened into a list of CSV rows.
    const fence = raw.match(/^[ \t]*```+[ \t]*chart[ \t]*:(.*)/i);
    if (fence) {
      const kind = chartKind(fence[1]!);
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) { bodyLines.push(lines[i] ?? ''); i++; }
      const spec = kind ? parseChartSpec(kind, bodyLines.join('\n')) : null;
      if (spec) charts.push(spec);
      else for (const bl of bodyLines) if (bl.trim()) body.push(stripInline(bl.trim()));
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    // An ordinary code fence. Only `chart:` fences were consumed above, so
    // everything else fell through — and a code sample containing `| in | out |`
    // had that line lifted out as a real table while its backticks stayed
    // behind in the body.
    if (/^```/.test(line)) {
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        const inner = (lines[i] ?? '').trim();
        if (inner) body.push(inner);
        i++;
      }
      continue;
    }
    // A table, not four bullets of pipe characters. Checked before the list and
    // paragraph branches, both of which would happily swallow `| a | b |`.
    if (isTableStart(lines, i)) {
      const { rows, next } = scanTable(lines, i);
      if (rows.length) tables.push(rows);
      i = next - 1; // the for-loop's i++ takes us to `next`
      continue;
    }
    const h = line.match(/^#{1,6}[ \t]+(.*)/);
    if (h) { if (!title) title = stripInline(h[1]!); else body.push(stripInline(h[1]!)); continue; }
    // A picture, not a bullet. Kept out of `body` entirely — stripInline would
    // turn it into the caption "!alt (url)" sitting where the image belongs.
    const img = matchImageLine(line);
    if (img) { images.push(img); continue; }
    const li = line.match(/^([-*+]|\d+[.)])[ \t]+(.*)/);
    if (li) {
      // Models commonly write the reference as a list item; same treatment.
      const bulletImg = matchImageLine(li[2]!);
      if (bulletImg) { images.push(bulletImg); continue; }
      body.push(stripInline(li[2]!));
      continue;
    }
    if (/^>\s?/.test(line)) { body.push(stripInline(line.replace(/^>\s?/, ''))); continue; }
    body.push(stripInline(line));
  }
  return { title, body, images, charts, tables };
}

/**
 * Pull `chart:` fences out of a source, returning them plus the text with those
 * fences removed.
 *
 * The spreadsheet convention is plain CSV, so a chart block inside an `.xlsx`
 * source would otherwise be parsed as three junk rows. SheetJS's community
 * build cannot write a chart OBJECT (see render.ts), so the data instead lands
 * on its own worksheet — real rows a user can select and chart in one click,
 * rather than data that vanished.
 */
export function extractCharts(source: string): { charts: ChartSpec[]; rest: string } {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const charts: ChartSpec[] = [];
  const rest: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i]!.match(/^[ \t]*```+[ \t]*chart[ \t]*:(.*)/i);
    if (!fence) { rest.push(lines[i]!); continue; }
    const kind = chartKind(fence[1]!);
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) { body.push(lines[i] ?? ''); i++; }
    const spec = kind ? parseChartSpec(kind, body.join('\n')) : null;
    if (spec) charts.push(spec);
    else rest.push(...body); // unparseable → leave the rows in the sheet
  }
  return { charts, rest: rest.join('\n') };
}
