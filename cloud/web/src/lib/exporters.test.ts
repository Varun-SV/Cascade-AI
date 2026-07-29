import { describe, it, expect, vi, afterEach } from 'vitest';
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
    expect(isExportableExt('docx')).toBe(true);
    expect(isExportableExt('pptx')).toBe(true);
    expect(isExportableExt('txt')).toBe(false);
    expect(isExportableExt('md')).toBe(false);
    expect(isExportableExt('csv')).toBe(false);
  });

  it('labels the formats and hints the source they render from', () => {
    expect(exportLabel('xlsx')).toBe('Excel');
    expect(exportLabel('pdf')).toBe('PDF');
    expect(exportLabel('docx')).toBe('Word');
    expect(exportLabel('pptx')).toBe('PowerPoint');
    expect(sourceHint('xlsx')).toBe('from CSV');
    expect(sourceHint('pdf')).toBe('from Markdown');
    expect(sourceHint('pptx')).toBe('from Markdown slides');
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

  it('renders Markdown source into a real .docx blob', async () => {
    const md = '# Title\n\nHello **world**.\n\n1. first\n2. second\n\n> a quote\n';
    const blob = await renderExport('docx', md, 'doc.docx');
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(blob.size).toBeGreaterThan(0);
    // A .docx is a ZIP archive — "PK" signature.
    const head = (await readBytes(blob)).subarray(0, 2);
    expect(String.fromCharCode(head[0]!, head[1]!)).toBe('PK');
  });

  it('renders a Markdown deck into a real .pptx blob', async () => {
    const md = '# Slide one\n\n- point A\n- point B\n\n---\n\n# Slide two\n\n- another\n';
    const blob = await renderExport('pptx', md, 'deck.pptx');
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(blob.size).toBeGreaterThan(0);
    // A .pptx is a ZIP archive — "PK" signature.
    const head = (await readBytes(blob)).subarray(0, 2);
    expect(String.fromCharCode(head[0]!, head[1]!)).toBe('PK');
  });

  it('falls back to a plain-text blob for a non-exportable extension', async () => {
    const blob = await renderExport('txt', 'just text', 'notes.txt');
    expect(blob.type).toContain('text/plain');
    expect(await readText(blob)).toBe('just text');
  });
});

// A generated image reaches the exporter as `![alt](/api/files/:id)` — the only
// thing a text-streaming run can emit. These assert the bytes actually make it
// into the binary, because the failure mode is silent: the deck still opens, it
// just has the caption where the picture should be.
describe('exporters — embedded images', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // Smallest valid PNG (1×1), so sniffImage has a real header to read.
  const PNG_1X1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pngBytes = () => Uint8Array.from(atob(PNG_1X1), (c) => c.charCodeAt(0));

  const stubFetch = (impl: () => Promise<unknown>) => {
    const f = vi.fn(impl);
    vi.stubGlobal('fetch', f);
    return f;
  };
  const servesPng = () => stubFetch(async () => ({ ok: true, arrayBuffer: async () => pngBytes().buffer }));

  // Zip entry names are stored uncompressed in the archive, so the media parts
  // are greppable in the raw bytes without unzipping.
  const entryNames = async (blob: Blob): Promise<string> =>
    new TextDecoder('latin1').decode(await readBytes(blob));

  it('embeds a generated image into the .pptx instead of flattening it to bullet text', async () => {
    const f = servesPng();
    const md = '# Slide one\n\n- point A\n\n![a friendly cat](/api/files/abc-123)\n';
    const blob = await renderExport('pptx', md, 'deck.pptx');

    // Recognised as a picture rather than prose — it was fetched at all — and
    // fetched the way /api/files/:id expects: same-origin with the session cookie.
    expect(f).toHaveBeenCalledWith('/api/files/abc-123', { credentials: 'include' });
    // …and the bytes landed in the deck as a real media part.
    expect(await entryNames(blob)).toContain('ppt/media/image');
  }, 30_000);

  it('accepts the image as a list item, the way models usually write it', async () => {
    const f = servesPng();
    const blob = await renderExport('pptx', '# Slide\n\n- ![a cat](/api/files/xyz)\n', 'deck.pptx');
    expect(f).toHaveBeenCalledWith('/api/files/xyz', { credentials: 'include' });
    expect(await entryNames(blob)).toContain('ppt/media/image');
  }, 30_000);

  it('leaves an image reference embedded in a sentence as text', async () => {
    const f = servesPng();
    const blob = await renderExport('pptx', '# Slide\n\n- see ![a cat](/api/files/abc) here\n', 'deck.pptx');
    // Only a standalone reference becomes a picture; mid-sentence it is prose.
    expect(f).not.toHaveBeenCalled();
    expect(await entryNames(blob)).not.toContain('ppt/media/image');
  }, 30_000);

  it('still exports the deck when an image cannot be fetched', async () => {
    stubFetch(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }));
    const blob = await renderExport('pptx', '# Slide\n\n- point A\n\n![gone](/api/files/missing)\n', 'deck.pptx');

    // One dead image must not cost the user the whole deck.
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const head = (await readBytes(blob)).subarray(0, 2);
    expect(String.fromCharCode(head[0]!, head[1]!)).toBe('PK');
    expect(await entryNames(blob)).not.toContain('ppt/media/image');
  }, 30_000);

  it('survives a network error rather than rejecting the export', async () => {
    stubFetch(async () => { throw new Error('offline'); });
    const blob = await renderExport('pptx', '# Slide\n\n![x](/api/files/x)\n', 'deck.pptx');
    expect(blob.size).toBeGreaterThan(0);
  }, 30_000);

  it('embeds a generated image into the .docx too', async () => {
    const f = servesPng();
    const md = '# Report\n\nIntro paragraph.\n\n![a chart](/api/files/chart-1)\n';
    const blob = await renderExport('docx', md, 'doc.docx');

    expect(f).toHaveBeenCalledWith('/api/files/chart-1', { credentials: 'include' });
    expect(await entryNames(blob)).toContain('word/media/');
  }, 30_000);

  it('falls back to text in the .docx when the image cannot be fetched', async () => {
    stubFetch(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }));
    const blob = await renderExport('docx', '# Report\n\n![gone](/api/files/missing)\n', 'doc.docx');
    const head = (await readBytes(blob)).subarray(0, 2);
    expect(String.fromCharCode(head[0]!, head[1]!)).toBe('PK');
    expect(await entryNames(blob)).not.toContain('word/media/');
  }, 30_000);
});
