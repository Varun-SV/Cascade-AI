import { describe, it, expect, afterEach, vi } from 'vitest';
import { assertPublicUrl, isPrivateAddress, safeFetch, SsrfBlockedError } from './safe-fetch.js';

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
      expect(reaches('http://[64:ff9b::7f00:1]/')).toBe(true);    // NAT64 /96
      expect(reaches('http://[2002:7f00:1::]/')).toBe(true);      // 6to4
    });

    // RFC 6052 §2.2 puts the IPv4 address in a DIFFERENT place for the /48
    // local-use prefix than for the well-known /96: split across bits 48-63
    // and 72-87, stepping over the u-octet at 64-71. Reading the last 32 bits
    // for a /48 address yields 0.0.0.0, which is "private" — so treating both
    // alike let nothing through, it blocked every IPv4-only destination on a
    // /48 DNS64 deployment. Fail-closed, but still an outage.
    describe('NAT64 64:ff9b:1::/48 (RFC 8215)', () => {
      it('decodes the /48 layout instead of reading the wrong groups', () => {
        // 8.8.8.8 encoded under the /48 prefix — must stay REACHABLE.
        expect(isPrivateAddress('64:ff9b:1:808:8:800::')).toBe(false);
      });

      it('still blocks a private address encoded the same way', () => {
        // 127.0.0.1 → bits 48-63 = 7f00, bits 72-87 = 0001.
        expect(isPrivateAddress('64:ff9b:1:7f00:0:100::')).toBe(true);
        // 169.254.169.254 → a9fe / a9fe.
        expect(isPrivateAddress('64:ff9b:1:a9fe:0:a9fe::')).toBe(true);
      });

      it('blocks a 64:ff9b prefix whose layout it cannot decode', () => {
        // No standard defines this shape. It is a translator address by
        // construction, so it reaches some IPv4 host; refusing to guess which
        // is the only safe answer.
        expect(isPrivateAddress('64:ff9b:2:7f00:1::')).toBe(true);
      });
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

// `safeFetch` itself had no coverage: every assertion above exercises the
// pre-flight checks, and none of them reached the function that does the
// fetching. That matters most for the dispatcher. `ssrfAgent`'s own doc
// comment is explicit that it — not `assertPublicUrl` — is what closes the
// DNS-rebinding gap, because it validates the address inside the lookup the
// socket actually uses. All of that protection rests on one option reaching
// `fetch`, and that option is passed through a cast, so the type checker
// cannot vouch for it. Drop `dispatcher` from the call and every test above
// still passes while the connect-time re-check silently stops running.
describe('safeFetch', () => {
  // A literal public IP: `assertPublicUrl` takes the `net.isIP` branch, so no
  // DNS lookup happens and these tests touch no network.
  const PUBLIC = 'http://93.184.216.34/thing';
  const OTHER_PUBLIC = 'http://93.184.216.35/elsewhere';

  type FetchInit = RequestInit & { dispatcher?: { dispatch?: unknown } };
  const calls = (spy: ReturnType<typeof vi.fn>): FetchInit[] =>
    spy.mock.calls.map((c) => c[1] as FetchInit);

  const stubFetch = (...responses: Response[]) => {
    let i = 0;
    const spy = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!);
    vi.stubGlobal('fetch', spy);
    return spy;
  };

  const redirectTo = (location: string) =>
    new Response(null, { status: 302, headers: { location } });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pins the connection to the SSRF agent', async () => {
    const spy = stubFetch(new Response('ok', { status: 200 }));
    await safeFetch(PUBLIC);
    const [init] = calls(spy);
    expect(init?.dispatcher).toBeDefined();
    expect(typeof init?.dispatcher?.dispatch).toBe('function');
  });

  it('asks for manual redirects, so the loop and not fetch decides each hop', async () => {
    const spy = stubFetch(new Response('ok', { status: 200 }));
    await safeFetch(PUBLIC);
    expect(calls(spy)[0]?.redirect).toBe('manual');
  });

  it('keeps the caller\'s own init alongside what it adds', async () => {
    const spy = stubFetch(new Response('ok', { status: 200 }));
    await safeFetch(PUBLIC, { method: 'POST', headers: { 'x-trace': 'abc' } });
    const [init] = calls(spy);
    expect(init?.method).toBe('POST');
    // Normalised into a Headers instance now, because the redirect loop has to
    // be able to delete from it per hop.
    expect(init?.headers instanceof Headers).toBe(true);
    expect((init?.headers as Headers).get('x-trace')).toBe('abc');
    // …and still pins the connection while doing it.
    expect(init?.dispatcher).toBeDefined();
  });

  it('returns a non-redirect response without a second request', async () => {
    const spy = stubFetch(new Response('body', { status: 200 }));
    const resp = await safeFetch(PUBLIC);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('body');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('pins every hop, not just the first', async () => {
    const spy = stubFetch(redirectTo(OTHER_PUBLIC), new Response('ok', { status: 200 }));
    await safeFetch(PUBLIC);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const init of calls(spy)) expect(init.dispatcher).toBeDefined();
  });

  // Assert on the MESSAGE, not just the class. Deleting the hop re-validation
  // leaves this rejecting anyway — the loop just follows the metadata redirect
  // until it runs out of hops and throws "Too many redirects", which is also an
  // SsrfBlockedError. Naming the address is what separates "we refused this
  // hop" from "we gave up after chasing it five times".
  it('re-validates each hop and blocks a redirect to a private address', async () => {
    const spy = stubFetch(redirectTo('http://169.254.169.254/latest/meta-data/'));
    await expect(safeFetch(PUBLIC)).rejects.toThrow(/169\.254\.169\.254/);
    // Refused before the second request, not after chasing it.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative Location against the current URL', async () => {
    const spy = stubFetch(redirectTo('/moved'), new Response('ok', { status: 200 }));
    await safeFetch(PUBLIC);
    expect(spy.mock.calls[1]?.[0]).toBe('http://93.184.216.34/moved');
  });

  it('returns the redirect itself when it carries no Location', async () => {
    const spy = stubFetch(new Response(null, { status: 302 }));
    const resp = await safeFetch(PUBLIC);
    expect(resp.status).toBe(302);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Choosing `redirect: 'manual'` takes the redirect rules away from `fetch`
  // and makes them this loop's job. It used to rebuild every hop from the
  // caller's original `init`, which kept the caller's credentials and the
  // original method all the way down the chain — so a redirect chosen by the
  // FIRST host decided who received the SECOND host's copy of the caller's
  // bearer token. `bridgeFetch` (src/tools/tool-creator.ts) routes
  // model-authored tool headers straight through here, so "the caller" can be
  // a generated tool holding a real key.
  describe('what a redirect may carry', () => {
    const hdr = (init: FetchInit | undefined, name: string): string | null =>
      init?.headers instanceof Headers ? init.headers.get(name) : null;

    it('drops the caller credentials when the redirect leaves the origin', async () => {
      const spy = stubFetch(redirectTo(OTHER_PUBLIC), new Response('ok', { status: 200 }));
      await safeFetch(PUBLIC, {
        headers: { authorization: 'Bearer sk-secret', cookie: 'session=abc', 'x-trace': 'keep-me' },
      });
      const [first, second] = calls(spy);
      expect(hdr(first, 'authorization'), 'sent to the host it was meant for').toBe('Bearer sk-secret');
      expect(hdr(second, 'authorization'), 'and NOT to the one it was redirected to').toBeNull();
      expect(hdr(second, 'cookie'), 'nor the cookie').toBeNull();
      expect(hdr(second, 'x-trace'), 'an ordinary header is not a credential').toBe('keep-me');
    });

    it('keeps them on a same-origin redirect, which is the whole point of the distinction', async () => {
      const spy = stubFetch(redirectTo('/moved'), new Response('ok', { status: 200 }));
      await safeFetch(PUBLIC, { headers: { authorization: 'Bearer sk-secret' } });
      expect(hdr(calls(spy)[1], 'authorization')).toBe('Bearer sk-secret');
    });

    it('does not hand them back if the chain returns to the first origin', async () => {
      // Stricter than the standard, and the strictness costs a legitimate
      // caller nothing: once a third party has been told where to send you,
      // the token it could have captured is already spent.
      const spy = stubFetch(redirectTo(OTHER_PUBLIC), redirectTo(PUBLIC), new Response('ok', { status: 200 }));
      await safeFetch(PUBLIC, { headers: { authorization: 'Bearer sk-secret' } });
      expect(hdr(calls(spy)[2], 'authorization')).toBeNull();
    });

    it('rewrites POST to GET on a 302 and leaves the body behind', async () => {
      const spy = stubFetch(redirectTo(OTHER_PUBLIC), new Response('ok', { status: 200 }));
      await safeFetch(PUBLIC, {
        method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' },
      });
      const [first, second] = calls(spy);
      expect(first?.method).toBe('POST');
      expect(second?.method, 'a 302 on a POST becomes a GET').toBe('GET');
      expect(second?.body, 'and the body does not follow').toBeUndefined();
      expect(hdr(second, 'content-type'), 'nor the header describing it').toBeNull();
    });

    it('rewrites to GET on a 303 whatever the method was', async () => {
      const spy = stubFetch(
        new Response(null, { status: 303, headers: { location: OTHER_PUBLIC } }),
        new Response('ok', { status: 200 }),
      );
      await safeFetch(PUBLIC, { method: 'PUT', body: 'payload' });
      const second = calls(spy)[1];
      expect(second?.method).toBe('GET');
      expect(second?.body).toBeUndefined();
    });

    it('leaves a HEAD as a HEAD through a 303', async () => {
      // 303 means "GET the other thing" for a request that was asking for
      // something else. A HEAD is already asking for metadata, and promoting
      // it to GET downloads a body the caller deliberately did not want —
      // which for a model-authored probe could be very large.
      const spy = stubFetch(
        new Response(null, { status: 303, headers: { location: OTHER_PUBLIC } }),
        new Response('ok', { status: 200 }),
      );
      await safeFetch(PUBLIC, { method: 'HEAD' });
      expect(calls(spy)[1]?.method).toBe('HEAD');
    });

    it('leaves a GET as a GET through a 303', async () => {
      const spy = stubFetch(
        new Response(null, { status: 303, headers: { location: OTHER_PUBLIC } }),
        new Response('ok', { status: 200 }),
      );
      await safeFetch(PUBLIC, { method: 'GET' });
      expect(calls(spy)[1]?.method).toBe('GET');
    });

    it('preserves the method and body on a 307, which is what 307 means', async () => {
      const spy = stubFetch(
        new Response(null, { status: 307, headers: { location: OTHER_PUBLIC } }),
        new Response('ok', { status: 200 }),
      );
      await safeFetch(PUBLIC, { method: 'POST', body: '{"a":1}' });
      const second = calls(spy)[1];
      expect(second?.method).toBe('POST');
      expect(second?.body).toBe('{"a":1}');
      // Still cross-origin, so credentials would still have been dropped.
    });

    it('preserves them on a 308 too', async () => {
      const spy = stubFetch(
        new Response(null, { status: 308, headers: { location: OTHER_PUBLIC } }),
        new Response('ok', { status: 200 }),
      );
      await safeFetch(PUBLIC, { method: 'PATCH', body: 'diff' });
      const second = calls(spy)[1];
      expect(second?.method).toBe('PATCH');
      expect(second?.body).toBe('diff');
    });
  });

  it('gives up rather than following a redirect loop forever', async () => {
    const spy = stubFetch(redirectTo(PUBLIC));
    await expect(safeFetch(PUBLIC)).rejects.toThrow(/too many redirects/i);
    // MAX_REDIRECTS is 5, and the loop runs for i = 0..5 inclusive.
    expect(spy).toHaveBeenCalledTimes(6);
  });
});
