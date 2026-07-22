import { describe, it, expect } from 'vitest';
import { isExportableExt, exportLabel, sourceHint, renderExport } from './exporters.js';

// jsdom's Blob has no arrayBuffer()/text(); read it through FileReader instead.
const readBytes = (blob: Blob): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(blob);
  });
const readText = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsText(blob);
  });

describe('exporters — client-side binary generation', () => {
  it('recognises the formats we render into binaries', () => {
    expect(isExportableExt('pdf')).toBe(true);
    expect(isExportableExt('xlsx')).toBe(true);
    expect(isExportableExt('txt')).toBe(false);
    expect(isExportableExt('md')).toBe(false);
    expect(isExportableExt('csv')).toBe(false);
  });

  it('labels the formats and hints the source they render from', () => {
    expect(exportLabel('xlsx')).toBe('Excel');
    expect(exportLabel('pdf')).toBe('PDF');
    expect(sourceHint('xlsx')).toBe('from CSV');
    expect(sourceHint('pdf')).toBe('from Markdown');
  });

  it('renders CSV source into a real .xlsx blob', async () => {
    const blob = await renderExport('xlsx', 'name,score\nAda,99\nGrace,97', 'data.xlsx');
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(blob.size).toBeGreaterThan(0);
    // A .xlsx is a ZIP archive — its first bytes are the "PK" local-file signature.
    const head = (await readBytes(blob)).subarray(0, 2);
    expect(String.fromCharCode(head[0]!, head[1]!)).toBe('PK');
  });

  it('renders Markdown source into a real PDF blob', async () => {
    const md = '# Report\n\nA paragraph with **bold**.\n\n- one\n- two\n';
    const blob = await renderExport('pdf', md, 'report.pdf');
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(0);
    // PDF files begin with the "%PDF" magic bytes.
    const head = (await readBytes(blob)).subarray(0, 4);
    expect(String.fromCharCode(...head)).toBe('%PDF');
  });

  it('falls back to a plain-text blob for a non-exportable extension', async () => {
    const blob = await renderExport('txt', 'just text', 'notes.txt');
    expect(blob.type).toContain('text/plain');
    expect(await readText(blob)).toBe('just text');
  });
});
