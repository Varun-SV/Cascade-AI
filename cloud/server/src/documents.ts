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

/**
 * Ceiling on EXTRACTED text, enforced as a REFUSAL and never as a trim.
 *
 * `MAX_DOCUMENT_BYTES` bounds the bytes that arrive. It does not bound what
 * they become: PDF and DOCX are compressed containers, so a small upload can
 * decompress into a much larger body of text, and with the 200,000-character
 * cut gone there is nothing downstream that shrinks it before it is persisted
 * to SQLite and read back into a run. A 10 MB DOCX of one repeated paragraph
 * is a few megabytes on the wire and hundreds of megabytes of text.
 *
 * So this is a resource guard, not a context decision — which is the whole
 * distinction the removed cut got wrong. It REJECTS rather than truncates: a
 * document we cannot take is refused with a reason the user can act on, and a
 * document we accept is stored whole. Silently keeping a prefix is exactly the
 * behaviour this release removed, and re-introducing it here under a different
 * name would be worse, not better, for being further from the upload.
 *
 * 25M characters is chosen to be unreachable by legitimate input and far below
 * a pathological one. UTF-8 never yields more characters than bytes, so the
 * largest plain-text upload this server accepts is 10M characters — this sits
 * 2.5x above that, and well above the ~1-3M characters of real text a 10 MB
 * PDF or DOCX carries, while refusing the order-of-magnitude expansions that
 * only a crafted file produces.
 *
 * What it does NOT bound: peak memory *inside* the extractor. `pdf-parse` and
 * `mammoth.extractRawText` both materialize the whole string before returning
 * it, and neither offers a streaming or bounded API, so the check can only run
 * on what they hand back. This bounds what is persisted and what a run can
 * load, which is the part that outlives the request.
 */
export const EXPANSION_CEILING_CHARS = 25_000_000;

/**
 * An upload whose extracted text exceeds {@link EXPANSION_CEILING_CHARS}.
 *
 * Distinct from a parse failure on purpose: the upload route catches anything
 * `parseDocument` throws and reports it as "scanned, encrypted, or corrupt",
 * which would be a wrong and unactionable answer for a file that read
 * perfectly well and was simply too big once opened.
 */
export class DocumentTooLargeError extends Error {
  constructor(readonly chars: number) {
    super(
      `That document contains ${Math.round(chars / 1_000_000)}M characters of text once extracted, `
      + `over the ${EXPANSION_CEILING_CHARS / 1_000_000}M limit. Split it into smaller files.`,
    );
    this.name = 'DocumentTooLargeError';
  }
}

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
  const text = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Measured AFTER collapsing, so the blank-line padding extraction invents
  // cannot push an otherwise fine document over the line.
  if (text.length > EXPANSION_CEILING_CHARS) throw new DocumentTooLargeError(text.length);
  return text;
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
