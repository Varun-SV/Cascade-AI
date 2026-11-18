// ─────────────────────────────────────────────
//  Cascade AI — Open Web: free search and reading, no keys
// ─────────────────────────────────────────────
//
//  What `web_search` does when no keyed backend is set, and what `web_fetch`
//  reads pages with.
//
//  - Many sources at once. The query goes to DuckDuckGo, Marginalia and
//    Wikipedia, and to the specialist sources it calls for, all in parallel and
//    under one deadline. Their lists are merged into one ranking, duplicates
//    folded together, and no site takes over the top.
//  - It looks after itself. A source showing a bot check or a rate limit is
//    rested for a while, one that keeps failing is rested longer, and answers
//    are kept for a few minutes, so a run that asks the same thing twice, or
//    many workers asking alike, don't hammer anyone. A datacenter address
//    (a hosted server's) is what gets turned away most; with several sources
//    one refusing still leaves an answer.
//  - Search and read in one step. On request, the top results are opened and
//    only their passages that answer the query come back, each with its source,
//    so the model gets evidence rather than ten links to open one at a time.

import { safeFetch } from '../utils/safe-fetch.js';
import type { WebSearchResult } from '../web-search.js';
import { BlockedError, BROWSER_UA, type EngineId, type Fetch, UnreadableAnswerError, engines as allEngines } from './engines.js';
import { type FusedResult, fuse } from './fuse.js';
import { type ReadablePage, readHtml } from './html.js';
import { type Passage, bestPassages } from './passages.js';
import { route } from './route.js';

/** How long the whole fan-out may take: the sources that answered by then are used. */
export const SEARCH_DEADLINE_MS = 8_000;
/** One page, when reading results. */
export const READ_TIMEOUT_MS = 10_000;
/** Bytes of one page read, at most. */
export const MAX_PAGE_BYTES = 2_000_000;

const SEARCH_TTL_MS = 10 * 60_000;
const PAGE_TTL_MS = 15 * 60_000;

/** What became of one source for one query. */
export interface SourceOutcome {
  engine: EngineId;
  outcome: 'answered' | 'empty' | 'blocked' | 'failed' | 'resting' | 'too slow';
  detail?: string;
  /** Results it gave. */
  found?: number;
}

/**
 * One search, as an operator may see it: which sources answered, and how many
 * results there were. Never the query, a result's address, or anything else
 * that would say what a person searched for; not even a hash of it, which a
 * guess can be checked against.
 */
export interface OpenWebSummary {
  sources: Array<{ engine: EngineId; outcome: SourceOutcome['outcome']; found: number }>;
  results: number;
  /** A shorter form of the query was tried after the first found nothing. */
  retried: boolean;
  ms: number;
}

const summaryListeners = new Set<(summary: OpenWebSummary) => void>();

/**
 * Told of each Open Web search when it ends, for a host's own logs (the cloud
 * server). Nothing listens unless a host asks, so a CLI prints nothing.
 * Returns the way to stop listening.
 */
export function onOpenWebSearch(listener: (summary: OpenWebSummary) => void): () => void {
  summaryListeners.add(listener);
  return () => { summaryListeners.delete(listener); };
}

export function reportOpenWebSearch(summary: OpenWebSummary): void {
  for (const listener of summaryListeners) {
    try { listener(summary); } catch { /* a listener's trouble isn't the search's */ }
  }
}

const QUERY_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'is', 'are', 'was', 'be', 'it', 'its',
  'what', 'which', 'who', 'how', 'why', 'when', 'where', 'should', 'would', 'could', 'can', 'do', 'does', 'i', 'me', 'my',
  'you', 'your', 'about', 'vs', 'versus', 'review', 'reviews', 'best', 'good', 'buy', 'worth', 'get', 'tell', 'find',
]);

/**
 * The query's key words, for a second try when the first found nothing: no
 * quotes or operators, no common words, at most six terms. Null when that is
 * the query already, or leaves nothing. Exported for tests.
 */
export function simplerQuery(query: string): string | null {
  const words = query
    .replace(/\b(?:site|intitle|inurl|filetype):\S+/gi, ' ')
    .replace(/["'`“”‘’()[\]{}<>]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w && !QUERY_STOP.has(w.toLowerCase()));
  const simple = [...new Set(words)].slice(0, 6).join(' ');
  return simple && simple.toLowerCase() !== query.trim().replace(/\s+/g, ' ').toLowerCase() ? simple : null;
}

export interface OpenWebSearch {
  results: FusedResult[];
  sources: SourceOutcome[];
  /** Some source answered, even with nothing: a miss for this query, not an outage. */
  reachable: boolean;
}

interface Health { failures: number; restUntil: number; reason?: string }

/** Small and bounded: the oldest entry goes first once it is full. */
class TtlCache<V> {
  private readonly map = new Map<string, { at: number; value: V }>();
  constructor(private readonly ttlMs: number, private readonly max: number) {}
  get(key: string, now: number): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  set(key: string, value: V, now: number): void {
    this.map.delete(key);
    this.map.set(key, { at: now, value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  clear(): void { this.map.clear(); }
}

/**
 * The sources' health and what was found lately. One per process: on the server
 * every run shares it, which is the point — the tenth run of the hour shouldn't
 * be the one that gets everyone blocked.
 */
export class OpenWebState {
  readonly health = new Map<EngineId, Health>();
  readonly searches = new TtlCache<{ engine: EngineId; results: WebSearchResult[] }>(SEARCH_TTL_MS, 300);
  readonly pages = new TtlCache<FetchedPage>(PAGE_TTL_MS, 64);

  resting(engine: EngineId, now: number): Health | undefined {
    const h = this.health.get(engine);
    return h && h.restUntil > now ? h : undefined;
  }

  succeeded(engine: EngineId): void { this.health.delete(engine); }

  failed(engine: EngineId, err: unknown, now: number): void {
    const h = this.health.get(engine) ?? { failures: 0, restUntil: 0 };
    h.failures += 1;
    if (err instanceof BlockedError) {
      // Turned away: give it real time, more each time it happens again.
      const asked = err.retryAfterMs ?? 0;
      h.restUntil = now + Math.min(Math.max(asked, 5 * 60_000 * 2 ** Math.min(h.failures - 1, 3)), 60 * 60_000);
      h.reason = err.message;
    } else if (h.failures >= 2) {
      // A blip is retried; a pattern is rested, 30 s doubling up to half an hour.
      h.restUntil = now + Math.min(30_000 * 2 ** (h.failures - 2), 30 * 60_000);
      h.reason = err instanceof Error ? err.message : String(err);
    }
    this.health.set(engine, h);
  }

  clear(): void {
    this.health.clear();
    this.searches.clear();
    this.pages.clear();
  }
}

/** The process's own: shared by every run in it. */
export const openWebState = new OpenWebState();

export interface SearchOptions {
  maxResults: number;
  signal?: AbortSignal;
  fetcher?: Fetch;
  state?: OpenWebState;
  now?: () => number;
  deadlineMs?: number;
}

/** The work, or the signal's reason once it fires: a source that ignores the signal can't hold up the rest. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // First: once this returns early, nothing else would ever see the work fail.
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    work.then(
      (v) => { signal.removeEventListener('abort', stop); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', stop); reject(e); },
    );
  });
}

const normalized = (q: string): string => q.trim().replace(/\s+/g, ' ').toLowerCase();

/** The free sources for `query`, asked at once and merged. */
export async function openWebSearch(query: string, opts: SearchOptions): Promise<OpenWebSearch> {
  const state = opts.state ?? openWebState;
  const now = opts.now ?? Date.now;
  const fetcher: Fetch = opts.fetcher ?? ((url, init) => fetch(url, init));
  const sources = allEngines(fetcher);
  const plan = route(query);
  const max = Math.max(1, Math.min(opts.maxResults, 10));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('too slow')), opts.deadlineMs ?? SEARCH_DEADLINE_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
  const outcomes: SourceOutcome[] = [];
  const lists: Array<{ engine: string; weight: number; results: WebSearchResult[] }> = [];
  let reachable = false;
  try {
    await Promise.all((Object.entries(plan.engines) as Array<[EngineId, number]>).map(async ([id, weight]) => {
      const key = `${id}|${max}|${normalized(query)}`;
      const cached = state.searches.get(key, now());
      if (cached) {
        reachable = true;
        lists.push({ engine: id, weight, results: cached.results });
        outcomes.push({ engine: id, outcome: cached.results.length ? 'answered' : 'empty', detail: 'from a moment ago', found: cached.results.length });
        return;
      }
      const resting = state.resting(id, now());
      if (resting) { outcomes.push({ engine: id, outcome: 'resting', ...(resting.reason ? { detail: resting.reason } : {}) }); return; }
      // Stopped already: no source is asked at all.
      if (opts.signal?.aborted) throw opts.signal.reason;
      try {
        const results = await untilAborted(sources[id].search(query, max, signal), signal);
        state.succeeded(id);
        state.searches.set(key, { engine: id, results }, now());
        reachable = true;
        lists.push({ engine: id, weight, results });
        outcomes.push({ engine: id, outcome: results.length ? 'answered' : 'empty', found: results.length });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (deadline.signal.aborted) {
          // Counted like any failure: a source that hangs would otherwise hold
          // every search to the full deadline for as long as it is down.
          state.failed(id, new Error('did not answer in time'), now());
          outcomes.push({ engine: id, outcome: 'too slow' });
          return;
        }
        state.failed(id, err, now());
        // It answered: reached, whatever the answer was.
        if (err instanceof UnreadableAnswerError) reachable = true;
        outcomes.push({
          engine: id,
          outcome: err instanceof BlockedError ? 'blocked' : 'failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }));
  } finally {
    clearTimeout(timer);
  }
  return { results: fuse(lists, max), sources: outcomes, reachable };
}

// ── Reading pages ──────────────────────────────

export interface FetchedPage extends ReadablePage {
  url: string;
  contentType: string;
  /** The body was longer than was read. */
  cut?: boolean;
}

/** A page, as its server sent it: through the SSRF guard, redirects and all. */
export type PageFetch = (url: string, init: RequestInit) => Promise<Response>;

async function bodyText(resp: Response, maxBytes: number): Promise<{ text: string; cut: boolean }> {
  const reader = resp.body?.getReader?.();
  if (!reader) {
    const text = await resp.text();
    return { text: text.slice(0, maxBytes), cut: text.length > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  const charset = /charset=([\w-]+)/i.exec(resp.headers.get('content-type') ?? '')?.[1];
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset ?? 'utf-8'); } catch { decoder = new TextDecoder('utf-8'); }
  return { text: decoder.decode(all), cut };
}

function pageKey(url: string): string {
  try { const u = new URL(url); u.hash = ''; return u.toString(); } catch { return url; }
}

/** Pages we can't read as text. */
export class UnreadablePageError extends Error {}

/**
 * A page fetched and read: the main content of HTML, or plain text and JSON as
 * they are. Always through the SSRF guard: a result's address is the web's to
 * choose, and on the hosted server it must not reach the server's own network.
 */
export async function fetchReadable(url: string, opts: { signal?: AbortSignal; fetchPage?: PageFetch; state?: OpenWebState; now?: () => number; maxBytes?: number } = {}): Promise<FetchedPage> {
  const state = opts.state ?? openWebState;
  const now = opts.now ?? Date.now;
  // The address as asked for, less its fragment: the server never sees that.
  // Not the search's canonical form, which folds /docs and /docs/, or www and
  // the bare host, together: those can be different documents.
  const key = pageKey(url);
  const cached = state.pages.get(key, now());
  if (cached) return cached;
  const fetchPage = opts.fetchPage ?? safeFetch;
  const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
  const resp = await fetchPage(url, {
    headers: {
      'User-Agent': `${BROWSER_UA} Cascade-AI/1`,
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.8',
    },
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ''}`);
  const contentType = (resp.headers?.get?.('content-type') ?? '').toLowerCase();
  const finalUrl = resp.url || url;
  if (contentType && !/text\/|html|json|xml|javascript/.test(contentType)) {
    throw new UnreadablePageError(`it is ${contentType.split(';')[0]}, not a page of text`);
  }
  const { text, cut } = await bodyText(resp, opts.maxBytes ?? MAX_PAGE_BYTES);
  const isHtml = contentType.includes('html') || (!contentType && /^\s*<(?:!doctype|html|head|body)/i.test(text));
  const page: FetchedPage = isHtml
    ? { ...readHtml(text, finalUrl), url: finalUrl, contentType, ...(cut ? { cut } : {}) }
    : { title: '', text, links: [], url: finalUrl, contentType, ...(cut ? { cut } : {}) };
  state.pages.set(key, page, now());
  return page;
}

export interface ReadResult {
  /** The result's number in the list shown. */
  index: number;
  title: string;
  url: string;
  passages: Passage[];
  error?: string;
}

/** Opens the top results at once and keeps the passages of each that answer the query. */
export async function readTopResults(
  results: WebSearchResult[],
  query: string,
  opts: { count: number; signal?: AbortSignal; fetchPage?: PageFetch; state?: OpenWebState; now?: () => number; perPage?: number },
): Promise<ReadResult[]> {
  const picked = results.slice(0, Math.max(0, Math.min(opts.count, 5)));
  return Promise.all(picked.map(async (r, i): Promise<ReadResult> => {
    try {
      const page = await fetchReadable(r.url, opts);
      const passages = bestPassages(page.text, query, opts.perPage ?? 3);
      return { index: i + 1, title: page.title || r.title, url: page.url, passages };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return { index: i + 1, title: r.title, url: r.url, passages: [], error: err instanceof Error ? err.message : String(err) };
    }
  }));
}
