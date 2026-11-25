import type { Block } from './types.js';

/** A heading's anchor: lowercase words joined by hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Short constructors, so a page reads as a list of what it says.
export const p = (text: string): Block => ({ t: 'p', text });
export const h2 = (text: string): Block => ({ t: 'h2', text, id: slugify(text) });
export const h3 = (text: string): Block => ({ t: 'h3', text, id: slugify(text) });
export const ul = (...items: string[]): Block => ({ t: 'ul', items });
export const ol = (...items: string[]): Block => ({ t: 'ol', items });
export const code = (source: string, lang = 'bash', title?: string): Block => ({
  t: 'code', code: source.replace(/^\n/, '').replace(/\s+$/, ''), lang, ...(title ? { title } : {}),
});
export const note = (text: string, title?: string): Block => ({ t: 'callout', kind: 'note', text, ...(title ? { title } : {}) });
export const warn = (text: string, title?: string): Block => ({ t: 'callout', kind: 'warn', text, ...(title ? { title } : {}) });
export const tip = (text: string, title?: string): Block => ({ t: 'callout', kind: 'tip', text, ...(title ? { title } : {}) });
export const table = (head: string[], ...rows: string[][]): Block => ({ t: 'table', head, rows });
