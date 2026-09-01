import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseDdgAnchors, unwrapDdgRedirect, WebSearchTool } from './web-search.js';

describe('unwrapDdgRedirect', () => {
  it('unwraps a protocol-relative uddg redirect to the real destination', () => {
    const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%2Fpage%3Fa%3D1&rut=abc123';
    expect(unwrapDdgRedirect(href)).toBe('https://example.com/docs/page?a=1');
  });

  it('leaves a direct https URL untouched', () => {
    expect(unwrapDdgRedirect('https://example.com/x')).toBe('https://example.com/x');
  });

  it('tolerates malformed hrefs', () => {
    expect(unwrapDdgRedirect('not a url')).toBe('https://duckduckgo.com/not%20a%20url');
  });
});

describe('parseDdgAnchors', () => {
  it('parses DDG Lite markup with SINGLE-quoted attributes (the real-world case the old regex missed)', () => {
    const html = `
      <table>
        <tr><td><a rel='nofollow' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.dev%2F&rut=x' class='result-link'>Foo docs</a></td></tr>
        <tr><td class='result-snippet'>The <b>Foo</b> documentation site.</td></tr>
        <tr><td><a rel='nofollow' href='https://bar.io/guide' class='result-link'>Bar guide</a></td></tr>
        <tr><td class='result-snippet'>A guide to Bar.</td></tr>
      </table>`;
    const results = parseDdgAnchors(html, 'result-link', 'result-snippet');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'Foo docs', url: 'https://foo.dev/', snippet: 'The Foo documentation site.' });
    expect(results[1]).toMatchObject({ title: 'Bar guide', url: 'https://bar.io/guide' });
  });

  it('parses double-quoted attributes and any attribute order', () => {
    const html = `<a class="result-link" href="https://baz.org">Baz &amp; friends</a>`;
    const results = parseDdgAnchors(html, 'result-link', 'result-snippet');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'Baz & friends', url: 'https://baz.org/' });
  });

  it('parses the html.duckduckgo.com result__a variant with nested markup in titles', () => {
    const html = `
      <div class="result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fqux.net%2Fdocs">Qux <b>reference</b></a>
        <a class="result__snippet" href="/x">Snippet text here.</a>
      </div>`;
    const results = parseDdgAnchors(html, 'result__a', 'result__snippet');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'Qux reference', url: 'https://qux.net/docs', snippet: 'Snippet text here.' });
  });

  it('returns [] for an anomaly/captcha page with no result anchors', () => {
    expect(parseDdgAnchors('<html><body>Unfortunately, bots are not allowed.</body></html>', 'result-link', 'result-snippet')).toEqual([]);
  });
});

describe('WebSearchTool — SearXNG URL trust', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Where the URL came from decides whether it gets guarded. On a CLI run it is
  // the machine owner's own config and a self-hosted SearXNG is routinely on
  // localhost — guarding there would break the backend this tool documents as
  // its preferred one. On the hosted server the same field arrives in a request
  // body, which makes it caller-controlled input aimed at a fetch the server
  // performs.

  it('guards the URL when the host says it is untrusted — the fetch never happens', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const tool = new WebSearchTool({ searxngUrl: 'http://169.254.169.254/', guardSearxngUrl: true });

    await expect(tool.execute({ query: 'x' }, {} as never)).rejects.toMatchObject({
      message: expect.stringContaining('non-public address'),
    });
    // The point is not that it errored — it is that nothing was ever sent. A
    // guard that fails after the request has left is not a guard. (The DDG
    // fallbacks run next and DO call fetch, so assert on the SearXNG URL
    // specifically rather than on the call count.)
    for (const [url] of fetchSpy.mock.calls) {
      expect(String(url)).not.toContain('169.254.169.254');
    }
  });

  it('does NOT guard by default, so a self-hosted SearXNG on localhost still works', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [{ title: 'T', url: 'https://e.example', content: 'c' }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const tool = new WebSearchTool({ searxngUrl: 'http://localhost:8080' });

    const out = await tool.execute({ query: 'x' }, {} as never);
    expect(out).toContain('https://e.example');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('localhost:8080');
  });

  it('leaves the flag off unless the host sets it — the default must not be the guarded one', () => {
    // Off-by-default is what keeps every existing CLI and desktop install
    // working; a host that accepts remote input is the party that knows it did.
    // An env var deliberately cannot set this: it says nothing about where the
    // URL came from.
    vi.stubEnv('SEARXNG_URL', 'http://localhost:8080');
    expect(new WebSearchTool({})['config'].guardSearxngUrl).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe('WebSearchTool.execute — all backends down', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a systemic error instead of returning a "failed" string as if it were a result', () => {
    // Regression: this used to `return` the failure text, which the agent
    // loop treats as an ordinary successful tool result — the worker gets no
    // signal that it has zero real search grounding and is free to produce a
    // plausible but ungrounded (and, in one real run, completely off-topic)
    // answer instead of stopping. `systemic: true` is what t3-worker's
    // executeTool now checks to escalate instead of silently continuing.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));
    const tool = new WebSearchTool({}); // no configured backends → only the two DDG attempts run
    return expect(tool.execute({ query: 'zoom for humans' }, {} as never)).rejects.toMatchObject({
      systemic: true,
      message: expect.stringContaining('found nothing across all backends'),
    });
  });

  it('does NOT tag it systemic when a backend was reachable but simply found nothing', async () => {
    // Regression: the all-backends branch is reached both when every backend
    // errors AND when every backend responds successfully with zero
    // results — a narrow or misspelled query, not a systemic outage. Tagging
    // BOTH systemic escalated the whole worker instead of letting it recover
    // (retry a different query, or report nothing was found).
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body>no results</body></html>'),
    }));
    const tool = new WebSearchTool({});
    await expect(tool.execute({ query: 'a query with no matches' }, {} as never)).rejects.toMatchObject({
      systemic: false,
      message: expect.stringContaining('found nothing across all backends'),
    });
  });
});
