import { describe, it, expect } from 'vitest';
import { parseDdgAnchors, unwrapDdgRedirect } from './web-search.js';

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
