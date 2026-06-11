import { describe, it, expect, afterEach } from 'vitest';
import { assertPublicUrl, isPrivateAddress, SsrfBlockedError } from './safe-fetch.js';

afterEach(() => {
  delete process.env['CASCADE_ALLOW_LOCAL_FETCH'];
});

describe('isPrivateAddress', () => {
  it('flags loopback, link-local, and RFC-1918 ranges', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateAddress('10.0.0.5')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true); // IPv4-mapped loopback
  });

  it('allows public addresses', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
  });

  it('treats non-IP strings as unsafe', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(SsrfBlockedError);
    await expect(assertPublicUrl('ftp://example.com')).rejects.toThrow(/scheme/i);
  });

  it('rejects loopback and metadata hosts by literal IP', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(SsrfBlockedError);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(SsrfBlockedError);
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects localhost-style hostnames', async () => {
    await expect(assertPublicUrl('http://localhost:8080/')).rejects.toThrow(/local/i);
    await expect(assertPublicUrl('http://api.local/')).rejects.toThrow(/local/i);
  });

  it('honors the CASCADE_ALLOW_LOCAL_FETCH opt-out', async () => {
    process.env['CASCADE_ALLOW_LOCAL_FETCH'] = '1';
    await expect(assertPublicUrl('http://127.0.0.1/')).resolves.toBeInstanceOf(URL);
  });
});
