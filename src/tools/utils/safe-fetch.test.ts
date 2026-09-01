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

  // The bug these pin: `isPrivateIPv6` recognised the IPv4-mapped form only
  // when written with a DOTTED tail (`::ffff:127.0.0.1`), and `new URL()`
  // canonicalises every one of these to HEX before anything sees them — so the
  // dotted check above never fired on a real URL, and the assertion covering
  // it passed only because it calls the function directly. A literal IP also
  // needs no DNS, so the connect-time guard never runs on it either: this
  // function is the only thing standing between the input and the socket.
  describe('IPv6 forms that carry an IPv4 address', () => {
    const reaches = (raw: string) => {
      const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
      return isPrivateAddress(host);
    };

    it('blocks loopback however it is spelled', () => {
      expect(reaches('http://[::ffff:127.0.0.1]/')).toBe(true);   // → ::ffff:7f00:1
      expect(reaches('http://[::ffff:7f00:1]/')).toBe(true);      // written in hex
      expect(reaches('http://[0:0:0:0:0:ffff:7f00:1]/')).toBe(true); // fully expanded
      expect(reaches('http://[::127.0.0.1]/')).toBe(true);        // IPv4-compatible
      expect(reaches('http://[::1]/')).toBe(true);
    });

    it('blocks the cloud metadata address wearing an IPv6 costume', () => {
      expect(reaches('http://[::ffff:169.254.169.254]/')).toBe(true);
    });

    it('blocks translation prefixes that embed an IPv4 address', () => {
      expect(reaches('http://[64:ff9b::7f00:1]/')).toBe(true);    // NAT64
      expect(reaches('http://[2002:7f00:1::]/')).toBe(true);      // 6to4
    });

    it('still allows genuinely public IPv6, mapped or native', () => {
      // The guard has to stay usable: over-blocking here would take out every
      // IPv6-only host, which is a silent outage rather than a security win.
      expect(reaches('http://[2606:4700:4700::1111]/')).toBe(false);
      expect(reaches('http://[2001:4860:4860::8888]/')).toBe(false);
      expect(reaches('http://[::ffff:8.8.8.8]/')).toBe(false);
    });

    it('treats an unparseable IPv6 literal as unsafe', () => {
      expect(isPrivateAddress('::ffff:127.0.0.1::1')).toBe(true); // two '::'
      expect(isPrivateAddress('gggg::1')).toBe(true);
      expect(isPrivateAddress('1:2:3:4:5:6:7:8:9')).toBe(true);
    });

    it('ignores a zone index rather than choking on it', () => {
      expect(isPrivateAddress('fe80::1%eth0')).toBe(true);
    });
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
