// ─────────────────────────────────────────────
//  Cascade AI — Read the page the user is looking at
// ─────────────────────────────────────────────
//
//  The other half of the desktop's internal browser. The user browses; this
//  lets the agent see what they are on, so "summarise this" or "what does this
//  error mean" works without pasting a URL and re-fetching it.
//
//  Deliberately NOT web_fetch. A page the user is on is often one web_fetch
//  cannot reach — behind a login, behind an SSO cookie, or rendered entirely by
//  client-side JavaScript. Re-fetching the URL would return a login wall or an
//  empty shell and the agent would answer confidently about the wrong content.
//  This reads the rendered DOM of the view already open in front of the user.
//
//  Registration is host-supplied: the provider only exists where there IS a
//  browser (the desktop app), so the tool never appears — and never has to be
//  refused — in the CLI or a hosted run.

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

/** What the host's browser view can tell us about the page on screen. */
export interface CurrentPageSnapshot {
  url: string;
  title: string;
  /** Rendered visible text, host-truncated if enormous. */
  text: string;
}

/**
 * Returns the page the user is currently viewing, or null when the browser is
 * closed / on a blank tab.
 */
export type CurrentPageProvider = () => Promise<CurrentPageSnapshot | null>;

/** Characters of page text handed to a model in one call. */
export const MAX_PAGE_TEXT_CHARS = 40_000;

export class CurrentPageTool extends BaseTool {
  readonly name = 'read_current_page';
  readonly description =
    'Read the web page the user currently has open in the built-in browser — its URL, title, and visible text. ' +
    'Use this whenever the user refers to "this page", "what I am looking at", or asks about something on screen. ' +
    'Prefer it over web_fetch for the open page: it sees content behind a login and content rendered by JavaScript, which web_fetch cannot.';

  readonly inputSchema = {
    type: 'object',
    properties: {},
    required: [],
  };

  private provider: CurrentPageProvider;

  constructor(provider: CurrentPageProvider) {
    super();
    this.provider = provider;
  }

  // Reading what is already on the user's screen changes nothing and reaches
  // nothing they have not already opened themselves.
  isDangerous(): boolean { return false; }

  async execute(_input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    let page: CurrentPageSnapshot | null;
    try {
      page = await this.provider();
    } catch (err) {
      return `Error: could not read the open page — ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!page) {
      // Say which state this is, so the model asks the user to open a page
      // rather than silently inventing what might have been on it.
      return 'No page is open in the built-in browser. Ask the user to open one, or use web_fetch for a public URL.';
    }

    const text = page.text.length > MAX_PAGE_TEXT_CHARS
      ? `${page.text.slice(0, MAX_PAGE_TEXT_CHARS)}\n\n[truncated — the page is longer than ${MAX_PAGE_TEXT_CHARS} characters]`
      : page.text;

    return [
      `URL: ${page.url}`,
      `Title: ${page.title}`,
      '',
      text.trim() || '[the page rendered no readable text]',
    ].join('\n');
  }
}
