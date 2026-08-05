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
  it('renders the cascade spine so /docs matches the landing page', () => {
    // The two public surfaces used to be styled independently and drifted. Both
    // now hang their content off one tier-coloured line.
    expect(html).toContain('main::before');
    expect(html).toContain('section::before');
    expect(html).toContain('linear-gradient(to bottom,var(--azure),var(--sky),var(--teal))');
  });

  it('stays readable on a phone and respects reduced motion', () => {
    expect(html).toContain('@media(max-width:760px)');
    expect(html).toContain('@media(prefers-reduced-motion:reduce)');
  });

  it('uses the SAME tier colours as the landing page', async () => {
    // docs.ts cannot import from cloud/web (separate package, rootDir: src), so
    // it carries its own copy of the ramp. This is the guard that keeps the two
    // copies honest: read the web module and compare the actual hex values.
    // Without it, "unified branding" lasts exactly until someone edits one side.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const here = path.dirname(fileURLToPath(import.meta.url));
    const brandPath = path.resolve(here, '../../web/src/lib/brand.ts');
    const brand = await readFile(brandPath, 'utf-8');

    const hexOf = (name: string) => brand.match(new RegExp(`export const ${name} = '(#[0-9A-Fa-f]{6})'`))?.[1];
    const azure = hexOf('AZURE');
    const sky = hexOf('SKY');
    const teal = hexOf('TEAL');

    expect(azure, 'brand.ts should export AZURE').toBeTruthy();
    expect(html).toContain(`--azure:${azure}`);
    expect(html).toContain(`--sky:${sky}`);
    expect(html).toContain(`--teal:${teal}`);
  });
});
