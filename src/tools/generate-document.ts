// ─────────────────────────────────────────────
//  Cascade AI — Office document generation tool
// ─────────────────────────────────────────────
//
//  Why this is a separate tool rather than a smarter `file_write`.
//
//  A `.docx`/`.pptx`/`.xlsx` is a ZIP of OOXML parts. `file_write` does exactly
//  what its description promises — `fs.writeFile(path, content)` — so asking a
//  model for `report.docx` on desktop/CLI produced a file containing literal
//  Markdown, and Word was right to call it corrupted. There was no conversion
//  step anywhere outside the browser exporter.
//
//  The fix is NOT to make `file_write` reinterpret certain extensions: a tool
//  the model understands as "write these exact bytes" must keep meaning that,
//  or `file_write('notes.docx', <already-valid-docx-bytes>)` silently corrupts.
//  Instead this tool owns the conversion, mirroring generate-media.ts: the model
//  supplies the SOURCE (Markdown / Markdown slides / CSV), the tool renders the
//  real binary via core/documents (the same renderers the cloud web app uses)
//  and writes it to the workspace.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { resolveInWorkspace } from './utils/workspace-path.js';
import {
  fileExt,
  isDocumentFormat,
  renderDocument,
  type DocumentFormat,
} from '../core/documents/index.js';

/** Reads a workspace file; supplied by the host so tests need no real disk. */
export type WorkspaceFileReader = (absPath: string) => Promise<Uint8Array>;

const SOURCE_HINT: Record<DocumentFormat, string> = {
  docx: 'Markdown',
  pptx: 'Markdown slides (separate slides with a --- rule; each slide starts with a heading)',
  xlsx: 'CSV (one header row, then data rows)',
};

export class GenerateDocumentTool extends BaseTool {
  readonly name = 'generate_document';
  readonly description =
    'Create a REAL Microsoft Office file (.docx Word, .pptx PowerPoint, .xlsx Excel) in the workspace. '
    + 'You write the SOURCE and this tool renders the actual binary: Markdown for .docx, Markdown slides '
    + '(separated by --- rules) for .pptx, CSV for .xlsx. ALWAYS use this instead of file_write for those '
    + 'three extensions — file_write stores your text verbatim, which Office reports as a corrupted file. '
    + 'Supports embedded images (reference a generated image as ![alt](path-the-image-tool-returned) on its '
    + 'own line) and real, data-accurate charts (a ```chart:bar / chart:line / chart:pie fenced block whose '
    + 'body is CSV). Use pdf_create for PDFs.';

  readonly inputSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Where to write the file, relative to the workspace root. The extension decides the format: .docx, .pptx or .xlsx.',
      },
      content: {
        type: 'string',
        description:
          'The document source. Markdown for .docx; Markdown slides separated by --- rules for .pptx (each slide starts with a heading); '
          + 'CSV for .xlsx. A standalone ![alt](path) line embeds that image. A fenced ```chart:bar (or chart:line, chart:pie, chart:area, '
          + 'chart:doughnut, chart:scatter) block whose body is CSV — an optional "title: …" line, then a header row of '
          + '"<category>,<series1>,<series2>", then data rows — becomes a real chart.',
      },
      format: {
        type: 'string',
        description: 'Optional override: "docx", "pptx" or "xlsx". Normally inferred from the path extension.',
      },
    },
    required: ['path', 'content'],
  };

  /**
   * `readFile` is injected so the image loader is testable and so a host with a
   * different workspace (not plain disk) can supply its own reader.
   */
  constructor(private readFile: WorkspaceFileReader = async (p) => new Uint8Array(await fs.readFile(p))) {
    super();
  }

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const filePath = String(input['path'] ?? '').trim();
    if (!filePath) return 'Provide a "path" for the document, e.g. "report.docx".';
    const content = typeof input['content'] === 'string' ? input['content'] : '';
    if (!content.trim()) return 'Provide "content" — the Markdown (docx/pptx) or CSV (xlsx) source for the document.';

    const requested = String(input['format'] ?? '').trim().toLowerCase().replace(/^\./, '');
    const ext = requested || fileExt(filePath);
    if (!isDocumentFormat(ext)) {
      return `generate_document renders .docx, .pptx and .xlsx. "${filePath}" is not one of those — use pdf_create for a PDF, or file_write for a text file.`;
    }

    const absPath = resolveInWorkspace(this.workspaceRoot, filePath);

    // A generated picture reaches us as `![alt](location)` where `location` is
    // whatever generate_image's sink reported — on desktop/CLI a workspace path,
    // so the bytes are already on disk. Remote URLs are deliberately NOT fetched
    // here; they are reported back instead, so the model learns the reference
    // was dropped rather than silently shipping a picture-less deck.
    const embedded: string[] = [];
    const skipped: string[] = [];
    const loadImageBytes = async (url: string): Promise<Uint8Array | null> => {
      if (/^(https?|ftp):\/\//i.test(url)) { skipped.push(`${url} (remote URL — download it into the workspace first)`); return null; }
      const local = url.replace(/^file:\/\//i, '').split('?')[0]!.split('#')[0]!;
      try {
        const bytes = await this.readFile(resolveInWorkspace(this.workspaceRoot, decodeURIComponent(local)));
        embedded.push(local);
        return bytes;
      } catch {
        skipped.push(`${local} (not found in the workspace)`);
        return null;
      }
    };

    if (options.saveSnapshot) {
      try {
        const old = await fs.readFile(absPath, 'utf-8');
        await options.saveSnapshot(absPath, old);
      } catch {
        // Doesn't exist yet — nothing to snapshot (rollback deletes it).
      }
    }

    const bytes = await renderDocument(ext, content, { name: filePath, loadImageBytes });
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, bytes);

    const charts = countCharts(content);
    return [
      `Wrote a real ${LABEL[ext]} file to ${filePath} (${bytes.length} bytes) from ${SOURCE_HINT[ext]}.`,
      embedded.length ? `Embedded ${embedded.length} image(s): ${embedded.join(', ')}.` : '',
      // Named, not counted: a dropped image is the failure the user actually
      // notices, and the model can only fix it if it is told which reference died.
      skipped.length ? `Could NOT embed ${skipped.length} image reference(s): ${skipped.join('; ')}.` : '',
      charts && ext === 'pptx' ? `Rendered ${charts} chart block(s) as real, editable PowerPoint charts.` : '',
      charts && ext === 'docx' ? `Rendered ${charts} chart block(s) as data tables — Word documents cannot hold a native chart object.` : '',
      charts && ext === 'xlsx' ? `Wrote ${charts} chart block(s) onto their own worksheets as real rows the user can chart in Excel.` : '',
    ].filter(Boolean).join('\n');
  }
}

const LABEL: Record<DocumentFormat, string> = { docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel' };

/** Count `chart:` fences, for the result message only. */
function countCharts(source: string): number {
  return (source.match(/^\s*```+\s*chart\s*:/gim) ?? []).length;
}

/**
 * Register the document tool only where there is a workspace to write into.
 *
 * Mirrors how buildMediaTools() conditions `transcribe_audio` on a file reader:
 * a hosted run has no disk, and a tool that always fails is worse than an
 * absent one — the planner writes steps around it and the run ends in an
 * apology. The cloud keeps its browser-side exporter instead.
 */
export function buildDocumentTools(readFile?: WorkspaceFileReader): BaseTool[] {
  return readFile ? [new GenerateDocumentTool(readFile)] : [];
}
