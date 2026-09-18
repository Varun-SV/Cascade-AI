import { createRequire } from 'module';

// pdf-parse / mammoth are CommonJS with no first-class ESM types; load them
// through createRequire so the bundle resolves them at runtime without pulling
// their (heavy, optional) type surface into our build.
const require = createRequire(import.meta.url);

/**
 * Hard ceiling on a single uploaded document (raw bytes), across every plan.
 *
 * The limit that actually applies is the caller's plan ceiling
 * (`PlanLimits.documentBytes`); this is the outer bound the request body is
 * sized against, and it must stay at or below the largest plan's allowance.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

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

/**
 * Tidy extracted text. It does NOT shorten it.
 *
 * There used to be a 200,000-character cut here, and it was the wrong decision
 * in the wrong place. Extraction is an ingestion concern; how much of a
 * document fits a model is a *run* concern, and `resolveDocuments`
 * (cloud/server/src/runs.ts) already answers it properly — against the real
 * context window of the models the user has pinned, injecting what fits and
 * retrieving over what does not. Its own comment promises "no fixed byte
 * cliff", and this function was the fixed byte cliff standing in front of it.
 *
 * Worse, the cut was destructive: only the trimmed text was persisted, so the
 * rest of the document was gone before any of that machinery could see it —
 * while the original bytes sat on disk, unread. Nothing downstream could
 * recover what ingestion had already thrown away.
 *
 * The limit on a document is now its SIZE, enforced per plan at upload
 * (`PlanLimits.documentBytes`), which is a resource question with a resource
 * answer.
 */
function normalizeText(raw: string): string {
  // Collapse the runs of blank lines PDF/DOCX extraction tends to produce, and
  // trim — keeps the injected context tight without altering meaning.
  return raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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
}): Promise<string> {
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
