import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_EXTRACTED_CHARS, isDocumentMime, resolveDocumentMime, parseDocument,
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
    const { text, truncated } = await parseDocument({ bytes, mime: 'text/plain', filename: 'a.txt' });
    expect(text).toBe('First line\n\nSecond line');
    expect(truncated).toBe(false);
  });

  it('truncates over the extracted-char cap', async () => {
    const bytes = Buffer.from('x'.repeat(MAX_EXTRACTED_CHARS + 5000), 'utf8');
    const { text, truncated } = await parseDocument({ bytes, mime: 'text/plain', filename: 'big.txt' });
    expect(text.length).toBe(MAX_EXTRACTED_CHARS);
    expect(truncated).toBe(true);
  });

  it('extracts text from a real PDF', async () => {
    const { text } = await parseDocument({ bytes: fixture('sample.pdf'), mime: 'application/pdf', filename: 'sample.pdf' });
    expect(text).toContain('Hello Cascade PDF');
  });

  it('extracts text from a DOCX', async () => {
    const { text } = await parseDocument({
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
