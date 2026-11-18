// ─────────────────────────────────────────────
//  Cascade AI — Open Web: the free search sources
// ─────────────────────────────────────────────
//
//  Each source is a public endpoint that needs no key: DuckDuckGo's HTML pages,
//  Marginalia, Wikipedia, and for queries that call for them Stack Overflow,
//  GitHub, Hacker News, arXiv, npm and PyPI. Their hosts are fixed here, so a
//  query can't point a fetch anywhere else.
//
//  A source that refuses us — DuckDuckGo's bot check, a rate limit — says so
//  with a `BlockedError`, and is rested rather than asked again at once.

import type { WebSearchResult } from '../web-search.js';
import { decodeEntities } from './html.js';

export type EngineId =
  | 'duckduckgo' | 'marginalia' | 'wikipedia'
  | 'stackoverflow' | 'github' | 'hackernews' | 'arxiv' | 'npm' | 'pypi';

/** A source turning us away for a while: a bot check or a rate limit. */
export class BlockedError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'BlockedError';
  }
}

export interface Engine {
  id: EngineId;
  search(query: string, max: number, signal: AbortSignal): Promise<WebSearchResult[]>;
}

/** Fetch, as the tests replace it. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const VERSION = '1';
/** For APIs that ask clients to say who they are (Wikimedia does). */
export const API_UA = `Cascade-AI/${VERSION} (+https://github.com/Varun-SV/Cascade-AI)`;
/** A real browser's: DuckDuckGo shows bot-looking agents a check page. */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const strip = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function retryAfter(resp: Response): number | undefined {
  const raw = resp.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function get(fetcher: Fetch, url: string, signal: AbortSignal, headers: Record<string, string>): Promise<Response> {
  const resp = await fetcher(url, { headers, signal });
  if (resp.status === 429 || resp.status === 403) {
    throw new BlockedError(`HTTP ${resp.status}`, retryAfter(resp));
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp;
}

const json = async <T>(fetcher: Fetch, url: string, signal: AbortSignal, extra: Record<string, string> = {}): Promise<T> =>
  await (await get(fetcher, url, signal, { 'User-Agent': API_UA, Accept: 'application/json', ...extra })).json() as T;

// ── DuckDuckGo ────────────────────────────────

/**
 * DDG wraps result hrefs in a redirect (`//duckduckgo.com/l/?uddg=<encoded>`).
 * Unwrapped to the real destination so a later fetch reaches the actual site.
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

/**
 * Anchors carrying the given class in DDG markup, in single or double quotes and
 * any attribute order, with the snippets beside them.
 */
export function parseDdgAnchors(html: string, anchorClass: string, snippetClass: string): WebSearchResult[] {
  const anchorRe = new RegExp(`<a\\b[^>]*class=["']?[^"'>]*\\b${anchorClass}\\b[^"'>]*["']?[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
  const snippetRe = new RegExp(`class=["']?[^"'>]*\\b${snippetClass}\\b[^"'>]*["']?[^>]*>([\\s\\S]*?)<\\/(?:td|a|div|span)>`, 'gi');
  // Every anchor, ads included, where it stands in the page: a snippet is the
  // one that follows its result, so it is matched by position, not by count.
  // Dropping an ad's anchor alone would hand its sales text to the next result.
  const found: Array<WebSearchResult & { at: number; ad: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
    const title = strip(m[1] ?? '');
    if (!href || !title) continue;
    const url = unwrapDdgRedirect(decodeEntities(href));
    // DDG's own ads go through its click tracker; they are not results.
    const ad = /^https?:\/\/(?:[a-z0-9-]+\.)*duckduckgo\.com\/y\.js/i.test(url);
    found.push({ title, url, snippet: '', at: m.index, ad });
  }
  let next = 0;
  while ((m = snippetRe.exec(html)) !== null) {
    while (next + 1 < found.length && found[next + 1]!.at < m.index) next++;
    const owner = found[next];
    if (owner && owner.at < m.index && !owner.snippet) owner.snippet = strip(m[1] ?? '');
  }
  return found.filter((r) => !r.ad).map(({ title, url, snippet }) => ({ title, url, snippet }));
}

/** DuckDuckGo's bot check, as served in place of results. Exported for tests. */
export function isDdgChallenge(status: number, html: string): boolean {
  if (status === 202) return true;
  const head = html.slice(0, 20_000).toLowerCase();
  return head.includes('anomaly-modal') || head.includes('challenge-form') || head.includes('/anomaly.js')
    || head.includes('bots use duckduckgo too') || head.includes('please complete the following challenge');
}

function duckduckgo(fetcher: Fetch): Engine {
  return {
    id: 'duckduckgo',
    async search(query, max, signal) {
      // The HTML endpoint first, Lite if it is turned away; one check page means
      // the other will likely say the same before long, but not always.
      let blocked: BlockedError | undefined;
      for (const variant of ['html', 'lite'] as const) {
        const url = variant === 'html'
          ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
          : `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
        let resp: Response;
        try {
          resp = await get(fetcher, url, signal, { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8' });
        } catch (e) {
          if (e instanceof BlockedError) { blocked = e; continue; }
          throw e;
        }
        const html = await resp.text();
        if (isDdgChallenge(resp.status, html)) { blocked = new BlockedError('DuckDuckGo showed its bot check'); continue; }
        const found = variant === 'html'
          ? parseDdgAnchors(html, 'result__a', 'result__snippet')
          : parseDdgAnchors(html, 'result-link', 'result-snippet');
        return found.slice(0, max).map((r) => ({ ...r, engine: 'duckduckgo' }));
      }
      throw blocked ?? new Error('no answer');
    },
  };
}

// ── Marginalia ────────────────────────────────

function marginalia(fetcher: Fetch): Engine {
  return {
    id: 'marginalia',
    async search(query, max, signal) {
      const data = await json<{ results?: Array<{ url?: string; title?: string; description?: string }> }>(
        fetcher, `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}?count=${max}`, signal);
      return (data.results ?? []).filter((r) => r.url && r.title).slice(0, max)
        .map((r) => ({ title: strip(r.title!), url: r.url!, snippet: strip(r.description ?? ''), engine: 'marginalia' }));
    },
  };
}

// ── Wikipedia ─────────────────────────────────

function wikipedia(fetcher: Fetch): Engine {
  return {
    id: 'wikipedia',
    async search(query, max, signal) {
      const data = await json<{ pages?: Array<{ key?: string; title?: string; excerpt?: string; description?: string }> }>(
        fetcher, `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${Math.min(max, 5)}`, signal);
      return (data.pages ?? []).filter((p) => p.key && p.title).map((p) => ({
        title: `${p.title!} — Wikipedia`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key!).replace(/%2F/g, '/')}`,
        snippet: [p.description, strip(p.excerpt ?? '')].filter(Boolean).join(': '),
        engine: 'wikipedia',
      }));
    },
  };
}

// ── Stack Overflow ────────────────────────────

function stackoverflow(fetcher: Fetch): Engine {
  return {
    id: 'stackoverflow',
    async search(query, max, signal) {
      const data = await json<{
        items?: Array<{ title?: string; link?: string; score?: number; is_answered?: boolean; answer_count?: number; tags?: string[] }>;
        backoff?: number; error_id?: number; error_message?: string;
      }>(fetcher, `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=${max}&q=${encodeURIComponent(query)}`, signal);
      if (data.error_id) throw new BlockedError(data.error_message ?? `error ${data.error_id}`);
      return (data.items ?? []).filter((i) => i.link && i.title).map((i) => ({
        title: decodeEntities(i.title!),
        url: i.link!,
        snippet: [
          i.is_answered ? `Answered (${i.answer_count ?? 0} answers)` : `${i.answer_count ?? 0} answers, none accepted`,
          `score ${i.score ?? 0}`,
          i.tags?.length ? `tags: ${i.tags.slice(0, 5).join(', ')}` : '',
        ].filter(Boolean).join(' · '),
        engine: 'stackoverflow',
      }));
    },
  };
}

// ── GitHub ────────────────────────────────────

function github(fetcher: Fetch): Engine {
  return {
    id: 'github',
    async search(query, max, signal) {
      const data = await json<{ items?: Array<{ full_name?: string; html_url?: string; description?: string | null; stargazers_count?: number; language?: string | null; pushed_at?: string }> }>(
        fetcher, `https://api.github.com/search/repositories?per_page=${max}&q=${encodeURIComponent(query)}`, signal,
        { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
      return (data.items ?? []).filter((r) => r.html_url && r.full_name).map((r) => ({
        title: `${r.full_name!} (GitHub)`,
        url: r.html_url!,
        snippet: [r.description ?? '', `★ ${r.stargazers_count ?? 0}`, r.language ?? '', r.pushed_at ? `updated ${r.pushed_at.slice(0, 10)}` : '']
          .filter(Boolean).join(' · '),
        engine: 'github',
      }));
    },
  };
}

// ── Hacker News ───────────────────────────────

function hackernews(fetcher: Fetch): Engine {
  return {
    id: 'hackernews',
    async search(query, max, signal) {
      const data = await json<{ hits?: Array<{ title?: string; url?: string | null; objectID?: string; points?: number; num_comments?: number; created_at?: string }> }>(
        fetcher, `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${max}&query=${encodeURIComponent(query)}`, signal);
      return (data.hits ?? []).filter((h) => h.title && h.objectID).map((h) => {
        const thread = `https://news.ycombinator.com/item?id=${h.objectID!}`;
        return {
          title: h.title!,
          url: h.url || thread,
          snippet: `${h.points ?? 0} points, ${h.num_comments ?? 0} comments on Hacker News${h.created_at ? ` (${h.created_at.slice(0, 10)})` : ''}. Discussion: ${thread}`,
          engine: 'hackernews',
        };
      });
    },
  };
}

// ── arXiv ─────────────────────────────────────

/** Entries of an arXiv Atom feed. Walked with indexOf, not a regex over the feed. Exported for tests. */
export function parseArxiv(xml: string): Array<{ title: string; url: string; summary: string; published?: string; authors: string[] }> {
  const out: Array<{ title: string; url: string; summary: string; published?: string; authors: string[] }> = [];
  const field = (entry: string, tag: string): string => {
    const open = entry.indexOf(`<${tag}`);
    if (open === -1) return '';
    const start = entry.indexOf('>', open);
    const end = entry.indexOf(`</${tag}>`, start);
    return start === -1 || end === -1 ? '' : entry.slice(start + 1, end);
  };
  let at = 0;
  while (out.length < 50) {
    const open = xml.indexOf('<entry>', at);
    if (open === -1) break;
    const close = xml.indexOf('</entry>', open);
    if (close === -1) break;
    const entry = xml.slice(open, close);
    at = close + 8;
    const authors: string[] = [];
    let a = 0;
    while (authors.length < 6) {
      const s = entry.indexOf('<name>', a);
      if (s === -1) break;
      const e = entry.indexOf('</name>', s);
      if (e === -1) break;
      authors.push(decodeEntities(entry.slice(s + 6, e)).trim());
      a = e + 7;
    }
    const url = field(entry, 'id').trim();
    const title = decodeEntities(field(entry, 'title')).replace(/\s+/g, ' ').trim();
    if (!url || !title) continue;
    const published = field(entry, 'published').trim().slice(0, 10);
    out.push({ title, url, summary: decodeEntities(field(entry, 'summary')).replace(/\s+/g, ' ').trim(), authors, ...(published ? { published } : {}) });
  }
  return out;
}

function arxiv(fetcher: Fetch): Engine {
  return {
    id: 'arxiv',
    async search(query, max, signal) {
      const resp = await get(fetcher, `https://export.arxiv.org/api/query?start=0&max_results=${max}&search_query=${encodeURIComponent(`all:${query}`)}`, signal,
        { 'User-Agent': API_UA, Accept: 'application/atom+xml' });
      return parseArxiv(await resp.text()).slice(0, max).map((e) => ({
        title: `${e.title} (arXiv)`,
        url: e.url.replace(/^http:/, 'https:'),
        snippet: `${e.authors.slice(0, 3).join(', ')}${e.authors.length > 3 ? ' et al.' : ''}${e.published ? `, ${e.published}` : ''}. ${e.summary.slice(0, 260)}`,
        engine: 'arxiv',
      }));
    },
  };
}

// ── npm and PyPI ──────────────────────────────

function npm(fetcher: Fetch): Engine {
  return {
    id: 'npm',
    async search(query, max, signal) {
      const data = await json<{ objects?: Array<{ package?: { name?: string; description?: string; version?: string; links?: { npm?: string } } }> }>(
        fetcher, `https://registry.npmjs.org/-/v1/search?size=${max}&text=${encodeURIComponent(query)}`, signal);
      return (data.objects ?? []).map((o) => o.package).filter((p): p is NonNullable<typeof p> => !!p?.name).map((p) => ({
        title: `${p.name!} (npm)`,
        url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name!}`,
        snippet: [p.description ?? '', p.version ? `v${p.version}` : ''].filter(Boolean).join(' · '),
        engine: 'npm',
      }));
    },
  };
}

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NOT_PACKAGES = new Set(['python', 'pip', 'pypi', 'install', 'package', 'packages', 'library', 'module', 'how', 'to', 'use', 'the', 'a', 'in', 'for', 'with', 'and', 'best', 'vs', 'version', 'latest', 'docs', 'documentation', 'example', 'examples']);

/** Words in a query that could be a PyPI package's name. Exported for tests. */
export function pypiCandidates(query: string): string[] {
  return [...new Set(query.split(/\s+/).map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')).filter((w) => PACKAGE_NAME.test(w) && !NOT_PACKAGES.has(w.toLowerCase())))].slice(0, 3);
}

function pypi(fetcher: Fetch): Engine {
  return {
    id: 'pypi',
    async search(query, max, signal) {
      // PyPI has no search API any more: look the likely names up directly.
      const found: WebSearchResult[] = [];
      for (const name of pypiCandidates(query)) {
        if (found.length >= max) break;
        const resp = await fetcher(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { headers: { 'User-Agent': API_UA, Accept: 'application/json' }, signal });
        if (resp.status === 404) continue;
        if (resp.status === 429) throw new BlockedError('HTTP 429', retryAfter(resp));
        if (!resp.ok) continue;
        const data = await resp.json() as { info?: { name?: string; summary?: string; version?: string; package_url?: string; requires_python?: string } };
        if (!data.info?.name) continue;
        found.push({
          title: `${data.info.name} (PyPI)`,
          url: data.info.package_url ?? `https://pypi.org/project/${data.info.name}/`,
          snippet: [data.info.summary ?? '', data.info.version ? `v${data.info.version}` : '', data.info.requires_python ? `Python ${data.info.requires_python}` : ''].filter(Boolean).join(' · '),
          engine: 'pypi',
        });
      }
      return found;
    },
  };
}

/** Every free source, fetching with `fetcher`. */
export function engines(fetcher: Fetch): Record<EngineId, Engine> {
  return {
    duckduckgo: duckduckgo(fetcher),
    marginalia: marginalia(fetcher),
    wikipedia: wikipedia(fetcher),
    stackoverflow: stackoverflow(fetcher),
    github: github(fetcher),
    hackernews: hackernews(fetcher),
    arxiv: arxiv(fetcher),
    npm: npm(fetcher),
    pypi: pypi(fetcher),
  };
}
