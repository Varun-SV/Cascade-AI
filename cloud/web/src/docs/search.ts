// Client-side search over the docs: titles, headings and text, with no server and
// no index file. The whole of the content is already in the bundle, so the index
// is built from it the first time someone searches, and kept.

import { PAGES, sectionById } from './content/index.js';
import type { DocPage } from './content/types.js';
import { plainText } from './inline.js';

export interface SearchHit {
  slug: string;
  pageTitle: string;
  section: string;
  /** The heading the match is under, when it is under one. */
  heading: string | null;
  anchor: string | null;
  /** A short stretch of text around the first match. */
  snippet: string;
  score: number;
}

interface Entry {
  slug: string;
  pageTitle: string;
  summary: string;
  section: string;
  heading: string | null;
  anchor: string | null;
  text: string;
  /** Lower-cased, for matching. */
  hay: { title: string; heading: string; summary: string; text: string };
}

let index: Entry[] | null = null;

function blockText(b: DocPage['blocks'][number]): string {
  switch (b.t) {
    case 'p': return plainText(b.text);
    case 'h2': case 'h3': return plainText(b.text);
    case 'ul': case 'ol': return b.items.map(plainText).join(' ');
    case 'code': return b.code;
    case 'callout': return plainText(`${b.title ?? ''} ${b.text}`);
    case 'table': return [...b.head, ...b.rows.flat()].map(plainText).join(' ');
  }
}

/** One entry per page's lead, and one for each heading's stretch of text. */
export function buildIndex(pages: DocPage[] = PAGES): Entry[] {
  const out: Entry[] = [];
  const make = (page: DocPage, heading: string | null, anchor: string | null, text: string): Entry => ({
    slug: page.slug,
    pageTitle: page.title,
    summary: page.summary,
    section: sectionById(page.section)?.title ?? '',
    heading,
    anchor,
    text,
    hay: { title: page.title.toLowerCase(), heading: (heading ?? '').toLowerCase(), summary: page.summary.toLowerCase(), text: text.toLowerCase() },
  });
  for (const page of pages) {
    let heading: string | null = null;
    let anchor: string | null = null;
    let buf: string[] = [];
    const flush = () => {
      if (buf.length || heading) out.push(make(page, heading, anchor, buf.join(' ')));
      buf = [];
    };
    for (const b of page.blocks) {
      if (b.t === 'h2' || b.t === 'h3') {
        flush();
        heading = plainText(b.text);
        anchor = b.id;
      } else {
        buf.push(blockText(b));
      }
    }
    flush();
  }
  return out;
}

function snippetAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, 140).trim();
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + 110);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_./+-]+/).filter((t) => t.length > 0);
}

/**
 * Pages and sections that match every word of the query, best first. A word in
 * a page's title counts most, then in a heading, then in its summary, then in
 * the text. At most one hit per section of a page, and three per page.
 */
export function search(query: string, limit = 8): SearchHit[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  index ??= buildIndex();
  const hits: SearchHit[] = [];
  for (const e of index) {
    let score = 0;
    let ok = true;
    for (const t of terms) {
      let s = 0;
      if (e.hay.title.includes(t)) s += 10;
      if (e.hay.heading.includes(t)) s += 7;
      if (e.hay.summary.includes(t)) s += 3;
      if (e.hay.text.includes(t)) s += 2 + Math.min(3, e.hay.text.split(t).length - 2) * 0.5;
      if (s === 0) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    // A section's own heading counts a little more than the page's lead.
    if (e.heading) score += 0.5;
    // A whole phrase in order beats the same words scattered.
    if (terms.length > 1 && e.hay.text.includes(terms.join(' '))) score += 4;
    hits.push({
      slug: e.slug,
      pageTitle: e.pageTitle,
      section: e.section,
      heading: e.heading,
      anchor: e.anchor,
      snippet: snippetAround(e.text || e.summary, terms),
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.pageTitle.localeCompare(b.pageTitle));
  const perPage = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const n = perPage.get(h.slug) ?? 0;
    if (n >= 3) continue;
    perPage.set(h.slug, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
