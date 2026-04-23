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

// ── DuckDuckGo Lite (no key required, last resort) ───────────────────

async function searchDuckDuckGoLite(
  query: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  // DuckDuckGo Lite returns an HTML page — we parse key `<a>` tags
  const resp = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Cascade-AI/1.0)' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) throw new Error(`DuckDuckGo Lite returned HTTP ${resp.status}`);

  const html = await resp.text();

  // Extract result links from the lite HTML (result links follow a predictable pattern)
  const linkPattern = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  const snippetPattern = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;

  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = linkPattern.exec(html)) !== null) {
    links.push({ url: m[1]!, title: m[2]!.trim() });
  }
  while ((m = snippetPattern.exec(html)) !== null) {
    snippets.push(m[1]!.replace(/<[^>]+>/g, '').trim());
  }

  return links.slice(0, maxResults).map((link, i) => ({
    title: link.title,
    url: link.url,
    snippet: snippets[i] ?? '',
    engine: 'duckduckgo-lite',
  }));
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

    // ── 4. DuckDuckGo Lite (always available, no key needed) ─────────────
    try {
      results = await searchDuckDuckGoLite(query, maxResults);
      if (results.length > 0) return this.formatResults(query, results);
      errors.push('DuckDuckGo Lite: returned 0 results');
    } catch (err) {
      errors.push(`DuckDuckGo Lite: ${err instanceof Error ? err.message : String(err)}`);
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
