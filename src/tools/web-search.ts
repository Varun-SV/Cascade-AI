// ─────────────────────────────────────────────
//  Cascade AI — Web Search Tool
// ─────────────────────────────────────────────
//
//  Supports multiple backends in priority order:
//    1. SearXNG  (self-hosted, primary)
//    2. Brave Search API
//    3. Tavily API
//    4. DuckDuckGo Lite  (no API key needed, last resort)
//
//  Configuration (env vars or config.json tools.webSearch):
//    SEARXNG_URL          — Base URL of your SearXNG instance
//    BRAVE_SEARCH_API_KEY — Brave Search API key
//    TAVILY_API_KEY       — Tavily API key
//
//  DuckDuckGo Lite is always available as a final fallback.
// ─────────────────────────────────────────────

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

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
}

// ── SearXNG ───────────────────────────────────

async function searchSearXNG(
  query: string,
  baseUrl: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'general');
  url.searchParams.set('engines', 'google,bing,duckduckgo');

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': 'Cascade-AI/1.0 WebSearchTool' },
    signal: AbortSignal.timeout(10_000),
  });

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

// ── DuckDuckGo scraping (no key required, last resort) ───────────────
//
//  Two endpoints, both parsed with deliberately tolerant patterns: DDG's
//  markup varies (single- vs double-quoted attributes, attribute order) and
//  the old double-quote-only regex silently matched nothing — the reason
//  web_search "didn't work" on default installs with no keyed backend.

// A real browser UA — DDG serves bot-looking agents an anomaly page.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * DDG wraps result hrefs in a redirect (`//duckduckgo.com/l/?uddg=<encoded>`).
 * Unwrap to the real destination so downstream web_fetch hits the actual site.
 * Exported for tests.
 */
export function unwrapDdgRedirect(href: string): string {
  try {
    const url = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com');
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : href;
  } catch {
    return href;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

/**
 * Parse anchors carrying the given class from DDG markup, tolerating single
 * OR double quotes and any attribute order. Exported for tests.
 */
export function parseDdgAnchors(html: string, anchorClass: string, snippetClass: string): WebSearchResult[] {
  const anchorRe = new RegExp(`<a\\b[^>]*class=["']?[^"'>]*\\b${anchorClass}\\b[^"'>]*["']?[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
  const snippetRe = new RegExp(`class=["']?[^"'>]*\\b${snippetClass}\\b[^"'>]*["']?[^>]*>([\\s\\S]*?)<\\/(?:td|a|div|span)>`, 'gi');

  const results: WebSearchResult[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const tag = m[0]!;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    const title = decodeEntities(stripTags(m[1] ?? ''));
    if (!href || !title) continue;
    results.push({ title, url: unwrapDdgRedirect(decodeEntities(href)), snippet: '' });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(decodeEntities(stripTags(m[1] ?? '')));
  }
  for (let i = 0; i < results.length; i++) {
    if (snippets[i]) results[i]!.snippet = snippets[i]!;
  }
  return results;
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  variant: 'html' | 'lite',
): Promise<WebSearchResult[]> {
  const base = variant === 'html'
    ? 'https://html.duckduckgo.com/html/?q='
    : 'https://lite.duckduckgo.com/lite/?q=';
  const resp = await fetch(`${base}${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`DuckDuckGo ${variant} returned HTTP ${resp.status}`);
  const html = await resp.text();

  const parsed = variant === 'html'
    ? parseDdgAnchors(html, 'result__a', 'result__snippet')
    : parseDdgAnchors(html, 'result-link', 'result-snippet');

  return parsed.slice(0, maxResults).map((r) => ({ ...r, engine: `duckduckgo-${variant}` }));
}

// ── WebSearchTool ────────────────────────────

export class WebSearchTool extends BaseTool {
  readonly name = 'web_search';
  readonly description =
    'Search the web for current information, news, documentation, or any topic. Returns a list of relevant results with titles, URLs, and snippets.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      maxResults: { type: 'number', description: 'Number of results to return (default: 5, max: 10)' },
    },
    required: ['query'],
  };

  private config: WebSearchConfig;

  constructor(config: WebSearchConfig = {}) {
    super();
    this.config = {
      searxngUrl: config.searxngUrl ?? process.env['SEARXNG_URL'],
      braveApiKey: config.braveApiKey ?? process.env['BRAVE_SEARCH_API_KEY'],
      tavilyApiKey: config.tavilyApiKey ?? process.env['TAVILY_API_KEY'],
      maxResults: config.maxResults ?? 5,
    };
  }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const query = input['query'] as string;
    if (!query?.trim()) return 'Error: query is required and must be non-empty.';

    const maxResults = Math.min(
      (input['maxResults'] as number | undefined) ?? this.config.maxResults ?? 5,
      10,
    );

    const errors: string[] = [];
    let results: WebSearchResult[] = [];

    // ── 1. SearXNG (preferred — self-hosted, privacy-preserving) ──────────
    if (this.config.searxngUrl) {
      try {
        results = await searchSearXNG(query, this.config.searxngUrl, maxResults);
        if (results.length > 0) return this.formatResults(query, results);
        errors.push('SearXNG: returned 0 results');
      } catch (err) {
        errors.push(`SearXNG: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── 2. Brave Search ───────────────────────────────────────────────────
    if (this.config.braveApiKey) {
      try {
        results = await searchBrave(query, this.config.braveApiKey, maxResults);
        if (results.length > 0) return this.formatResults(query, results);
        errors.push('Brave: returned 0 results');
      } catch (err) {
        errors.push(`Brave: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── 3. Tavily ─────────────────────────────────────────────────────────
    if (this.config.tavilyApiKey) {
      try {
        results = await searchTavily(query, this.config.tavilyApiKey, maxResults);
        if (results.length > 0) return this.formatResults(query, results);
        errors.push('Tavily: returned 0 results');
      } catch (err) {
        errors.push(`Tavily: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── 4. DuckDuckGo (always available, no key needed) ──────────────────
    // html.duckduckgo.com first (richer markup), lite as the final fallback.
    for (const variant of ['html', 'lite'] as const) {
      try {
        results = await searchDuckDuckGo(query, maxResults, variant);
        if (results.length > 0) return this.formatResults(query, results);
        errors.push(`DuckDuckGo ${variant}: returned 0 results`);
      } catch (err) {
        errors.push(`DuckDuckGo ${variant}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // All backends failed
    const configHint = !this.config.searxngUrl && !this.config.braveApiKey && !this.config.tavilyApiKey
      ? '\nTip: Configure a search backend for better results:\n  • Self-hosted: set SEARXNG_URL in your environment\n  • Brave Search API: set BRAVE_SEARCH_API_KEY\n  • Tavily API: set TAVILY_API_KEY'
      : '';

    return [
      `Web search for "${query}" failed across all backends:`,
      ...errors.map((e) => `  • ${e}`),
      configHint,
    ].join('\n');
  }

  private formatResults(query: string, results: WebSearchResult[]): string {
    const lines = [`Web search results for: "${query}"`, ''];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      lines.push(`[${i + 1}] ${r.title}`);
      lines.push(`    URL: ${r.url}`);
      if (r.snippet) lines.push(`    ${r.snippet.slice(0, 300)}`);
      if (r.engine) lines.push(`    Source: ${r.engine}`);
      lines.push('');
    }
    return lines.join('\n');
  }
}
