// Client-side generation of binary document formats (PDF, Excel, Word,
// PowerPoint) from the model's plain-text source. A run streams text, so it
// can't emit a binary — instead the model writes Markdown (for PDF/Word), a
// Markdown slide deck (for PowerPoint), or CSV (for Excel) in a `file:name.ext`
// fence, and the browser renders the real binary on download. The heavy
// libraries are dynamically imported so they never enter the base bundle, and
// the user's content never leaves the client.
//
// The parsing and the Office renderers themselves live in the SDK
// (`src/core/documents`, imported here as `@cascade/documents`) because the
// desktop/CLI `generate_document` tool needs exactly the same behaviour and a
// second copy would drift — a docx image page-height cap was already fixed in
// one place with nothing keeping the other honest. What stays HERE is the part
// that is genuinely browser-specific: fetching `/api/files/:id` with the
// session cookie, the Blob wrappers, and the jsPDF renderer (the desktop side
// produces PDFs with pdfkit, so there is nothing to share).

import type { jsPDF } from 'jspdf';
import {
  chartToTableRows,
  isDocumentFormat,
  parseBlocks,
  renderDocument,
  stripInline,
  type Block,
} from '@cascade/documents';

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

/**
 * Fetch a referenced image so the shared renderer can embed it.
 *
 * `credentials: 'include'` matches how lib/api.ts talks to `/api/files/:id` —
 * same-origin, session cookie. Returns null on ANY failure (network, 404): one
 * dead image must never cost the user the whole document, so the renderer skips
 * it and exports the rest.
 */
async function fetchImageBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Render the model's source into a binary Blob for `ext`. */
export async function renderExport(ext: string, source: string, name: string): Promise<Blob> {
  if (isDocumentFormat(ext)) {
    const bytes = await renderDocument(ext, source, { name, loadImageBytes: fetchImageBytes });
    // Copied into a standalone ArrayBuffer: a Uint8Array view would keep its
    // (possibly much larger) backing buffer alive for the life of the Blob.
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: MIME[ext]! });
  }
  if (ext === 'pdf') return toPdf(source);
  return new Blob([source], { type: 'text/plain;charset=utf-8' });
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
  const table = (rows: string[][]) => {
    for (const r of rows) write(r.map((c) => stripInline(c)).join('    '), 10, 'normal', 'courier');
    y += 4;
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
        table(b.rows);
        break;
      // jsPDF draws no charts, so a chart block becomes its title plus the same
      // numbers as a table. Every value survives; only the drawing is lost.
      case 'chart':
        if (b.spec.title) { y += 4; write(stripInline(b.spec.title), 12, 'bold'); y += 2; }
        table(chartToTableRows(b.spec));
        break;
      case 'para':
        write(stripInline(b.text), 11, 'normal'); y += 4;
        break;
    }
  }
}
