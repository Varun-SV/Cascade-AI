import { describe, expect, it } from 'vitest';
import { DOCS_BASE, LEGACY_HASHES, docsHref, isDocsPath, parseDocsLocation } from './route.js';
import { PAGES, SECTIONS, SLUGS } from './content/index.js';
import type { Block } from './content/types.js';

describe('docs routes', () => {
  it('knows which paths are the docs', () => {
    for (const p of ['/docs', '/docs/', '/docs/workspaces', '/docs/a/b']) expect(isDocsPath(p), p).toBe(true);
    for (const p of ['/', '/docsx', '/documents', '/api/docs', '/download']) expect(isDocsPath(p), p).toBe(false);
  });

  it('maps an address to home, a page, or a missing page', () => {
    expect(parseDocsLocation('/docs', '', SLUGS)).toEqual({ kind: 'home' });
    expect(parseDocsLocation('/docs/', '', SLUGS)).toEqual({ kind: 'home' });
    expect(parseDocsLocation('/docs/workspaces', '', SLUGS)).toEqual({ kind: 'page', slug: 'workspaces', anchor: null });
    expect(parseDocsLocation('/docs/workspaces/', 'tool-presets', SLUGS)).toEqual({ kind: 'page', slug: 'workspaces', anchor: 'tool-presets' });
    expect(parseDocsLocation('/docs/nope', '', SLUGS)).toEqual({ kind: 'missing', slug: 'nope' });
  });

  it('opens /docs#privacy on the privacy page, as the landing page links it', () => {
    expect(parseDocsLocation('/docs', 'privacy', SLUGS)).toEqual({ kind: 'page', slug: 'privacy', anchor: null });
  });

  it('sends every old section id to a page that exists', () => {
    for (const [hash, slug] of Object.entries(LEGACY_HASHES)) {
      expect(SLUGS.has(slug), `${hash} -> ${slug}`).toBe(true);
      expect(parseDocsLocation('/docs', hash, SLUGS)).toEqual({ kind: 'page', slug, anchor: null });
    }
  });

  it('leaves an unknown #hash on the docs home', () => {
    expect(parseDocsLocation('/docs', 'something-else', SLUGS)).toEqual({ kind: 'home' });
  });

  it('builds hrefs', () => {
    expect(docsHref()).toBe(DOCS_BASE);
    expect(docsHref('faq')).toBe('/docs/faq');
    expect(docsHref('faq', 'keys-and-cost')).toBe('/docs/faq#keys-and-cost');
  });
});

describe('docs content', () => {
  it('has a page for each required topic', () => {
    for (const slug of [
      'overview', 'quick-start', 'desktop-app', 'cli', 'sdk', 'openai-api',
      'providers-and-keys', 'how-tiers-route', 'thinking-levels', 'web-search', 'attachments', 'file-generation', 'images',
      'memories', 'skills', 'connectors-and-mcp', 'spend-and-budget', 'conversations-and-branches',
      'workspaces', 'browser-relay', 'checkpoints-and-undo', 'privacy-paths', 'process-jail',
      'cli-commands', 'slash-commands', 'settings-panel', 'keyboard-shortcuts', 'auto-mode',
      'config-file', 'cascadeignore', 'environment-variables', 'self-hosting', 'server-environment',
      'faq', 'troubleshooting', 'privacy', 'changelog',
    ]) expect(SLUGS.has(slug), slug).toBe(true);
  });

  it('has unique slugs, in a section that exists, with a title and a summary', () => {
    expect(new Set(PAGES.map((p) => p.slug)).size).toBe(PAGES.length);
    const sections = new Set(SECTIONS.map((s) => s.id));
    for (const p of PAGES) {
      expect(sections.has(p.section), p.slug).toBe(true);
      expect(p.title.length, p.slug).toBeGreaterThan(2);
      expect(p.summary.length, p.slug).toBeGreaterThan(10);
      expect(p.blocks.length, p.slug).toBeGreaterThan(2);
    }
  });

  it('gives every heading an id that is unique on its page', () => {
    for (const p of PAGES) {
      const ids = p.blocks.flatMap((b) => (b.t === 'h2' || b.t === 'h3' ? [b.id] : []));
      expect(new Set(ids).size, p.slug).toBe(ids.length);
      for (const id of ids) expect(id, p.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('only links to docs pages and sections that exist', () => {
    const anchors = new Map(PAGES.map((p) => [p.slug, new Set(p.blocks.flatMap((b) => (b.t === 'h2' || b.t === 'h3' ? [b.id] : [])))]));
    const texts = (b: Block): string[] => {
      switch (b.t) {
        case 'p': case 'h2': case 'h3': return [b.text];
        case 'ul': case 'ol': return b.items;
        case 'callout': return [b.text];
        case 'table': return [...b.head, ...b.rows.flat()];
        default: return [];
      }
    };
    let seen = 0;
    for (const p of PAGES) {
      for (const t of p.blocks.flatMap(texts)) {
        for (const m of t.matchAll(/\]\((\/docs[^)\s]*)\)/g)) {
          seen++;
          const [path, anchor] = m[1]!.split('#');
          const slug = path!.replace(/^\/docs\/?/, '');
          if (!slug) continue;
          expect(SLUGS.has(slug), `${p.slug} links to ${m[1]}`).toBe(true);
          if (anchor) expect(anchors.get(slug)!.has(anchor), `${p.slug} links to ${m[1]}`).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(40);
  });

  it('does not leak a secret-looking value', () => {
    const all = JSON.stringify(PAGES);
    expect(all).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(all).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
  });
});
