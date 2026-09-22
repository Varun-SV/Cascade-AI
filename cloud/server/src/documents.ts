import { createRequire } from 'module';
import zlib from 'node:zlib';

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
 * Ceiling on a DOCX's DECLARED uncompressed size, checked before the extractor
 * is allowed near it.
 *
 * {@link EXPANSION_CEILING_CHARS} bounds what is stored, which is the right
 * bound for storage and the wrong one for memory: `mammoth.extractRawText`
 * materializes the whole expanded document before it returns, so a check on
 * its output runs after the allocation it is meant to prevent. At the ~680x
 * expansion a crafted DOCX reaches, a file that still fits inside the 5 MB
 * free-plan ceiling can ask for multiple gigabytes, and the process dies
 * before any of our code gets a turn. Authenticated free users can reach the
 * upload route, which makes that a tenant denial of service rather than a
 * theoretical one.
 *
 * A ZIP says how large each member expands to, in its central directory,
 * before any of it is decompressed. That is a claim rather than a proof — a
 * lying header inflates to whatever it likes — but it is a claim the
 * decompressor will hold itself to, so refusing on it costs the attacker the
 * cheap version of the attack and costs an honest document nothing.
 *
 * 128 MB is ~12x the largest upload any plan accepts, so no real document
 * reaches it, and it bounds the allocation to something a hosted process
 * survives. The post-extraction ceiling stays as the second line: this bounds
 * MEMORY, that bounds STORAGE, and a file can fail either.
 */
export const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
/** A size of 0xFFFFFFFF means "see the Zip64 extra field" — i.e. >= 4 GB. */
const ZIP64_SENTINEL = 0xffffffff;

/**
 * Total uncompressed size a ZIP declares for its members, read from the
 * central directory without decompressing anything.
 *
 * Returns `null` when the archive cannot be parsed — a damaged or unusual
 * container is not evidence of an attack, and `parseDocument` will still fail
 * honestly on it further down. Returns `Infinity` for a Zip64 sentinel, which
 * is a member claiming at least 4 GB.
 */
export function declaredUncompressedBytes(bytes: Buffer): number | null {
  const dir = readCentralDirectory(bytes);
  if (dir === null) return null;
  let total = 0;
  for (const e of dir) {
    if (e.uncompressed === ZIP64_SENTINEL) return Infinity;
    total += e.uncompressed;
  }
  return total;
}

interface ZipEntry {
  compressed: number;
  uncompressed: number;
  method: number;
  localOffset: number;
}

/**
 * Every record in the central directory, or `null` if it cannot be read whole.
 *
 * Two things here are deliberately NOT taken from the archive at face value.
 *
 * The directory is located as `eocd - size`, not from the stored offset. A ZIP
 * may carry arbitrary bytes BEFORE its payload — self-extracting archives are
 * the usual reason — and every reader worth the name, JSZip included,
 * compensates by measuring the shift. Trusting the stored offset meant a
 * single prepended byte made this return `null`, and `null` used to mean
 * "carry on to mammoth". One byte disabled the guard.
 *
 * And the loop is bounded by the directory's EXTENT, not by the EOCD's entry
 * count. That count is a uint16 an attacker writes, it is not checksummed, and
 * tolerant readers walk the signatures instead — so understating it left this
 * summing the first small record and reporting a safe total while JSZip went
 * on to find the rest. Walking the extent and then checking the count against
 * what was actually there turns a lie into a refusal instead of a bypass.
 */
function readCentralDirectory(bytes: Buffer): ZipEntry[] | null {
  const minEocd = 22;
  if (bytes.length < minEocd) return null;
  // The EOCD sits at the end behind a comment of up to 65535 bytes, so it is
  // found by scanning backwards. Scanning from the END means a crafted comment
  // containing a second EOCD signature loses to the real trailing one.
  const scanFrom = Math.max(0, bytes.length - (minEocd + 0xffff));
  let eocd = -1;
  for (let i = bytes.length - minEocd; i >= scanFrom; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const declaredCount = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const storedOffset = bytes.readUInt32LE(eocd + 16);
  if (cdSize === ZIP64_SENTINEL || storedOffset === ZIP64_SENTINEL) {
    return [{ compressed: 0, uncompressed: ZIP64_SENTINEL, method: 0, localOffset: 0 }];
  }
  const start = eocd - cdSize;
  if (start < 0 || cdSize === 0) return null;
  // Whatever prefix shifted the archive shifts every stored offset by the same
  // amount; measuring it once lets local-header offsets be corrected too.
  const shift = start - storedOffset;

  const entries: ZipEntry[] = [];
  let offset = start;
  while (offset + 46 <= eocd) {
    if (bytes.readUInt32LE(offset) !== CENTRAL_FILE_SIGNATURE) return null;
    const nameLen = bytes.readUInt16LE(offset + 28);
    const extraLen = bytes.readUInt16LE(offset + 30);
    const commentLen = bytes.readUInt16LE(offset + 32);
    entries.push({
      method: bytes.readUInt16LE(offset + 10),
      compressed: bytes.readUInt32LE(offset + 20),
      uncompressed: bytes.readUInt32LE(offset + 24),
      localOffset: bytes.readUInt32LE(offset + 42) + shift,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  // The walk must land exactly on the directory's end, and must have found as
  // many records as the EOCD claims. Either mismatch means the container does
  // not describe itself consistently, and an inconsistent container is one we
  // refuse rather than interpret.
  if (offset !== eocd) return null;
  if (entries.length !== declaredCount) return null;
  return entries;
}

/**
 * Inflate every member under a hard output cap, and refuse the archive if it
 * cannot be done.
 *
 * The declared sizes above are a claim, and the claim is free to lie: an
 * attacker patches the central directory to say "small" and leaves the DEFLATE
 * stream expanding to gigabytes. JSZip compares the observed length against
 * the declared one only AFTER its decompression worker has produced the data,
 * so the allocation this guard exists to prevent has already happened by the
 * time the mismatch is noticed. A check that reads only the header is a check
 * an attacker writes the answer to.
 *
 * So this decompresses the members itself, with `maxOutputLength` — enforced
 * by zlib DURING inflation, not after — as the bound. A bomb aborts partway
 * through with the cap's worth of memory allocated and no more. It costs an
 * honest document one extra decompression of a few megabytes, which is the
 * price of the guarantee being real rather than declared.
 */
function assertInflatesWithin(bytes: Buffer, cap: number): void {
  const entries = readCentralDirectory(bytes);
  // Fail CLOSED. An unreadable container is not proof of an attack, but it is
  // proof we cannot bound it, and "we could not check" must never mean "go
  // ahead". The route reports this as an unreadable document, which is what it
  // is from here.
  if (entries === null) throw new Error('Unreadable document container');

  let remaining = cap;
  for (const e of entries) {
    if (e.uncompressed === ZIP64_SENTINEL) throw new DocumentTooLargeError(Infinity, 'declared');
    if (e.localOffset < 0 || e.localOffset + 30 > bytes.length) {
      throw new Error('Unreadable document container');
    }
    if (bytes.readUInt32LE(e.localOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error('Unreadable document container');
    }
    // The local header's own name/extra lengths, not the central directory's —
    // they are allowed to differ, and the data starts after the local ones.
    const nameLen = bytes.readUInt16LE(e.localOffset + 26);
    const extraLen = bytes.readUInt16LE(e.localOffset + 28);
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + e.compressed;
    if (dataEnd > bytes.length) throw new Error('Unreadable document container');
    const payload = bytes.subarray(dataStart, dataEnd);

    let produced: number;
    if (e.method === 0) {
      produced = payload.length; // stored, no expansion possible
    } else if (e.method === 8) {
      try {
        produced = zlib.inflateRawSync(payload, { maxOutputLength: remaining }).length;
      } catch (err) {
        // zlib raises ERR_BUFFER_TOO_LARGE once output passes the cap. That is
        // the bomb, caught mid-inflation with only `remaining` bytes spent.
        if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new DocumentTooLargeError(cap, 'declared');
        }
        throw new Error('Unreadable document container');
      }
    } else {
      // A method we cannot bound is a method we do not accept.
      throw new Error('Unreadable document container');
    }

    remaining -= produced;
    if (remaining < 0) throw new DocumentTooLargeError(cap, 'declared');
  }
}

/**
 * An upload whose extracted text exceeds {@link EXPANSION_CEILING_CHARS}.
 *
 * Distinct from a parse failure on purpose: the upload route catches anything
 * `parseDocument` throws and reports it as "scanned, encrypted, or corrupt",
 * which would be a wrong and unactionable answer for a file that read
 * perfectly well and was simply too big once opened.
 */
export class DocumentTooLargeError extends Error {
  constructor(readonly amount: number, readonly kind: 'extracted' | 'declared' = 'extracted') {
    super(
      kind === 'declared'
        // Refused before opening it, so the honest word is "expands to", not
        // "contains" — we have the archive's claim, not its contents.
        ? `That document expands to ${DocumentTooLargeError.mb(amount)} once decompressed, `
          + `over the ${MAX_DECOMPRESSED_BYTES / (1024 * 1024)} MB limit. Split it into smaller files.`
        : `That document contains ${Math.round(amount / 1_000_000)}M characters of text once extracted, `
          + `over the ${EXPANSION_CEILING_CHARS / 1_000_000}M limit. Split it into smaller files.`,
    );
    this.name = 'DocumentTooLargeError';
  }

  private static mb(bytes: number): string {
    return Number.isFinite(bytes) ? `${Math.round(bytes / (1024 * 1024))} MB` : 'more than 4 GB';
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
    // BEFORE mammoth, not after: the extractor allocates the whole expansion
    // and only then returns it, so a check on its output cannot prevent the
    // allocation. The archive states what it expands to; refuse on the claim.
    // Bounded for real, by inflating under a cap rather than by reading the
    // size the archive claims for itself. Fails closed on a container it
    // cannot walk, so a prepended byte or a miscounted directory refuses the
    // upload instead of waving it through.
    assertInflatesWithin(bytes, MAX_DECOMPRESSED_BYTES);
    const mammoth = require('mammoth') as { extractRawText(o: { buffer: Buffer }): Promise<{ value: string }> };
    const parsed = await mammoth.extractRawText({ buffer: bytes });
    return normalizeText(parsed.value ?? '');
  }

  if (PLAINTEXT_MIME_TYPES.has(mime)) {
    return normalizeText(bytes.toString('utf8'));
  }

  throw new Error('Unsupported document type');
}
