// ─────────────────────────────────────────────
//  Cascade AI — Shared document generation
// ─────────────────────────────────────────────
//
//  One implementation of "text the model wrote → real Office binary", imported
//  by BOTH the browser exporter (cloud/web/src/lib/exporters.ts, via the
//  `@cascade/documents` alias) and the desktop/CLI `generate_document` tool.
//  See blocks.ts for why there is exactly one copy.

export {
  fileExt,
  parseDelimited,
  chartKind,
  parseChartSpec,
  chartToTableRows,
  parseBlocks,
  matchImageLine,
  sniffImage,
  bytesToBase64,
  stripInline,
  inlineRuns,
  splitSlides,
  parseSlide,
  extractCharts,
} from './blocks.js';

export type {
  Block,
  ChartKind,
  ChartSeries,
  ChartSpec,
  ImageInfo,
  ImageRef,
  InlineRun,
  LoadedImage,
  Slide,
} from './blocks.js';

export {
  DOCUMENT_MIME,
  isDocumentFormat,
  renderDocument,
  renderDocx,
  renderPptx,
  renderXlsx,
} from './render.js';

export type { DocumentFormat, ImageByteLoader, RenderOptions } from './render.js';
