// How a generated/saved file should be previewed. Pure helpers so they're unit
// testable and shared between the in-message card viewer and the Files panel.
//
// `fileExt` and `parseDelimited` are re-exported from the SDK's shared document
// module rather than defined twice: the Office renderers need the exact same
// CSV semantics this viewer uses, and "the spreadsheet previewed one way and
// exported another" is precisely the drift the shared module exists to prevent.

export { fileExt, parseDelimited } from '@cascade/documents';
import { fileExt } from '@cascade/documents';

export type FileKind = 'markdown' | 'code' | 'csv' | 'html' | 'svg' | 'image' | 'pdf' | 'text';

const EXT_KIND: Record<string, FileKind> = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  csv: 'csv', tsv: 'csv',
  html: 'html', htm: 'html',
  svg: 'svg',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', ico: 'image',
  pdf: 'pdf',
  txt: 'text', log: 'text',
};

// Everything else with a known code-ish extension renders as highlighted code.
const CODE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cc', 'cs',
  'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'json', 'yaml', 'yml', 'toml', 'ini', 'xml',
  'css', 'scss', 'less', 'dockerfile', 'makefile', 'r', 'lua', 'pl', 'dart', 'vue', 'svelte',
]);

/**
 * Decide how to preview a file from its name (and optional MIME). Unknown types
 * fall back to plain text — never to a broken affordance.
 */
export function fileKind(name: string, mime?: string): FileKind {
  const ext = fileExt(name);
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  if (CODE_EXTS.has(ext)) return 'code';
  if (mime) {
    if (mime.startsWith('image/')) return mime.includes('svg') ? 'svg' : 'image';
    if (mime === 'text/markdown') return 'markdown';
    if (mime === 'text/html') return 'html';
    if (mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('text/')) return 'text';
    if (mime === 'application/json') return 'code';
  }
  return 'text';
}

/** The highlight.js language hint for a code file (from its extension). */
export function codeLanguage(name: string): string {
  const ext = fileExt(name);
  const alias: Record<string, string> = { yml: 'yaml', sh: 'bash', zsh: 'bash', h: 'c', cc: 'cpp', py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx' };
  return alias[ext] ?? ext ?? '';
}
