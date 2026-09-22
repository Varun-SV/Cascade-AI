import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DocumentTooLargeError, EXPANSION_CEILING_CHARS, MAX_DOCUMENT_BYTES,
  isDocumentMime, resolveDocumentMime, parseDocument,
} from './documents.js';

import { DOCX_MIME, expandingDocx } from './test-support/expanding-docx.js';

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

// Removing the 200,000-character cut made extraction non-destructive, and left
// nothing bounding what an upload BECOMES. `MAX_DOCUMENT_BYTES` bounds the
// bytes that arrive; PDF and DOCX are compressed containers, so a small upload
// can decompress into a far larger body of text that is then persisted and
// read back into every run.
//
// The guard sits on extraction OUTPUT, which is where all three formats
// converge — plain text, `pdf-parse` and `mammoth.extractRawText` all return
// through `normalizeText` — so one check covers every route in rather than one
// per extractor, which is the arrangement that leaves the next extractor
// unguarded.
describe('extraction expansion ceiling', () => {
  it('refuses a document that expands past the ceiling instead of trimming it', async () => {
    const bytes = Buffer.from('x'.repeat(EXPANSION_CEILING_CHARS + 1), 'utf8');
    // REFUSED, not shortened. Keeping a prefix is precisely the behaviour this
    // release removed; re-introducing it here, further from the upload and
    // without telling anyone, would be worse for being harder to notice.
    await expect(parseDocument({ bytes, mime: 'text/plain', filename: 'bomb.txt' }))
      .rejects.toThrow(DocumentTooLargeError);
    await expect(parseDocument({ bytes, mime: 'text/plain', filename: 'bomb.txt' }))
      .rejects.toThrow(/over the 25M limit/);
  }, 30_000);

  it('cannot refuse a legitimate upload, because bytes bound characters', () => {
    // UTF-8 never yields more characters than bytes, so the largest plain-text
    // document the server accepts extracts to at most MAX_DOCUMENT_BYTES
    // characters. If this invariant ever broke, ordinary uploads would start
    // being rejected as bombs.
    expect(EXPANSION_CEILING_CHARS).toBeGreaterThan(MAX_DOCUMENT_BYTES);
  });

  it('keeps a document just under the ceiling whole', async () => {
    // The boundary is inclusive-accept: at the ceiling is fine, past it is not.
    const chars = EXPANSION_CEILING_CHARS;
    const text = await parseDocument({
      bytes: Buffer.from('x'.repeat(chars), 'utf8'), mime: 'text/plain', filename: 'huge.txt',
    });
    expect(text.length, 'every character survives right up to the line').toBe(chars);
  }, 30_000);

  // The finding this guard answers, reproduced rather than described: a DOCX
  // small enough to pass every per-plan byte ceiling, carrying more text than
  // the server will store.
  it('refuses a real DOCX that is tiny on the wire and enormous when opened', async () => {
    const bytes = await expandingDocx();

    expect(bytes.length, 'well under the 5 MB free-plan ceiling, so size alone lets it through')
      .toBeLessThan(1024 * 1024);

    await expect(parseDocument({ bytes, mime: DOCX_MIME, filename: 'bomb.docx' }))
      .rejects.toThrow(DocumentTooLargeError);
  }, 60_000);

  it('still accepts a DOCX that merely has a lot of text in it', async () => {
    // The same generator, an order of magnitude smaller: a genuinely long
    // document, not a crafted one. It must pass, whole — the ceiling exists to
    // refuse pathological expansion, not large documents.
    const bytes = await expandingDocx({ runChars: 2_000, runs: 500 });
    const text = await parseDocument({ bytes, mime: DOCX_MIME, filename: 'long.docx' });
    // At least the million characters of runs, plus whatever separators mammoth
    // puts between paragraphs — asserted as a floor rather than an exact count,
    // which would pin this test to the extractor's formatting instead of to the
    // thing under test.
    expect(text.length, 'every character of a merely long document survives')
      .toBeGreaterThanOrEqual(1_000_000);
    expect(text.length, 'and it is nowhere near the ceiling')
      .toBeLessThan(EXPANSION_CEILING_CHARS);
  }, 60_000);

  it('names the size, not corruption, so the user knows what to do', () => {
    const err = new DocumentTooLargeError(30_000_000);
    expect(err.message).toMatch(/30M characters/);
    expect(err.message).toMatch(/Split it into smaller files/);
    expect(err.name).toBe('DocumentTooLargeError');
  });
});
