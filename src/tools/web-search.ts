// ─────────────────────────────────────────────
//  Cascade AI — Web Search Tool
// ─────────────────────────────────────────────
//
//  Backends in priority order:
//    1. SearXNG  (self-hosted)
//    2. Brave Search API
//    3. Tavily API
//    4. Open Web (no key: DuckDuckGo, Marginalia, Wikipedia, and Stack
//       Overflow, GitHub, Hacker News, arXiv, npm and PyPI when the query is
//       theirs, asked at once and merged; see ./open-web)
//
//  Configuration (env vars or config.json tools.webSearch):
//    SEARXNG_URL          — Base URL of your SearXNG instance
//    BRAVE_SEARCH_API_KEY — Brave Search API key
//    TAVILY_API_KEY       — Tavily API key
//
//  Open Web is always there as the fallback, and is what runs with no keys.
//  With `read`, the top results are opened and the passages that answer the
//  query come back with them, whichever backend found them.
// ─────────────────────────────────────────────

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';
import type { Fetch } from './open-web/engines.js';
import { type OpenWebState, type PageFetch, type ReadResult, type SourceOutcome, openWebSearch, readTopResults } from './open-web/index.js';
import { safeFetch } from './utils/safe-fetch.js';

export { parseDdgAnchors, unwrapDdgRedirect } from './open-web/engines.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

export interface WebSearchConfig {
  /** Base URL of a SearXNG instance e.g. https://searx.example.com */
  searxngUrl?: string;
  /** Brave Search API key */
  braveApiKey?: string;
  /** Tavily API key */
  tavilyApiKey?: string;
  /** Max number of results to return (default: 5) */
  maxResults?: number;
  /**
   * Send `searxngUrl` through the SSRF guard instead of fetching it directly.
   *
   * This is a statement about where the URL CAME FROM, not about the URL
   * itself. On a CLI or desktop run it is the machine owner's own config, and
   * a self-hosted SearXNG legitimately lives on `localhost:8080` or a LAN
   * address — guarding it there would break the setup this tool documents as
   * its preferred backend. On the hosted server the same field arrives in a
   * request body from a client, which makes it attacker-controlled input
   * pointed at a fetch the server performs: exactly the shape `safeFetch`
   * exists to stop.
   *
   * Brave and Tavily need no equivalent because their endpoints are hardcoded
   * here; only the SearXNG URL is caller-supplied.
   *
   * Off by default, so the guard is something a host opts INTO. That default
   * is deliberate: the CLI is the common case and must keep working, and a
   * host that accepts remote input is the party that knows it did.
   */
  guardSearxngUrl?: boolean;
}

// ── SearXNG ───────────────────────────────────

async function searchSearXNG(
  query: string,
  baseUrl: string,
  maxResults: number,
  guardUrl = false,
): Promise<WebSearchResult[]> {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'general');
  url.searchParams.set('engines', 'google,bing,duckduckgo');

  const init: RequestInit = {
    headers: { 'User-Agent': 'Cascade-AI/1.0 WebSearchTool' },
    signal: AbortSignal.timeout(10_000),
  };
  // Spelled out rather than picking a function into a variable: the global
  // `fetch` is not reliably callable once detached from its receiver, and the
  // two branches read more honestly than a name that hides which one ran.
  const resp = guardUrl
    ? await safeFetch(url.toString(), init)
    : await fetch(url.toString(), init);

  if (!resp.ok) {
    throw new Error(`SearXNG returned HTTP ${resp.status}`);
  }

  const data = await resp.json() as {
    results?: Array<{ title?: string; url?: string; content?: string; engine?: string }>;
  };

  return (data.results ?? [])
    .filter((r) => r.url && r.title)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
      engine: `searxng(${r.engine ?? 'unknown'})`,
    }));
}

// ── Brave Search ─────────────────────────────

async function searchBrave(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}&safesearch=off`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    throw new Error(`Brave Search returned HTTP ${resp.status}`);
  }

  const data = await resp.json() as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string }>;
    };
  };

  return (data.web?.results ?? [])
    .filter((r) => r.url && r.title)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
      engine: 'brave',
    }));
}

// ── Tavily ────────────────────────────────────

async function searchTavily(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`Tavily returned HTTP ${resp.status}`);
  }

  const data = await resp.json() as {
    results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
  };

  return (data.results ?? [])
    .filter((r) => r.url && r.title)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
      engine: 'tavily',
    }));
}

// ── WebSearchTool ────────────────────────────

/** What the tool reaches the web with: replaced in tests. */
export interface WebSearchDeps {
  /** For the search sources, whose hosts are fixed. */
  fetcher?: Fetch;
  /** For the result pages `read` opens: the SSRF-guarded fetch unless replaced. */
  fetchPage?: PageFetch;
  state?: OpenWebState;
}

const OUTCOME_WORDS: Record<SourceOutcome['outcome'], string> = {
  answered: 'answered', empty: 'found nothing', blocked: 'turned us away', failed: 'failed', resting: 'resting after refusing', 'too slow': 'too slow',
};

export class WebSearchTool extends BaseTool {
  readonly name = 'web_search';
  readonly description =
    'Search the web for current information, news, documentation, or any topic. Returns a list of relevant results with titles, URLs, and snippets. '
    + 'Set read: true to also open the top results and get back the passages that answer the query, with their sources: one call instead of a search and several fetches. '
    + 'Then use web_fetch to read a whole page.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      maxResults: { type: 'number', description: 'Number of results to return (default: 5, max: 10)' },
      read: { type: 'boolean', description: 'Also open the top 3 results and return the passages that answer the query (slower; default false)' },
    },
    required: ['query'],
  };

  private config: WebSearchConfig;
  private readonly deps: WebSearchDeps;

  constructor(config: WebSearchConfig = {}, deps: WebSearchDeps = {}) {
    super();
    this.deps = deps;
    this.config = {
      searxngUrl: config.searxngUrl ?? process.env['SEARXNG_URL'],
      braveApiKey: config.braveApiKey ?? process.env['BRAVE_SEARCH_API_KEY'],
      tavilyApiKey: config.tavilyApiKey ?? process.env['TAVILY_API_KEY'],
      maxResults: config.maxResults ?? 5,
      // Note this reads only from `config`, never from the environment: the
      // guard tracks the trustworthiness of the URL the host passed in, and an
      // env var says nothing about that.
      guardSearxngUrl: config.guardSearxngUrl ?? false,
    };
  }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const query = typeof input['query'] === 'string' ? input['query'] : '';
    if (!query.trim()) return 'Error: query is required and must be non-empty.';
    const signal = options?.signal;

    const asked = Number(input['maxResults'] ?? this.config.maxResults ?? 5);
    const maxResults = Math.max(1, Math.min(Number.isFinite(asked) ? Math.floor(asked) : 5, 10));
    const read = input['read'] === true;

    const errors: string[] = [];
    let results: WebSearchResult[] = [];
    // True once ANY backend actually responds, even with zero results. That
    // is a per-QUERY outcome (a different query might well find something),
    // not a systemic one — only "nothing could be reached at all" fails
    // identically for every worker in this run and deserves the systemic
    // tag. Conflating the two used to escalate the whole worker on a
    // perfectly ordinary "no results for this narrow/misspelled query".
    let anyBackendReachable = false;

    const done = async (found: WebSearchResult[], footer?: string): Promise<string> =>
      this.formatResults(query, found, footer, read ? await readTopResults(found, query, {
        count: 3, ...(signal ? { signal } : {}),
        ...(this.deps.fetchPage ? { fetchPage: this.deps.fetchPage } : {}),
        ...(this.deps.state ? { state: this.deps.state } : {}),
      }) : undefined);

    // ── 1. SearXNG (preferred — self-hosted, privacy-preserving) ──────────
    if (this.config.searxngUrl) {
      try {
        results = await searchSearXNG(query, this.config.searxngUrl, maxResults, this.config.guardSearxngUrl);
        anyBackendReachable = true;
        if (results.length > 0) return done(results);
        errors.push('SearXNG: returned 0 results');
      } catch (err) {
        errors.push(`SearXNG: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── 2. Brave Search ───────────────────────────────────────────────────
    if (this.config.braveApiKey) {
      try {
        results = await searchBrave(query, this.config.braveApiKey, maxResults);
        anyBackendReachable = true;
        if (results.length > 0) return done(results);
        errors.push('Brave: returned 0 results');
      } catch (err) {
        errors.push(`Brave: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── 3. Tavily ─────────────────────────────────────────────────────────
    if (this.config.tavilyApiKey) {
      try {
        results = await searchTavily(query, this.config.tavilyApiKey, maxResults);
        anyBackendReachable = true;
        if (results.length > 0) return done(results);
        errors.push('Tavily: returned 0 results');
      } catch (err) {
        errors.push(`Tavily: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── 4. Open Web (always available, no key needed) ────────────────────
    const open = await openWebSearch(query, {
      maxResults,
      ...(signal ? { signal } : {}),
      ...(this.deps.fetcher ? { fetcher: this.deps.fetcher } : {}),
      ...(this.deps.state ? { state: this.deps.state } : {}),
    });
    if (open.reachable) anyBackendReachable = true;
    const asked2 = open.sources.map((o) => `${o.engine} ${OUTCOME_WORDS[o.outcome]}`).join(', ');
    if (open.results.length > 0) return done(open.results, `Searched free sources (no key): ${asked2}.`);
    for (const o of open.sources) {
      errors.push(`${o.engine}: ${OUTCOME_WORDS[o.outcome]}${o.detail ? ` (${o.detail})` : ''}`);
    }

    // Nothing came back with results — either every backend errored, or every
    // backend responded fine but found nothing. This used to be a returned
    // STRING either way — an ordinary "successful" tool result as far as the
    // agent loop was concerned, fed straight back into the worker's context
    // with no signal that anything went wrong, free to produce a
    // plausible-sounding, completely ungrounded answer instead of stopping.
    // Throwing lets executeTool's CriticalToolError path escalate with the
    // real reason intact when it's genuinely systemic (see anyBackendReachable
    // above); when a backend WAS reachable, the worker recovers normally
    // (retry with a different query, or report nothing was found).
    const configHint = !this.config.searxngUrl && !this.config.braveApiKey && !this.config.tavilyApiKey
      ? '\nTip: Configure a search backend for better results:\n  • Self-hosted: set SEARXNG_URL in your environment\n  • Brave Search API: set BRAVE_SEARCH_API_KEY\n  • Tavily API: set TAVILY_API_KEY'
      : '';

    throw Object.assign(new Error([
      `Web search for "${query}" found nothing across all backends:`,
      ...errors.map((e) => `  • ${e}`),
      configHint,
    ].join('\n')), { systemic: !anyBackendReachable });
  }

  private formatResults(query: string, results: WebSearchResult[], footer?: string, read?: ReadResult[]): string {
    const lines = [`Web search results for: "${query}"`, ''];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const found = (r as { engines?: string[] }).engines;
      lines.push(`[${i + 1}] ${r.title}`);
      lines.push(`    URL: ${r.url}`);
      if (r.snippet) lines.push(`    ${r.snippet.slice(0, 300)}`);
      if (found && found.length) lines.push(`    Found by: ${found.join(', ')}`);
      else if (r.engine) lines.push(`    Source: ${r.engine}`);
      lines.push('');
    }
    if (read) {
      lines.push('── Read from the top results ──', '');
      for (const page of read) {
        lines.push(`[${page.index}] ${page.title}`, `    ${page.url}`);
        if (page.error) lines.push(`    Could not read it: ${page.error}`);
        else if (!page.passages.length) lines.push('    Nothing on it matched the query closely; web_fetch reads it whole.');
        for (const p of page.passages) {
          const text = p.text.replace(/\s*\n\s*/g, ' ').slice(0, 700);
          lines.push(`    > ${p.heading ? `[${p.heading}] ` : ''}${text}`);
        }
        lines.push('');
      }
      lines.push('Cite a passage by its result number. Read a whole page with web_fetch.');
    }
    if (footer) lines.push(footer);
    return lines.join('\n').trimEnd();
  }
}
