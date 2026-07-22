// How a generated/saved file should be previewed. Pure helpers so they're unit
// testable and shared between the in-message card viewer and the Files panel.

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

/** File extension (lowercased, no dot), or '' when there is none. */
export function fileExt(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

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

/**
 * Parse CSV/TSV into rows of cells. Handles quoted fields, escaped quotes (""),
 * and embedded newlines/commas inside quotes. Delimiter is auto-detected from the
 * extension (tsv → tab) or inferred from the first line. Bounded for safety.
 */
export function parseDelimited(text: string, name = ''): string[][] {
  const delim = fileExt(name) === 'tsv' || (text.indexOf('\t') !== -1 && text.indexOf(',') === -1) ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (ch === '\r') {
      // swallow — handled by the \n
    } else {
      cell += ch;
    }
    if (rows.length > 5000) break; // guard against a pathological file
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}
