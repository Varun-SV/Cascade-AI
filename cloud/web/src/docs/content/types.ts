// The shape of a docs page. Content is plain data (no MDX, no markdown parser):
// the renderer, the table of contents and the search index all read the same
// blocks, so they cannot disagree about what a page says.
//
// Text inside a block takes three bits of inline markup: `code`, **bold** and
// [label](href). An href that starts with /docs stays inside the docs.

export type Block =
  | { t: 'p'; text: string }
  | { t: 'h2' | 'h3'; text: string; id: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'code'; code: string; lang?: string; title?: string }
  | { t: 'callout'; kind: 'note' | 'warn' | 'tip'; title?: string; text: string }
  | { t: 'table'; head: string[]; rows: string[][] };

export interface DocPage {
  slug: string;
  title: string;
  /** One sentence: shown under the title, on the home cards and in search. */
  summary: string;
  section: string;
  blocks: Block[];
}

export interface DocSection {
  id: string;
  title: string;
  blurb: string;
}
