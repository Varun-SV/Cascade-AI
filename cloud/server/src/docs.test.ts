import { describe, it, expect } from 'vitest';
import { renderDocsPage } from './docs.js';

describe('public docs page', () => {
  const html = renderDocsPage();

  it('is a self-contained HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Cascade — Documentation</title>');
    // No external fonts/scripts — safe under a strict origin.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/fonts\./i);
  });

  it('covers the core product sections', () => {
    for (const heading of ['What is Cascade', 'Providers & API keys', 'How the tiers route', 'Files & document exports', 'Privacy & your keys']) {
      expect(html).toContain(heading);
    }
    // Links back into the app on the same origin.
    expect(html).toContain('href="/"');
  });

  it('does not leak internal design-spec content', () => {
    // The repo's docs/*.md are internal; the public page must not echo their markers.
    expect(html).not.toContain('Design + security only');
    expect(html).not.toMatch(/OAUTH_REDIRECT_BASE_URL|SESSION_SECRET|GOOGLE_CLIENT_SECRET/);
  });
});
