// Client-side generation of binary document formats (PDF, Excel, Word,
// PowerPoint) from the model's plain-text source. A run streams text, so it
// can't emit a binary — instead the model writes Markdown (for PDF/Word), a
// Markdown slide deck (for PowerPoint), or CSV (for Excel) in a `file:name.ext`
// fence, and the browser renders the real binary on download. The heavy
// libraries are dynamically imported so they never enter the base bundle, and
// the user's content never leaves the client.

import type { jsPDF } from 'jspdf';
import { parseDelimited } from './fileKind.js';

/** Extensions we render into a binary on the client. Others download as text. */
export const EXPORTABLE_EXTS = new Set(['pdf', 'xlsx', 'docx', 'pptx']);
export function isExportableExt(ext: string): boolean {
  return EXPORTABLE_EXTS.has(ext);
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const LABEL: Record<string, string> = { pdf: 'PDF', xlsx: 'Excel', docx: 'Word', pptx: 'PowerPoint' };
/** Human label for the format badge (e.g. "PDF", "Word"). */
export function exportLabel(ext: string): string {
  return LABEL[ext] ?? ext.toUpperCase();
}

const HINT: Record<string, string> = {
  pdf: 'from Markdown',
  xlsx: 'from CSV',
  docx: 'from Markdown',
  pptx: 'from Markdown slides',
};
/** What the model should write for a given target format, shown as a hint. */
export function sourceHint(ext: string): string {
  return HINT[ext] ?? '';
}

/** Render the model's source into a binary Blob for `ext`. */
export async function renderExport(ext: string, source: string, name: string): Promise<Blob> {
  if (ext === 'xlsx') return toXlsx(source, name);
  if (ext === 'pdf') return toPdf(source);
  if (ext === 'docx') return toDocx(source);
  if (ext === 'pptx') return toPptx(source);
  return new Blob([source], { type: 'text/plain;charset=utf-8' });
}

// ── Excel (SheetJS) ──────────────────────────────────────────────
async function toXlsx(source: string, name: string): Promise<Blob> {
  const XLSX = await import('xlsx');
  const rows = parseDelimited(source, name.toLowerCase().endsWith('.tsv') ? 'x.tsv' : 'x.csv');
  const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [['']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Blob([out], { type: MIME.xlsx });
}

// ── Shared Markdown block model ──────────────────────────────────
// A tiny subset of Markdown, parsed once into blocks that each renderer
// (PDF, Word) lays out in its own way.
type Block =
  | { t: 'heading'; level: number; text: string }
  | { t: 'para'; text: string }
  | { t: 'bullet'; ordered: boolean; index: number; text: string }
  | { t: 'code'; lines: string[] }
  | { t: 'quote'; text: string }
  | { t: 'table'; rows: string[][] }
  | { t: 'hr' };

function parseBlocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let ordinal = 0; // running count within a contiguous ordered list
  const reset = () => { ordinal = 0; };
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (/^```/.test(line)) { // code fence
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) { code.push(lines[i] ?? ''); i++; }
      i++; // closing fence
      out.push({ t: 'code', lines: code });
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

    if (/^\|.*\|/.test(line)) { // markdown table
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|/.test(lines[i] ?? '')) {
        const r = lines[i]!;
        if (!/^\|[\s:|-]+\|?\s*$/.test(r)) rows.push(r.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim()));
        i++;
      }
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
// image reference whose URL is whatever the host's media sink reported — for a
// hosted run, `/api/files/:id`. Without the code below every renderer flattened
// that line through stripInline() into the caption "!alt (url)", which is the
// text-placeholder bug wearing a different hat: the image exists, the deck just
// never shows it. Everything here still runs in the browser (see the file
// header) — bytes go straight from fetch into the zip, never to a server.

/** One `![alt](url)` reference lifted out of the Markdown. */
interface ImageRef { alt: string; url: string }

/** A line that is NOTHING but a Markdown image. A line with prose around the
 *  image stays prose — only a standalone reference becomes a real picture. */
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

function matchImageLine(s: string): ImageRef | null {
  const m = s.trim().match(IMAGE_LINE);
  return m ? { alt: m[1]!.trim(), url: m[2]!.trim() } : null;
}

/** Format + intrinsic size, sniffed from the bytes. */
interface ImageInfo {
  /** Narrowed to the four raster types docx's ImageRun accepts. */
  type: 'png' | 'jpg' | 'gif' | 'bmp';
  mime: string;
  width: number;
  height: number;
}
type LoadedImage = ImageInfo & { bytes: Uint8Array; alt: string };

/**
 * Read an image's format and pixel dimensions out of its header.
 *
 * Both renderers need this and neither can ask the DOM for it: docx must state
 * the type and a transformation in pixels up front, and decoding through an
 * <img> would make the exporter depend on the browser's image pipeline (and
 * fail under jsdom). Returns null for anything we can't measure, which the
 * caller treats as "not embeddable" rather than guessing a size.
 */
function sniffImage(b: Uint8Array): ImageInfo | null {
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

/** base64 of raw bytes, chunked so a multi-MB image can't blow the call stack
 *  through String.fromCharCode's argument list. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Fetch a referenced image and prepare it for embedding.
 *
 * `credentials: 'include'` matches how lib/api.ts talks to `/api/files/:id` —
 * same-origin, session cookie. Returns null on ANY failure (network, 404, an
 * unrecognised format): one dead image must never cost the user the whole
 * document, so the caller skips it and exports the rest.
 */
async function loadImage(ref: ImageRef): Promise<LoadedImage | null> {
  try {
    const res = await fetch(ref.url, { credentials: 'include' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const info = sniffImage(bytes);
    if (!info || info.width <= 0 || info.height <= 0) return null;
    return { ...info, bytes, alt: ref.alt };
  } catch {
    return null;
  }
}

/** Strip inline Markdown emphasis to plain text (for renderers with no rich runs). */
function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)');
}

// ── PDF (jsPDF, laying out the shared block model) ───────────────
async function toPdf(md: string): Promise<Blob> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });
  renderPdf(doc, parseBlocks(md));
  return doc.output('blob');
}

/**
 * Lay out the block model into a jsPDF document with word wrapping and page
 * breaks. Produces selectable text (not a rasterised image).
 */
function renderPdf(doc: jsPDF, blocks: Block[]): void {
  const size = doc.internal.pageSize;
  const M = 56;
  const maxW = size.getWidth() - M * 2;
  const bottom = size.getHeight() - M;
  let y = M;

  const ensure = (h: number) => { if (y + h > bottom) { doc.addPage(); y = M; } };
  const write = (text: string, fs: number, style: 'normal' | 'bold', font = 'helvetica', indent = 0) => {
    doc.setFont(font, style);
    doc.setFontSize(fs);
    const lh = fs * 1.35;
    for (const ln of doc.splitTextToSize(text, maxW - indent)) {
      ensure(lh);
      doc.text(ln, M + indent, y);
      y += lh;
    }
  };

  for (const b of blocks) {
    switch (b.t) {
      case 'heading': {
        const fs = b.level === 1 ? 20 : b.level === 2 ? 16 : b.level === 3 ? 13.5 : 12;
        y += 6; write(stripInline(b.text), fs, 'bold'); y += 3;
        break;
      }
      case 'hr':
        ensure(12); doc.setDrawColor(210); doc.line(M, y, M + maxW, y); y += 12;
        break;
      case 'bullet':
        write(`${b.ordered ? `${b.index}.` : '•'}  ${stripInline(b.text)}`, 11, 'normal', 'helvetica', 14);
        break;
      case 'quote':
        write(stripInline(b.text), 11, 'normal', 'helvetica', 14);
        break;
      case 'code':
        doc.setFont('courier', 'normal'); doc.setFontSize(9.5); y += 4;
        for (const cl of b.lines) for (const w of doc.splitTextToSize(cl || ' ', maxW - 16)) { ensure(13); doc.text(w, M + 8, y); y += 13; }
        y += 8;
        break;
      case 'table':
        for (const r of b.rows) write(r.map((c) => stripInline(c)).join('    '), 10, 'normal', 'courier');
        y += 4;
        break;
      case 'para':
        write(stripInline(b.text), 11, 'normal'); y += 4;
        break;
    }
  }
}

// ── Word (docx, laying out the shared block model) ───────────────
async function toDocx(md: string): Promise<Blob> {
  const d = await import('docx');
  const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType } = d;
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

  // Parse a line's inline emphasis into styled TextRuns.
  const runs = (text: string): InstanceType<typeof TextRun>[] => {
    const acc: InstanceType<typeof TextRun>[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*\*)/g;
    let last = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) acc.push(new TextRun(text.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('**')) acc.push(new TextRun({ text: tok.slice(2, -2), bold: true }));
      else if (tok.startsWith('`')) acc.push(new TextRun({ text: tok.slice(1, -1), font: 'Courier New' }));
      else if (tok.startsWith('[')) { const l = tok.match(/\[([^\]]+)\]\(([^)]+)\)/); acc.push(new TextRun(l ? `${l[1]} (${l[2]})` : tok)); }
      else acc.push(new TextRun({ text: tok.slice(1, -1), italics: true }));
      last = re.lastIndex;
    }
    if (last < text.length) acc.push(new TextRun(text.slice(last)));
    return acc.length ? acc : [new TextRun(text)];
  };

  // A standalone `![alt](url)` line becomes a real picture. Word needs the type
  // and an explicit pixel size up front, so the bytes are measured (sniffImage)
  // and scaled down to fit the body column AND the printable page height —
  // never up, so a small image isn't blown out to a blurry full width. Width
  // alone isn't enough: a portrait (tall) image scaled only to fit 6.5in of
  // width can still be far taller than the ~9in of vertical space between the
  // default 1in top/bottom margins, and docx has no auto-fit — it renders the
  // ImageRun at exactly the size given, overflowing onto (or off) the page.
  const DOCX_MAX_W = 600; // ≈6.5in of body column at 96dpi
  const DOCX_MAX_H = 864; // ≈9in of printable page height at 96dpi (11in page − 1in top/bottom margins)
  const imageParagraph = (img: LoadedImage): InstanceType<typeof Paragraph> => {
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
  // null → not an image line, or the fetch/sniff failed; either way the caller
  // falls through to rendering the line as text rather than losing it.
  const asImage = async (text: string): Promise<LoadedImage | null> => {
    const ref = matchImageLine(text);
    return ref ? await loadImage(ref) : null;
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
        for (const cl of b.lines) children.push(new Paragraph({ children: [new TextRun({ text: cl || ' ', font: 'Courier New', size: 18 })] }));
        break;
      case 'quote':
        children.push(new Paragraph({ indent: { left: 360 }, children: [new TextRun({ text: stripInline(b.text), italics: true })] }));
        break;
      case 'table':
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph({ children: runs(c) })] })) })),
        }));
        break;
      case 'hr':
        children.push(new Paragraph({ children: [], border: { bottom: { color: 'CCCCCC', space: 1, style: BorderStyle.SINGLE, size: 6 } } }));
        break;
    }
  }

  const doc = new Document({
    numbering: { config: [{ reference: 'ol', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }] }] },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [new TextRun('')] })] }],
  });
  return Packer.toBlob(doc);
}

// ── PowerPoint (pptxgenjs, one slide per Markdown section) ────────
interface Slide { title: string; body: string[]; images: ImageRef[] }

/** Split a Markdown deck into slides: on `---` rules, else on top-level headings. */
function splitSlides(md: string): Slide[] {
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
  return chunks.map(parseSlide).filter((s) => s.title || s.body.length || s.images.length);
}

function parseSlide(chunk: string): Slide {
  let title = '';
  const body: string[] = [];
  const images: ImageRef[] = [];
  for (const raw of chunk.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { if (!title) title = stripInline(h[1]!); else body.push(stripInline(h[1]!)); continue; }
    // A picture, not a bullet. Kept out of `body` entirely — stripInline would
    // turn it into the caption "!alt (url)" sitting where the image belongs.
    const img = matchImageLine(line);
    if (img) { images.push(img); continue; }
    const li = line.match(/^([-*+]|\d+[.)])\s+(.*)$/);
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
  return { title, body, images };
}

/** LAYOUT_WIDE geometry, in inches. */
const SLIDE_H = 7.5;
const CONTENT_X = 0.6;
const CONTENT_W = 12.1;
const CONTENT_BOTTOM = 0.4;

async function toPptx(md: string): Promise<Blob> {
  const PptxGen = (await import('pptxgenjs')).default;
  const pptx = new PptxGen();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 in
  const slides = splitSlides(md);
  const blank: Slide = { title: '', body: [''], images: [] };
  for (const s of slides.length ? slides : [blank]) {
    const slide = pptx.addSlide();
    if (s.title) slide.addText(s.title, { x: 0.5, y: 0.35, w: 12.3, h: 0.9, fontSize: 28, bold: true, color: '1F2937' });
    const top = s.title ? 1.5 : 0.5;

    // Resolved before laying out the bullets: a slide that really has a picture
    // gives its text less vertical room, and whether it does isn't known until
    // the fetches come back. Failures drop out here, so a 404 costs one image
    // rather than the export.
    const pics = (await Promise.all(s.images.map(loadImage))).filter((p): p is LoadedImage => p !== null);
    const bodyH = pics.length ? 2.2 : 5.4;

    if (s.body.length) {
      slide.addText(
        s.body.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
        { x: CONTENT_X, y: top, w: CONTENT_W, h: bodyH, fontSize: 16, color: '374151', valign: 'top' },
      );
    }
    if (pics.length) {
      const y = top + (s.body.length ? bodyH + 0.2 : 0);
      const h = Math.max(1, SLIDE_H - CONTENT_BOTTOM - y);
      const gap = 0.3;
      const w = (CONTENT_W - gap * (pics.length - 1)) / pics.length;
      pics.forEach((p, i) => {
        slide.addImage({
          data: `data:${p.mime};base64,${bytesToBase64(p.bytes)}`,
          x: CONTENT_X + i * (w + gap),
          y,
          w,
          h,
          // 'contain' keeps the aspect ratio inside the box — a stretched
          // render looks worse than a smaller correct one.
          sizing: { type: 'contain', w, h },
          ...(p.alt ? { altText: p.alt } : {}),
        });
      });
    }
  }
  // 'arraybuffer' output avoids relying on a DOM Blob inside the zip step, so it
  // works identically in the browser and under jsdom in tests.
  const buf = (await pptx.write({ outputType: 'arraybuffer' })) as ArrayBuffer;
  return new Blob([buf], { type: MIME.pptx });
}
