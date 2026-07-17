import { createRequire } from 'module';

// pdf-parse / mammoth are CommonJS with no first-class ESM types; load them
// through createRequire so the bundle resolves them at runtime without pulling
// their (heavy, optional) type surface into our build.
const require = createRequire(import.meta.url);

/** Hard ceiling on a single uploaded document (raw bytes). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Cap on the extracted text we keep + inject, so one huge PDF can't blow the
 *  run's context budget. The extended-context path still chunks what remains. */
export const MAX_EXTRACTED_CHARS = 200_000;

// Document MIME types we accept. Plain-text family is parsed directly; PDF and
// DOCX go through dedicated extractors. Everything else is rejected up front.
const PLAINTEXT_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'application/json', 'text/json', 'application/xml', 'text/xml', 'text/html',
  'text/yaml', 'application/x-yaml', 'text/x-yaml',
]);
const PDF_MIME_TYPES = new Set(['application/pdf']);
const DOCX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export function isDocumentMime(mime: string): boolean {
  return PLAINTEXT_MIME_TYPES.has(mime) || PDF_MIME_TYPES.has(mime) || DOCX_MIME_TYPES.has(mime);
}

/** Extension → MIME for clients that upload with a generic/blank type (common
 *  for .md/.csv where the browser reports application/octet-stream). */
const EXT_TO_MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  yaml: 'text/yaml', yml: 'text/yaml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Resolve a usable document MIME from the reported type and the filename. When
 *  the browser sends a vague type, fall back to the extension. Returns undefined
 *  when neither maps to a supported document type. */
export function resolveDocumentMime(reportedMime: string, filename: string): string | undefined {
  if (isDocumentMime(reportedMime)) return reportedMime;
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  const byExt = EXT_TO_MIME[ext];
  if (byExt && isDocumentMime(byExt)) return byExt;
  return undefined;
}

function normalizeText(raw: string): { text: string; truncated: boolean } {
  // Collapse the runs of blank lines PDF/DOCX extraction tends to produce, and
  // trim — keeps the injected context tight without altering meaning.
  const cleaned = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length > MAX_EXTRACTED_CHARS) {
    return { text: cleaned.slice(0, MAX_EXTRACTED_CHARS), truncated: true };
  }
  return { text: cleaned, truncated: false };
}

/**
 * Extract plain text from an uploaded document. Routes by MIME to the PDF/DOCX
 * extractor or reads the bytes as UTF-8 for the plain-text family. Throws with a
 * user-facing message on an unsupported type or a corrupt/unreadable file.
 */
export async function parseDocument(input: {
  bytes: Buffer;
  mime: string;
  filename: string;
}): Promise<{ text: string; truncated: boolean }> {
  const { bytes, mime } = input;

  if (PDF_MIME_TYPES.has(mime)) {
    // Import the internal lib directly: pdf-parse's index.js runs test-file
    // debug code when it thinks it's the entry module, which throws in a server.
    const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string }>;
    const parsed = await pdfParse(bytes);
    return normalizeText(parsed.text ?? '');
  }

  if (DOCX_MIME_TYPES.has(mime)) {
    const mammoth = require('mammoth') as { extractRawText(o: { buffer: Buffer }): Promise<{ value: string }> };
    const parsed = await mammoth.extractRawText({ buffer: bytes });
    return normalizeText(parsed.value ?? '');
  }

  if (PLAINTEXT_MIME_TYPES.has(mime)) {
    return normalizeText(bytes.toString('utf8'));
  }

  throw new Error('Unsupported document type');
}
