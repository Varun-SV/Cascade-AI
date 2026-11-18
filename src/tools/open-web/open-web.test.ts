import { afterEach, describe, expect, it, vi } from 'vitest';
import { truncateForContext } from '../../utils/truncate.js';
import { WebFetchTool } from '../web-fetch.js';
import { WebSearchTool } from '../web-search.js';
import { BlockedError, isDdgChallenge, parseArxiv, parseDdgAnchors, pypiCandidates } from './engines.js';
import { canonicalUrl, fuse } from './fuse.js';
import { decodeEntities, readHtml } from './html.js';
import { OpenWebState, fetchReadable, openWebSearch } from './index.js';
import { bestPassages, split } from './passages.js';
import { route } from './route.js';

/** A URL's host, compared whole: a substring of the URL could be anywhere in it. */
const hostIs = (url: string, host: string): boolean => new URL(url).hostname === host;
const ddgHost = (url: string): boolean => ['html.duckduckgo.com', 'lite.duckduckgo.com'].includes(new URL(url).hostname);

/** A Response-like answer, as the sources' fetch returns it. */
function reply(body: string | object, init: { status?: number; type?: string; headers?: Record<string, string>; url?: string } = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers({ 'content-type': init.type ?? (typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json'), ...(init.headers ?? {}) });
  const resp = new Response(text, { status: init.status ?? 200, headers });
  if (init.url) Object.defineProperty(resp, 'url', { value: init.url });
  return resp;
}

const DDG_HTML = `<html><body>
  <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide%3Futm_source%3Dddg&rut=x">The <b>Guide</b></a>
  <a class="result__snippet" href="/x">A guide to things.</a></div>
  <div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Ad</a></div>
  <div class="result"><a class="result__a" href="https://other.org/page">Other page</a><a class="result__snippet">Other words.</a></div>
</body></html>`;

describe('reading HTML', () => {
  it('keeps the article and its structure, and leaves out the furniture around it', () => {
    const page = readHtml(`<!doctype html><html><head><title>How timeouts work &mdash; Docs</title>
      <meta name="description" content="All about timeouts.">
      <script>var tracking = "<p>not text</p>";</script><style>p { color: red }</style></head>
      <body><nav><a href="/">Home</a><a href="/about">About</a></nav>
      <div class="cookie-banner">We use cookies. <button>Accept</button></div>
      <header><h1>Site name</h1></header>
      <article><h1>Timeouts</h1><p>The default timeout is <b>30 seconds</b>, and it can be changed.</p>
        <h2>Changing it</h2><ul><li>Set <code>timeout</code> in the config</li><li>Or pass <a href="/flags#t">--timeout</a></li></ul>
        <pre><code>cascade run --timeout 60
  # sixty seconds</code></pre>
        <table><tr><th>Name</th><th>Default</th></tr><tr><td>timeout</td><td>30</td></tr></table>
        <p hidden>Hidden text</p><div style="display: none">Also hidden</div>
      </article>
      <footer>© 2026 <a href="/legal">Legal</a></footer></body></html>`, 'https://docs.example/guide/timeouts');
    expect(page.title).toBe('How timeouts work — Docs');
    expect(page.description).toBe('All about timeouts.');
    expect(page.text).toContain('# Timeouts');
    expect(page.text).toContain('The default timeout is 30 seconds, and it can be changed.');
    expect(page.text).toContain('## Changing it');
    expect(page.text).toContain('- Set timeout in the config');
    expect(page.text).toContain('```\ncascade run --timeout 60\n  # sixty seconds\n```');
    expect(page.text).toContain('Name | Default');
    expect(page.text).toContain('timeout | 30');
    for (const gone of ['not text', 'color: red', 'cookies', 'Home', 'Site name', 'Legal', 'Hidden text', 'Also hidden']) {
      expect(page.text).not.toContain(gone);
    }
    expect(page.links).toEqual([{ text: '--timeout', url: 'https://docs.example/flags#t' }]);
  });

  it('keeps links found in headings and code blocks, and a code block\'s <br> line ends', () => {
    const page = readHtml(`<body><main><h2><a href="/manual/install">Install guide</a></h2>
      <p>The install guide covers every platform and option, with examples throughout.</p>
      <pre><code>const port = 8080; // default<br>console.log(port);<br/><a href="/api#port">port</a></code></pre></main></body>`, 'https://docs.example/');
    expect(page.links).toEqual([
      { text: 'Install guide', url: 'https://docs.example/manual/install' },
      { text: 'port', url: 'https://docs.example/api#port' },
    ]);
    expect(page.text).toContain('## Install guide');
    expect(page.text).toContain('```\nconst port = 8080; // default\nconsole.log(port);\nport\n```');
  });

  it('resolves relative links against the page\'s <base href>', () => {
    const html = '<html><head><base href="https://assets.example/manual/"></head><body><main><p>Read <a href="install.html">the install guide</a> and <a href="/faq">the FAQ</a> before you start here.</p></main></body></html>';
    expect(readHtml(html, 'https://example.com/view?id=1').links).toEqual([
      { text: 'the install guide', url: 'https://assets.example/manual/install.html' },
      { text: 'the FAQ', url: 'https://assets.example/faq' },
    ]);
    // A relative base is taken against the page's own address.
    expect(readHtml('<head><base href="/docs/"></head><body><main><p>See <a href="a.html">a page</a> for the rest of the details here.</p></main></body>', 'https://example.com/x/y').links)
      .toEqual([{ text: 'a page', url: 'https://example.com/docs/a.html' }]);
  });

  it('finds the main content by its paragraphs when nothing marks it', () => {
    const para = (n: number) => `<p>Paragraph ${n} has enough words in it, with commas, to count as reading matter for a page.</p>`;
    const page = readHtml(`<body><div class="menu-col"><a href="/a">One</a> <a href="/b">Two</a> <a href="/c">Three</a></div>
      <div class="content">${[1, 2, 3, 4].map(para).join('')}</div><div><a href="/x">Links</a> <a href="/y">only</a></div></body>`);
    expect(page.text).toContain('Paragraph 1');
    expect(page.text).toContain('Paragraph 4');
    expect(page.text).not.toContain('Links only');
  });

  it('survives broken markup, entities and a hostile page, in time linear in its size', () => {
    expect(decodeEntities('&lt;a&gt; &amp;amp; &#x1F600; &#169; &bogus; &#0;')).toBe('<a> &amp; 😀 © &bogus; &#0;');
    const broken = readHtml('<body><p>Unclosed <b>bold <i>italic<p>Next paragraph that is long enough to be kept as reading matter here.<div attr="a>b">After a quote</div> 3 < 4 </body>');
    expect(broken.text).toContain('Unclosed bold italic');
    expect(broken.text).toContain('After a quote');
    expect(broken.text).toContain('3 < 4');
    // Thousands of unclosed tags, and a huge attribute: no stack overflow, no stall.
    const started = Date.now();
    readHtml(`<body>${'<div>'.repeat(50_000)}deep${'<a href="'.repeat(1)}${'x'.repeat(500_000)}"></body>`);
    readHtml(`<body>${'<p '.repeat(100_000)}</body>`);
    expect(Date.now() - started).toBeLessThan(3_000);
    // A letter whose lowercase is two letters, before the markup: offsets stay true.
    const turkish = readHtml('<body><main><h1>İstanbul</h1><p>Visible article content, long enough to keep.</p><script>secretScriptCode()</script><nav>Menu</nav></main></body>');
    expect(turkish.text).toContain('# İstanbul');
    expect(turkish.text).toContain('Visible article content');
    expect(turkish.text).not.toContain('secretScriptCode');
    expect(turkish.text).not.toContain('Menu');
    // Names that are Object's own, as a tag or an entity: nothing inherited is found.
    const odd = readHtml('<body><main><constructor>x</constructor><p>Readable text &constructor; &toString; stays.</p></main></body>');
    expect(odd.text).toContain('Readable text &constructor; &toString; stays.');
    // A code block of very many lines: appended one by one, not spread into a call.
    const code = readHtml(`<body><pre>${'a\n'.repeat(200_000)}</pre></body>`);
    expect(code.text.startsWith('```\na\na')).toBe(true);
  });
});

describe('passages', () => {
  it('ranks the paragraph that answers the question first, under its heading', () => {
    const text = [
      '# Install', 'Run npm install cascade-ai to add the package to a project, then import it where it is needed.',
      '', '# Timeouts', 'The default request timeout is 30 seconds. Raise it with the timeout option when calls are slow.',
      '', '# License', 'The project is released under the MIT license, which allows reuse with attribution.',
    ].join('\n');
    const best = bestPassages(text, 'what is the default timeout', 2);
    expect(best[0]).toMatchObject({ heading: 'Timeouts' });
    expect(best[0]!.text).toContain('30 seconds');
    expect(bestPassages(text, 'zebra giraffe')).toEqual([]);
  });

  it('cuts a very long line at sentence ends', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says a little more about the subject.`).join(' ');
    const parts = split(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(900);
  });
});

describe('merging the sources', () => {
  it('folds one page under two addresses together, and ranks what several sources found higher', () => {
    expect(canonicalUrl('http://www.Example.com/docs/?utm_source=x&b=2&a=1#top')).toBe('https://example.com/docs?a=1&b=2');
    expect(canonicalUrl('https://github.com/o/r?ref=main')).toBe('https://github.com/o/r?ref=main');
    const out = fuse([
      { engine: 'duckduckgo', weight: 1, results: [
        { title: 'A', url: 'https://a.example/x', snippet: 'short' },
        { title: 'B', url: 'https://b.example/', snippet: '' },
      ] },
      { engine: 'wikipedia', weight: 1, results: [
        { title: 'B again', url: 'http://www.b.example/?utm_campaign=z', snippet: 'a longer description of B' },
      ] },
    ], 5);
    expect(out[0]).toMatchObject({ url: 'https://b.example/', engines: ['duckduckgo', 'wikipedia'], snippet: 'a longer description of B' });
    expect(out).toHaveLength(2);
  });

  it('lets no one site take over the top', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ title: `S${i}`, url: `https://same.example/${i}`, snippet: '' }));
    const out = fuse([{ engine: 'duckduckgo', weight: 1, results: [...many, { title: 'Else', url: 'https://else.example/', snippet: '' }] }], 4);
    expect(out.slice(0, 3).map((r) => r.url)).toEqual(['https://same.example/0', 'https://same.example/1', 'https://else.example/']);
  });
});

describe('which sources a query goes to', () => {
  it('asks the specialists only when the query is theirs', () => {
    expect(Object.keys(route('best pizza in naples').engines).sort()).toEqual(['duckduckgo', 'marginalia', 'wikipedia']);
    expect(route('TypeError: cannot read properties of undefined react useEffect').engines).toMatchObject({ stackoverflow: expect.any(Number) });
    expect(route('useEffectEvent docs').engines.stackoverflow).toBeDefined();
    expect(route('diffusion transformer paper 2026').engines.arxiv).toBeDefined();
    expect(route('open source alternative to notion').engines.github).toBeDefined();
    expect(route('show hn launch week').engines.hackernews).toBeDefined();
    expect(route('python package for pdf parsing').engines).toMatchObject({ pypi: expect.any(Number) });
    expect(route('npm package date formatting').engines.npm).toBeDefined();
    expect(route('who was ada lovelace').engines.wikipedia).toBeGreaterThan(1);
  });
});

describe('the sources\' own answers', () => {
  it('tells DuckDuckGo\'s bot check from results', () => {
    expect(isDdgChallenge(202, '')).toBe(true);
    expect(isDdgChallenge(200, '<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>')).toBe(true);
    expect(isDdgChallenge(200, DDG_HTML)).toBe(false);
  });

  it('gives each DuckDuckGo result its own snippet when an ad comes first', () => {
    const html = `<div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Buy now</a>
      <a class="result__snippet">Great deals on everything.</a></div>
      <div class="result"><a class="result__a" href="https://docs.example/">The docs</a><a class="result__snippet">How it works.</a></div>
      <div class="result"><a class="result__a" href="https://other.example/">No snippet here</a></div>`;
    expect(parseDdgAnchors(html, 'result__a', 'result__snippet')).toEqual([
      { title: 'The docs', url: 'https://docs.example/', snippet: 'How it works.' },
      { title: 'No snippet here', url: 'https://other.example/', snippet: '' },
    ]);
  });

  it('reads arXiv\'s feed, and finds likely PyPI names in a query', () => {
    const feed = `<feed><entry><id>http://arxiv.org/abs/2601.00001v1</id><published>2026-01-02T00:00:00Z</published>
      <title>Attention
        Is Still All You Need</title><summary> A study &amp; a proof. </summary>
      <author><name>A. Author</name></author><author><name>B. Author</name></author></entry></feed>`;
    expect(parseArxiv(feed)).toEqual([{ title: 'Attention Is Still All You Need', url: 'http://arxiv.org/abs/2601.00001v1', summary: 'A study & a proof.', published: '2026-01-02', authors: ['A. Author', 'B. Author'] }]);
    expect(pypiCandidates('pip install pdfplumber for python')).toEqual(['pdfplumber']);
  });
});

/** Every source, answering as it would; `over` replaces one. */
function sources(over: Record<string, (url: string) => Response | Promise<Response>> = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    calls.push(url);
    const host = new URL(url).hostname;
    if (over[host]) return over[host]!(url);
    if (host === 'html.duckduckgo.com') return reply(DDG_HTML);
    if (host === 'lite.duckduckgo.com') return reply('<table></table>');
    if (host === 'api.marginalia.nu') return reply({ results: [{ url: 'https://small.example/', title: 'Small web', description: 'A small site.' }] });
    if (host === 'en.wikipedia.org') return reply({ pages: [{ key: 'Guide_(book)', title: 'Guide (book)', excerpt: 'A <span class="searchmatch">guide</span>', description: 'book' }] });
    if (host === 'api.stackexchange.com') return reply({ items: [{ title: 'How do I &quot;guide&quot;?', link: 'https://stackoverflow.com/q/1', score: 5, is_answered: true, answer_count: 2, tags: ['js'] }] });
    return reply({}, { status: 404 });
  });
  return { fetcher, calls };
}

describe('Open Web search', () => {
  it('asks the sources at once and gives one merged list, with who found what', async () => {
    const { fetcher, calls } = sources();
    const out = await openWebSearch('guide', { maxResults: 5, fetcher, state: new OpenWebState() });
    expect(calls.map((u) => new URL(u).hostname).sort()).toEqual(['api.marginalia.nu', 'en.wikipedia.org', 'html.duckduckgo.com']);
    expect(out.reachable).toBe(true);
    expect(out.results.map((r) => r.url)).toContain('https://example.com/guide?utm_source=ddg');
    expect(out.results.map((r) => r.url)).not.toContain('https://duckduckgo.com/y.js?ad_provider=x');
    expect(out.results.find((r) => hostIs(r.url, 'en.wikipedia.org'))).toMatchObject({ title: 'Guide (book) — Wikipedia', snippet: 'book: A guide' });
  });

  it('falls back to Lite when DuckDuckGo shows its check, and rests a source that turned it away', async () => {
    const state = new OpenWebState();
    let now = 1_000_000;
    const { fetcher, calls } = sources({
      'html.duckduckgo.com': () => reply('<div class="anomaly-modal">bots use DuckDuckGo too</div>', { status: 202 }),
      'lite.duckduckgo.com': () => reply('', { status: 403 }),
    });
    const first = await openWebSearch('guide', { maxResults: 5, fetcher, state, now: () => now });
    expect(first.sources.find((s) => s.engine === 'duckduckgo')).toMatchObject({ outcome: 'blocked' });
    expect(calls.filter(ddgHost)).toHaveLength(2);
    // Others still answered: not an outage.
    expect(first.reachable).toBe(true);
    expect(first.results.length).toBeGreaterThan(0);

    calls.length = 0;
    now += 60_000;
    const second = await openWebSearch('another query', { maxResults: 5, fetcher, state, now: () => now });
    expect(second.sources.find((s) => s.engine === 'duckduckgo')).toMatchObject({ outcome: 'resting' });
    expect(calls.some(ddgHost)).toBe(false);
    // Rested for minutes, not for ever.
    now += 6 * 60_000;
    calls.length = 0;
    await openWebSearch('a third query', { maxResults: 5, fetcher, state, now: () => now });
    expect(calls.some(ddgHost)).toBe(true);
  });

  it('honours a rate limit\'s Retry-After, and keeps answers for a while', async () => {
    const state = new OpenWebState();
    let now = 5_000_000;
    const { fetcher, calls } = sources({ 'api.marginalia.nu': () => reply({}, { status: 429, headers: { 'retry-after': '3600' } }) });
    await openWebSearch('guide', { maxResults: 5, fetcher, state, now: () => now });
    expect(state.resting('marginalia', now + 59 * 60_000)).toBeTruthy();
    calls.length = 0;
    const again = await openWebSearch('  Guide ', { maxResults: 5, fetcher, state, now: () => now + 1000 });
    // Same query, moments later: from memory, no source asked.
    expect(calls).toEqual([]);
    expect(again.results.length).toBeGreaterThan(0);
  });

  it('gives up on a slow source at the deadline and uses what came back', async () => {
    const { fetcher } = sources({ 'api.marginalia.nu': (url) => new Promise((resolve) => setTimeout(() => resolve(reply({ results: [] })), 5_000)) });
    const started = Date.now();
    const out = await openWebSearch('guide', { maxResults: 5, fetcher, state: new OpenWebState(), deadlineMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.sources.find((s) => s.engine === 'marginalia')).toMatchObject({ outcome: 'too slow' });
    expect(out.results.length).toBeGreaterThan(0);
  });

  it('rests a source that keeps running out the deadline, so it stops holding searches up', async () => {
    const state = new OpenWebState();
    const hang = () => new Promise<Response>(() => {});
    const { fetcher, calls } = sources({ 'api.marginalia.nu': hang });
    for (const q of ['one', 'two']) await openWebSearch(q, { maxResults: 5, fetcher, state, deadlineMs: 50 });
    expect(state.resting('marginalia', Date.now())).toBeTruthy();
    calls.length = 0;
    const third = await openWebSearch('three', { maxResults: 5, fetcher, state, deadlineMs: 50 });
    expect(third.sources.find((x) => x.engine === 'marginalia')).toMatchObject({ outcome: 'resting' });
    expect(calls.some((u) => hostIs(u, 'api.marginalia.nu'))).toBe(false);
  });

  it('asks no source when the search was already stopped, and leaves nothing unhandled', async () => {
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    const { fetcher } = sources();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    await expect(openWebSearch('guide', { maxResults: 5, fetcher, state: new OpenWebState(), signal: stop.signal })).rejects.toThrow('stopped');
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
    expect(fetcher).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('says nothing could be reached only when nothing could', async () => {
    const out = await openWebSearch('guide', { maxResults: 5, fetcher: async () => { throw new Error('offline'); }, state: new OpenWebState() });
    expect(out).toMatchObject({ reachable: false, results: [] });
    expect(new BlockedError('x', 5).retryAfterMs).toBe(5);
  });
});

describe('web_search with no keys', () => {
  afterEach(() => vi.unstubAllEnvs());
  const noKeys = () => {
    vi.stubEnv('SEARXNG_URL', '');
    vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
  };

  it('lists the merged results and the sources asked', async () => {
    noKeys();
    const { fetcher } = sources();
    const tool = new WebSearchTool({}, { fetcher, state: new OpenWebState() });
    const out = await tool.execute({ query: 'guide' }, {} as never);
    expect(out).toContain('Web search results for: "guide"');
    expect(out).toContain('URL: https://example.com/guide?utm_source=ddg');
    expect(out).toMatch(/Found by: duckduckgo/);
    expect(out).toContain('Searched free sources (no key): ');
  });

  it('with read, opens the top results and brings back the passages that answer the query', async () => {
    noKeys();
    const { fetcher } = sources();
    const fetchPage = vi.fn(async (url: string) => hostIs(url, 'example.com')
      ? reply('<html><head><title>The Guide</title></head><body><article><h2>Basics</h2><p>Unrelated words about something else entirely, for a while.</p><h2>The guide</h2><p>This guide explains the guide in full, step by step, for everyone.</p></article></body></html>', { url })
      : hostIs(url, 'en.wikipedia.org') ? reply('', { status: 500 }) : reply('plain text with nothing of note', { type: 'text/plain', url }));
    const tool = new WebSearchTool({}, { fetcher, fetchPage, state: new OpenWebState() });
    const out = await tool.execute({ query: 'guide', read: true }, {} as never);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(out).toContain('── Read from the top results ──');
    expect(out).toContain('> [The guide] This guide explains the guide in full');
    expect(out).toContain('Could not read it: HTTP 500');
    expect(truncateForContext(out)).toBe(out);
  });
});

describe('web_fetch', () => {
  const article = `<html><head><title>Long read</title></head><body><nav>Menu</nav><main>
    ${Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i}: ${i === 250 ? 'the secret recipe uses saffron and lemon' : 'filler words that say nothing much at all here, and then some more of them to make the page long enough'}.</p>`).join('\n')}
    <p><a href="/next">Next chapter</a></p></main></body></html>`;

  it('reads the main content in parts a worker keeps whole, with the passages that answer the prompt first and the links at the end', async () => {
    const fetchPage = vi.fn(async (url: string) => reply(article, { url }));
    const tool = new WebFetchTool({ fetchPage, state: new OpenWebState() });
    const first = await tool.execute({ url: 'https://book.example/ch1', prompt: 'secret recipe saffron' }, {} as never);
    expect(first).toContain('Title: Long read');
    expect(first).not.toContain('Menu');
    expect(first.indexOf('the secret recipe uses saffron')).toBeLessThan(first.indexOf('── The page ──'));
    // Every part, read on until the end: each fits what a worker keeps (it is
    // not cut in the middle), and together they hold every paragraph.
    const seen: string[] = [];
    let answer = first;
    for (let i = 0; i < 20; i++) {
      expect(answer.length).toBeLessThanOrEqual(12_000);
      expect(truncateForContext(answer)).toBe(answer);
      seen.push(answer);
      const more = /Read on with offset: (\d+)/.exec(answer);
      if (!more) break;
      answer = await tool.execute({ url: 'https://book.example/ch1', offset: Number(more[1]) }, {} as never);
    }
    expect(seen.length).toBeGreaterThan(1);
    const all = seen.join('\n');
    for (const n of [0, 120, 250, 299]) expect(all).toContain(`Paragraph ${n}:`);
    expect(seen.at(-1)).toContain('- Next chapter: https://book.example/next');
    // From memory: the page is fetched once.
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('keeps pages apart that only look alike: /docs and /docs/ are fetched each', async () => {
    const fetchPage = vi.fn(async (url: string) => reply(`<html><head><title>${new URL(url).pathname}</title></head><body><main><p>${'words '.repeat(60)}</p></main></body></html>`, { url }));
    const state = new OpenWebState();
    const a = await fetchReadable('https://docs.example/docs', { fetchPage, state });
    const b = await fetchReadable('https://docs.example/docs/', { fetchPage, state });
    const again = await fetchReadable('https://docs.example/docs#install', { fetchPage, state });
    expect([a.title, b.title, again.title]).toEqual(['/docs', '/docs/', '/docs']);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('lists links with whole addresses: long words are shortened, an address never is', async () => {
    const longPath = `https://docs.example/${'section/'.repeat(12)}page`;
    const huge = `https://docs.example/${'x'.repeat(400)}`;
    const html = `<html><body><main><p>${'Some words of the page. '.repeat(5)}</p>
      <p><a href="${longPath}">${'A very long link label that goes on and on '.repeat(4)}</a> <a href="${huge}">huge</a></p></main></body></html>`;
    const tool = new WebFetchTool({ fetchPage: async (url) => reply(html, { url }), state: new OpenWebState() });
    const out = await tool.execute({ url: 'https://docs.example/' }, {} as never);
    const line = out.split('\n').find((l) => l.includes(longPath));
    expect(line).toBeDefined();
    expect(line!.endsWith(`: ${longPath}`)).toBe(true);
    expect(line!.length).toBeLessThan(longPath.length + 100);
    expect(out).not.toContain(huge.slice(0, 60));
    expect(out).toContain('1 more not listed, some with very long addresses');
  });

  it('says plainly what it could not read', async () => {
    const tool = new WebFetchTool({ fetchPage: async () => reply('%PDF', { type: 'application/pdf' }), state: new OpenWebState() });
    expect(await tool.execute({ url: 'https://x.example/a.pdf' }, {} as never)).toBe("Can't read https://x.example/a.pdf as text: it is application/pdf, not a page of text.");
  });

  it('goes through the SSRF guard by default', async () => {
    const tool = new WebFetchTool({ state: new OpenWebState() });
    expect(await tool.execute({ url: 'http://169.254.169.254/latest/meta-data' }, {} as never)).toMatch(/^Refused to fetch/);
    await expect(fetchReadable('http://127.0.0.1:1/', { state: new OpenWebState() })).rejects.toThrow();
  });
});
