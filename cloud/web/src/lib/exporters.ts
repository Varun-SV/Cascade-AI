// Client-side generation of binary document formats (PDF, Excel) from the
// model's plain-text source. A run streams text, so it can't emit a binary —
// instead the model writes Markdown (for PDF) or CSV (for Excel) in a
// `file:name.ext` fence, and the browser renders the real binary on download.
// The heavy libraries are dynamically imported so they never enter the base
// bundle, and the user's content never leaves the client.

import type { jsPDF } from 'jspdf';
import { parseDelimited } from './fileKind.js';

/** Extensions we render into a binary on the client. Others download as text. */
export const EXPORTABLE_EXTS = new Set(['pdf', 'xlsx']);
export function isExportableExt(ext: string): boolean {
  return EXPORTABLE_EXTS.has(ext);
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Human label for the format badge (e.g. "PDF", "Excel"). */
export function exportLabel(ext: string): string {
  return ext === 'xlsx' ? 'Excel' : ext === 'pdf' ? 'PDF' : ext.toUpperCase();
}

/** What the model should write for a given target format, shown as a hint. */
export function sourceHint(ext: string): string {
  return ext === 'xlsx' ? 'from CSV' : ext === 'pdf' ? 'from Markdown' : '';
}

/** Render the model's source into a binary Blob for `ext`. */
export async function renderExport(ext: string, source: string, name: string): Promise<Blob> {
  if (ext === 'xlsx') return toXlsx(source, name);
  if (ext === 'pdf') return toPdf(source);
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

// ── PDF (jsPDF, a small Markdown block renderer) ─────────────────
async function toPdf(md: string): Promise<Blob> {
  const { jsPDF: JsPDF } = await import('jspdf');
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });
  renderMarkdown(doc, md);
  return doc.output('blob');
}

/** Strip inline Markdown emphasis to plain text (jsPDF has no rich inline runs). */
function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)');
}

/**
 * Lay out a subset of Markdown into a jsPDF document: headings, paragraphs,
 * bullet/number lists, code fences, blockquotes, tables, and rules — with word
 * wrapping and page breaks. Produces selectable text (not a rasterised image).
 */
function renderMarkdown(doc: jsPDF, md: string): void {
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

  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (/^```/.test(line)) { // code fence
      i++;
      doc.setFont('courier', 'normal');
      doc.setFontSize(9.5);
      y += 4;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
        for (const w of doc.splitTextToSize(lines[i] || ' ', maxW - 16)) { ensure(13); doc.text(w, M + 8, y); y += 13; }
        i++;
      }
      i++; // closing fence
      y += 8;
      continue;
    }
    if (!line.trim()) { y += 8; i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      const fs = level === 1 ? 20 : level === 2 ? 16 : level === 3 ? 13.5 : 12;
      y += 6; write(stripInline(h[2]!), fs, 'bold'); y += 3; i++;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { // horizontal rule
      ensure(12); doc.setDrawColor(210); doc.line(M, y, M + maxW, y); y += 12; i++;
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const bullet = /\d/.test(li[2]!) ? li[2]! : '•';
      write(`${bullet}  ${stripInline(li[3]!)}`, 11, 'normal', 'helvetica', 14); i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      write(stripInline(line.replace(/^>\s?/, '')), 11, 'normal', 'helvetica', 14); i++;
      continue;
    }
    if (/^\|.*\|/.test(line)) { // markdown table
      while (i < lines.length && /^\|.*\|/.test(lines[i] ?? '')) {
        const r = lines[i]!;
        if (!/^\|[\s:|-]+\|?\s*$/.test(r)) {
          const cells = r.replace(/^\||\|\s*$/g, '').split('|').map((c) => stripInline(c.trim()));
          write(cells.join('    '), 10, 'normal', 'courier');
        }
        i++;
      }
      y += 4;
      continue;
    }
    write(stripInline(line), 11, 'normal'); y += 4; i++;
  }
}
