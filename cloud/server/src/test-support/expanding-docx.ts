import JSZip from 'jszip';

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Override PartName="/word/document.xml"'
  + ' ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '</Types>';

const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1"'
  + ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"'
  + ' Target="word/document.xml"/></Relationships>';

/**
 * A valid, minimal DOCX whose text content is enormously larger than the file.
 *
 * This is the shape of upload that per-plan BYTE limits do not catch: DOCX is a
 * ZIP of XML, so a few tens of kilobytes of highly repetitive runs decompress
 * into tens of millions of characters. At the defaults below it is roughly
 * 43 KB on the wire — under every plan ceiling, free included — and extracts to
 * about 30 million characters, a ~680x expansion.
 *
 * It is BUILT rather than committed as a fixture on purpose. A file whose only
 * property is that it explodes on open is an awkward thing to have sitting in a
 * repository: secret and malware scanners flag it, and anyone who finds it has
 * to work out whether it is a test asset or an accident. Generated here, its
 * intent is in the code that makes it.
 */
export async function expandingDocx(
  opts: { runChars?: number; runs?: number; level?: 1 | 9 } = {},
): Promise<Buffer> {
  const runChars = opts.runChars ?? 5_000;
  const runs = opts.runs ?? 6_000;
  // Level 1 still compresses a repeated run by three orders of magnitude and
  // is several times quicker, which matters for the 130 MB variant.
  const level = opts.level ?? 9;
  const paragraph = `<w:p><w:r><w:t>${'A'.repeat(runChars)}</w:t></w:r></w:p>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + paragraph.repeat(runs)
    + '</w:body></w:document>',
  );
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level },
  });
}

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * The same shape, sized so the archive DECLARES more than
 * `MAX_DECOMPRESSED_BYTES` in its central directory — about 130 MB, from a
 * ~650 KB file. This is the variant the preflight must refuse without ever
 * handing the buffer to mammoth.
 */
export function preflightTrippingDocx(): Promise<Buffer> {
  return expandingDocx({ runChars: 5_000, runs: 27_000, level: 1 });
}
