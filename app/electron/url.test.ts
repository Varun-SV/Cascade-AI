// ─────────────────────────────────────────────
//  Cascade Desktop — Address-bar parsing
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { normalizeUrl, toNavigable } from './url.js';

describe('normalizeUrl', () => {
  it('accepts http and https', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeUrl('http://example.com')).toBe('http://example.com/');
  });

  it('assumes https for a bare host', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
  });

  it('refuses schemes that are not navigation', () => {
    // file:// would be a local-file read and javascript: a script injection,
    // both dressed up as typing an address.
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/html,<h1>hi')).toBeNull();
  });

  it('returns null for junk rather than throwing', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl('http://')).toBeNull();
  });
});

describe('toNavigable', () => {
  const isSearch = (v: string | null) => !!v?.startsWith('https://duckduckgo.com/?q=');

  it('opens localhost over HTTP instead of searching for it', () => {
    // This is a developer's browser. Searching the web for "localhost:3000" is
    // never what was meant — and neither is https, since a Vite/webpack dev
    // server speaks plain HTTP and the TLS attempt just fails.
    expect(toNavigable('localhost:3000')).toBe('http://localhost:3000/');
    expect(toNavigable('localhost')).toBe('http://localhost/');
    expect(toNavigable('localhost:8080/api/health')).toBe('http://localhost:8080/api/health');
  });

  it('opens loopback over HTTP and other hosts over HTTPS', () => {
    expect(toNavigable('127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
    expect(toNavigable('[::1]:3000')).toBe('http://[::1]:3000/');
    // A LAN address is not loopback — no reason to downgrade it.
    expect(toNavigable('192.168.1.10')).toBe('https://192.168.1.10/');
  });

  it('still honours an explicit https on localhost', () => {
    expect(toNavigable('https://localhost:8443')).toBe('https://localhost:8443/');
  });

  it('opens a bare domain carrying a query or fragment', () => {
    expect(toNavigable('example.com?q=1')).toBe('https://example.com/?q=1');
    expect(toNavigable('example.com#top')).toBe('https://example.com/#top');
    expect(toNavigable('example.com:8443/x')).toBe('https://example.com:8443/x');
  });

  it('honours an explicit scheme', () => {
    expect(toNavigable('http://example.com/x')).toBe('http://example.com/x');
  });

  it('searches for anything that is not an address', () => {
    expect(isSearch(toNavigable('how do i cancel a run'))).toBe(true);
    expect(isSearch(toNavigable('cascade'))).toBe(true);
    // A word with a colon is still a phrase, not a host.
    expect(isSearch(toNavigable('note: this'))).toBe(true);
  });

  it('searches when the input has spaces, even around a dot', () => {
    expect(isSearch(toNavigable('what is node.js'))).toBe(true);
  });

  it('returns null for nothing typed', () => {
    expect(toNavigable('')).toBeNull();
    expect(toNavigable('   ')).toBeNull();
  });
});
