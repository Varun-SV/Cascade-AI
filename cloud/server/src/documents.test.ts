import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_DOCUMENT_BYTES, isDocumentMime, resolveDocumentMime, parseDocument,
} from './documents.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)));

describe('isDocumentMime', () => {
  it('accepts pdf, docx, and the plain-text family', () => {
    expect(isDocumentMime('application/pdf')).toBe(true);
    expect(isDocumentMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
    expect(isDocumentMime('text/plain')).toBe(true);
    expect(isDocumentMime('text/markdown')).toBe(true);
    expect(isDocumentMime('application/json')).toBe(true);
  });
  it('rejects images and unknown types', () => {
    expect(isDocumentMime('image/png')).toBe(false);
    expect(isDocumentMime('application/octet-stream')).toBe(false);
  });
});

describe('resolveDocumentMime', () => {
  it('passes through a supported reported mime', () => {
    expect(resolveDocumentMime('application/pdf', 'x.pdf')).toBe('application/pdf');
  });
  it('falls back to the filename extension when the type is vague', () => {
    expect(resolveDocumentMime('application/octet-stream', 'notes.md')).toBe('text/markdown');
    expect(resolveDocumentMime('', 'data.csv')).toBe('text/csv');
    expect(resolveDocumentMime('', 'report.pdf')).toBe('application/pdf');
    expect(resolveDocumentMime('', 'memo.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
  it('returns undefined for unsupported files', () => {
    expect(resolveDocumentMime('application/octet-stream', 'archive.zip')).toBeUndefined();
    expect(resolveDocumentMime('image/png', 'photo.png')).toBeUndefined();
  });
});

describe('parseDocument', () => {
  it('reads plain text and collapses blank-line runs', async () => {
    const bytes = Buffer.from('First line\r\n\r\n\r\n\r\nSecond line   ', 'utf8');
    const text = await parseDocument({ bytes, mime: 'text/plain', filename: 'a.txt' });
    expect(text).toBe('First line\n\nSecond line');
  });

  it('keeps a very long document whole', async () => {
    // This test used to assert the opposite: that extraction cut the text at
    // 200,000 characters. That cut was a CONTEXT decision taken at INGESTION,
    // before storage — so the rest of the document was destroyed in front of
    // `resolveDocuments`, which sizes documents against the run's real window
    // and promises "no fixed byte cliff" in its own comment.
    //
    // How much of a document reaches a model is decided per run. How big a
    // document may be is a resource question, answered per plan at upload by
    // `PlanLimits.documentBytes`. Neither of those is extraction's business,
    // and extraction no longer has an opinion.
    const chars = 250_000;
    const bytes = Buffer.from('x'.repeat(chars), 'utf8');
    expect(bytes.length, 'a document this size is still within the hard ceiling')
      .toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);

    const text = await parseDocument({ bytes, mime: 'text/plain', filename: 'big.txt' });

    expect(text.length, 'every character survives extraction').toBe(chars);
  });

  it('extracts text from a real PDF', async () => {
    const text = await parseDocument({ bytes: fixture('sample.pdf'), mime: 'application/pdf', filename: 'sample.pdf' });
    expect(text).toContain('Hello Cascade PDF');
  });

  it('extracts text from a DOCX', async () => {
    const text = await parseDocument({
      bytes: fixture('sample.docx'),
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'sample.docx',
    });
    expect(text).toContain('Cascade sample document');
  });

  it('throws on an unsupported type', async () => {
    await expect(parseDocument({ bytes: Buffer.from('x'), mime: 'image/png', filename: 'x.png' })).rejects.toThrow();
  });
});
