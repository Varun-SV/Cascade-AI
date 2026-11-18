// ─────────────────────────────────────────────
//  Cascade AI — Web Fetch Tool
// ─────────────────────────────────────────────
//
//  A page as a reader would see it: the main content with its headings, lists,
//  code and tables, without the menus, footers and banners around it, and the
//  links in it, so a run can go on to the next page without a browser. A long
//  page is read in parts (`offset`), and with `prompt` the passages that answer
//  it come first.
//
//  Fetched through the SSRF guard: the address is the model's, or the web's.

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import { type FetchedPage, type OpenWebState, type PageFetch, UnreadablePageError, fetchReadable } from './open-web/index.js';
import { bestPassages } from './open-web/passages.js';
import { SsrfBlockedError } from './utils/safe-fetch.js';

/**
 * What one answer may come to, whole. A worker keeps 12,000 characters of a
 * tool's result (`truncateForContext`) and drops the middle of anything
 * longer, so a part sized past that would skip text the next `offset` never
 * covers. Kept under it, with room for the note that ends a part.
 */
export const ANSWER_CHARS = 11_000;
/** A part is never smaller than this, however much else the answer holds. */
const MIN_PART_CHARS = 3_000;
const MAX_LINKS = 25;
/** A link's words are shortened to this; its address never is. */
const LINK_TEXT_CHARS = 80;
/** An address longer than this is left out, and said to be, rather than cut into a wrong one. */
const LINK_URL_CHARS = 300;

export class WebFetchTool extends BaseTool {
  readonly name = 'web_fetch';
  readonly description =
    'Fetch a URL and read it: the main content as text (headings, lists, code, tables), without menus and page furniture, '
    + 'plus the links on it. Long pages come in parts of about 10,000 characters: pass offset to read on. '
    + 'Give prompt to get the passages that answer it first.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      prompt: { type: 'string', description: 'Optional: what you are looking for. The passages that answer it are put first.' },
      offset: { type: 'number', description: 'Optional: character to start from, to read on in a long page (from the previous part\'s note)' },
    },
    required: ['url'],
  };

  constructor(private readonly deps: { fetchPage?: PageFetch; state?: OpenWebState } = {}) {
    super();
  }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const url = typeof input['url'] === 'string' ? input['url'].trim() : '';
    if (!url) return 'Error: url is required.';
    const prompt = typeof input['prompt'] === 'string' ? input['prompt'].trim() : '';
    const rawOffset = Number(input['offset'] ?? 0);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

    let page: FetchedPage;
    try {
      page = await fetchReadable(url, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(this.deps.fetchPage ? { fetchPage: this.deps.fetchPage } : {}),
        ...(this.deps.state ? { state: this.deps.state } : {}),
      });
    } catch (err) {
      // safeFetch validates the scheme, blocks loopback/link-local/private
      // hosts (SSRF — e.g. the cloud metadata endpoint), and re-checks every
      // redirect hop. Set CASCADE_ALLOW_LOCAL_FETCH=1 to fetch local URLs.
      if (err instanceof SsrfBlockedError) return `Refused to fetch ${url}: ${err.message}`;
      if (err instanceof UnreadablePageError) return `Can't read ${url} as text: ${err.message}.`;
      return `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }

    const lines: string[] = [`URL: ${page.url}`];
    if (page.title) lines.push(`Title: ${page.title}`);
    if (page.contentType) lines.push(`Content-Type: ${page.contentType}`);
    if (page.description && offset === 0) lines.push(`Description: ${page.description}`);
    lines.push('');

    if (prompt && offset === 0 && page.text.length > 4_000) {
      const best = bestPassages(page.text, prompt, 3);
      if (best.length) {
        lines.push(`── Most relevant to "${prompt.slice(0, 120)}" ──`);
        for (const p of best) lines.push(`> ${p.heading ? `[${p.heading}] ` : ''}${p.text.replace(/\s*\n\s*/g, ' ').slice(0, 600)}`);
        lines.push('', '── The page ──');
      }
    }

    // The links go at the end of the last part; room is kept for them in
    // every part, so whether a part is the last doesn't change its size.
    const fitting = page.links.filter((l) => l.url.length <= LINK_URL_CHARS);
    const shown = fitting.slice(0, MAX_LINKS);
    const left = page.links.length - shown.length;
    const links = shown.length
      ? [`── Links (${shown.length}${left ? `; ${left} more not listed${fitting.length < page.links.length ? ', some with very long addresses' : ''}` : ''}) ──`,
        ...shown.map((l) => `- ${l.text.length > LINK_TEXT_CHARS ? `${l.text.slice(0, LINK_TEXT_CHARS - 1)}…` : l.text}: ${l.url}`)]
      : [];
    const head = lines.join('\n');
    const NOTES = 200;
    const part = Math.max(MIN_PART_CHARS, ANSWER_CHARS - head.length - links.join('\n').length - NOTES);

    const total = page.text.length;
    if (offset >= total && total > 0) return `${head}\n[The page has ${total} characters; offset ${offset} is past its end.]`;
    // Cut at a line end where there is one near the limit, so a part doesn't end mid-sentence.
    let end = Math.min(total, offset + part);
    if (end < total) {
      const nl = page.text.lastIndexOf('\n', end);
      if (nl > offset + part * 0.8) end = nl;
    }
    lines.push(page.text.slice(offset, end) || '(No readable text on this page.)');
    if (end < total) lines.push('', `[Part ${offset}–${end} of ${total} characters. Read on with offset: ${end}.]`);
    if (page.cut) lines.push('', '[The page was longer than Cascade reads; this is its start.]');
    if (links.length && end >= total) lines.push('', ...links);
    return lines.join('\n');
  }
}
