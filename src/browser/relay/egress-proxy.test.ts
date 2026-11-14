import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type EgressProxy, startEgressProxy } from './egress-proxy.js';
import { makeConsent } from './egress-rules.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the proxy\'s three phases', () => {
  let proxy: EgressProxy;
  let site: net.Server;
  let received = 0;
  const conns: Socket[] = [];
  const dials: string[] = [];

  const start = async (resolve: () => Promise<string[]> = async () => ['203.0.113.1']): Promise<void> => {
    site = net.createServer((s) => { s.on('data', (d) => { received += d.length; }); s.on('error', () => {}); });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const port = (site.address() as AddressInfo).port;
    proxy = await startEgressProxy({
      consent: makeConsent(['http://a.test']),
      network: { resolve, dial: (address) => { dials.push(address); return net.connect(port, '127.0.0.1'); } },
    });
  };
  /** A CONNECT, and the proxy's first answer. */
  const tunnel = (): Promise<{ s: Socket; answer: string; closed: () => boolean }> => new Promise((resolve) => {
    const s = net.connect(proxy.port, '127.0.0.1');
    conns.push(s);
    let closed = false;
    s.on('error', () => {});
    s.on('close', () => { closed = true; });
    s.once('data', (d) => resolve({ s, answer: String(d), closed: () => closed }));
    s.write('CONNECT a.test:443 HTTP/1.1\r\nHost: a.test\r\n\r\n');
  });

  afterEach(async () => {
    for (const s of conns.splice(0)) s.destroy();
    dials.length = 0;
    received = 0;
    await proxy.close();
    site.close();
  });

  it('refuses before it is open, lets through once it is', async () => {
    await start();
    expect((await tunnel()).answer).toMatch(/403/);
    expect(proxy.decisions.at(-1)?.reason).toBe('no policy is on yet');
    expect(dials).toEqual([]);
    proxy.open();
    expect((await tunnel()).answer).toMatch(/200/);
    expect(dials).toEqual(['203.0.113.1']);
  });

  it('shut cuts a connection already through, so nothing more reaches the destination', async () => {
    await start();
    proxy.open();
    const t = await tunnel();
    t.s.write('before');
    await sleep(50);
    expect(received, 'control').toBe(6);
    proxy.shut();
    await sleep(50);
    expect(t.closed()).toBe(true);
    expect(received).toBe(6);
  });

  it('shut refuses everything from then on, and opening again does nothing', async () => {
    await start();
    proxy.open();
    proxy.shut();
    proxy.open();
    expect((await tunnel()).answer).toMatch(/403/);
    expect(proxy.decisions.at(-1)?.reason).toBe('the lease is over');
    expect(dials).toEqual([]);
  });

  it('a lookup still running when the proxy shuts dials nothing', async () => {
    let answer!: (a: string[]) => void;
    await start(() => new Promise((r) => { answer = r; }));
    proxy.open();
    void tunnel(); // Shutting cuts it mid-lookup, so it never gets an answer.
    await sleep(50);
    proxy.shut();
    answer(['203.0.113.1']);
    await sleep(50);
    expect(proxy.decisions.at(-1)?.reason).toBe('the lease is over');
    expect(dials).toEqual([]);
  });

  describe('plain http on its way upstream', () => {
    let upstreamOpen = 0;
    let upstreamSeen = 0;
    let echo: net.Server;
    let onUpstream: (s: Socket) => void = () => {};

    /** A destination that counts bytes and connections, and leaves the answering to each test. */
    const startHttp = async (opts: { resolve?: () => Promise<string[]>; afterDial?: () => void } = {}): Promise<void> => {
      upstreamOpen = 0;
      upstreamSeen = 0;
      echo = net.createServer((s) => {
        upstreamOpen += 1;
        upstreamSeen += 1;
        s.on('data', (d) => { received += d.length; });
        s.on('error', () => {});
        s.on('close', () => { upstreamOpen -= 1; });
        onUpstream(s);
      });
      await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
      const port = (echo.address() as AddressInfo).port;
      proxy = await startEgressProxy({
        consent: makeConsent(['http://a.test']),
        network: {
          resolve: opts.resolve ?? (async () => ['203.0.113.1']),
          dial: (address) => {
            dials.push(address);
            opts.afterDial?.();
            return net.connect(port, '127.0.0.1');
          },
        },
      });
      proxy.open();
      site = echo;
    };
    /** An http request to the proxy, with its bytes left to the test. */
    const client = (): { s: Socket; bytes: () => number; text: () => string; closed: () => boolean } => {
      const s = net.connect(proxy.port, '127.0.0.1');
      conns.push(s);
      let text = '';
      let closed = false;
      s.on('data', (d) => { text += String(d); });
      s.on('error', () => {});
      s.on('close', () => { closed = true; });
      return { s, bytes: () => text.length, text: () => text, closed: () => closed };
    };
    const UPLOAD = 'POST http://a.test/up HTTP/1.1\r\nHost: a.test\r\nContent-Length: 1000000\r\n\r\n';
    const GET = 'GET http://a.test/ HTTP/1.1\r\nHost: a.test\r\nConnection: keep-alive\r\n\r\n';

    afterEach(() => { onUpstream = () => {}; });

    it('shut mid-upload: nothing more arrives, and the upstream connection goes', async () => {
      await startHttp();
      const c = client();
      c.s.write(UPLOAD);
      c.s.write('x'.repeat(100));
      await sleep(50);
      expect(upstreamOpen, 'control: the upload reached the destination').toBe(1);
      const before = received;
      expect(before, 'control').toBeGreaterThanOrEqual(100);
      proxy.shut();
      if (!c.s.destroyed) c.s.write('y'.repeat(100));
      await sleep(50);
      expect(received).toBe(before);
      expect(upstreamOpen).toBe(0);
    });

    it('shut mid-response: the upstream connection goes, and the browser gets no more', async () => {
      let up!: Socket;
      onUpstream = (s) => { up = s; };
      await startHttp();
      const c = client();
      c.s.write(GET);
      await sleep(50);
      up.write('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nfirst');
      await sleep(50);
      expect(c.text(), 'control: the response was on its way').toMatch(/first/);
      proxy.shut();
      await sleep(50);
      expect(upstreamOpen).toBe(0);
      expect(c.closed()).toBe(true);
    });

    it('shut before the destination answers: the upstream connection goes', async () => {
      await startHttp();
      const c = client();
      c.s.write(GET);
      await sleep(50);
      expect(upstreamOpen, 'control').toBe(1);
      proxy.shut();
      await sleep(50);
      expect(upstreamOpen).toBe(0);
    });

    it('a lookup still running when the proxy shuts dials nothing', async () => {
      let answer!: (a: string[]) => void;
      await startHttp({ resolve: () => new Promise((r) => { answer = r; }) });
      const c = client();
      c.s.write(GET);
      await sleep(50);
      proxy.shut();
      answer(['203.0.113.1']);
      await sleep(50);
      expect(proxy.decisions.at(-1)?.reason).toBe('the lease is over');
      expect(dials).toEqual([]);
      expect(upstreamSeen).toBe(0);
    });

    it('shut while the connection is being made: no byte arrives, and nothing stays open', async () => {
      // Runs before any I/O, so the connection can't be up yet and the request is still queued.
      await startHttp({ afterDial: () => process.nextTick(() => proxy.shut()) });
      const c = client();
      c.s.write(UPLOAD);
      c.s.write('x'.repeat(100));
      await sleep(100);
      expect(dials, 'control: it did get as far as the dial').toEqual(['203.0.113.1']);
      expect(received).toBe(0);
      expect(upstreamOpen).toBe(0);
    });

    it('close is a shut too: a lookup still running dials nothing', async () => {
      let answer!: (a: string[]) => void;
      await startHttp({ resolve: () => new Promise((r) => { answer = r; }) });
      const c = client();
      c.s.write('CONNECT a.test:443 HTTP/1.1\r\nHost: a.test\r\n\r\n');
      await sleep(50);
      await proxy.close();
      answer(['203.0.113.1']);
      await sleep(50);
      expect(dials).toEqual([]);
    });

    it('the browser hanging up during the lookup dials nothing', async () => {
      let answer!: (a: string[]) => void;
      await startHttp({ resolve: () => new Promise((r) => { answer = r; }) });
      const c = client();
      c.s.write(GET);
      await sleep(50);
      c.s.destroy();
      await sleep(50);
      answer(['203.0.113.1']);
      await sleep(50);
      expect(dials).toEqual([]);
    });

    it('the browser hanging up during a CONNECT\'s lookup leaves no upstream connection', async () => {
      // A paused CONNECT socket can't see the hang-up until it's read, so this can dial.
      let answer!: (a: string[]) => void;
      await startHttp({ resolve: () => new Promise((r) => { answer = r; }) });
      const c = client();
      c.s.write('CONNECT a.test:443 HTTP/1.1\r\nHost: a.test\r\n\r\n');
      await sleep(50);
      c.s.destroy();
      await sleep(50);
      answer(['203.0.113.1']);
      await sleep(100);
      expect(received).toBe(0);
      expect(upstreamOpen).toBe(0);
    });

    it('the browser hanging up mid-upload ends the upstream connection, with no shut', async () => {
      await startHttp();
      const c = client();
      c.s.write(UPLOAD);
      await sleep(50);
      expect(upstreamOpen, 'control').toBe(1);
      c.s.destroy();
      await sleep(50);
      expect(upstreamOpen).toBe(0);
    });

    it('the destination dropping mid-response ends the browser\'s request too', async () => {
      let up!: Socket;
      onUpstream = (s) => { up = s; };
      await startHttp();
      const c = client();
      c.s.write(GET);
      await sleep(50);
      up.write('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nfirst');
      await sleep(50);
      expect(c.closed(), 'control').toBe(false);
      up.destroy();
      await sleep(50);
      expect(c.closed()).toBe(true);
    });

    it('a finished request leaves no upstream connection, whatever the browser asked for', async () => {
      onUpstream = (s) => { s.once('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); };
      await startHttp();
      const c = client();
      c.s.write(GET);
      await sleep(50);
      expect(c.text()).toMatch(/200 OK[\s\S]*ok$/);
      expect(upstreamOpen).toBe(0);
    });

    // Any public server a consented page fetches from can send these. Each must end only
    // its own exchange: vitest fails the run on an uncaught error, and the next request
    // shows the proxy still serving.
    const replies: [string, string][] = [
      ['a status Node won\'t write (099)', 'HTTP/1.1 099 x\r\nContent-Length: 0\r\n\r\n'],
      ['a status of 000', 'HTTP/1.1 000 x\r\nContent-Length: 0\r\n\r\n'],
      ['more body bytes than declared', 'HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nABCDEFGH'],
    ];
    for (const [name, reply] of replies) {
      it(`a destination sending ${name} ends that exchange, not the proxy`, async () => {
        let first = true;
        onUpstream = (s) => {
          s.once('data', () => {
            s.write(first ? reply : 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
            first = false;
          });
        };
        await startHttp();
        const bad = client();
        bad.s.write(GET);
        await sleep(100);
        expect(bad.closed()).toBe(true);
        expect(bad.text()).not.toMatch(/ABCDEFGH/);
        const next = client();
        next.s.write(GET);
        await sleep(100);
        expect(next.text()).toMatch(/200 OK[\s\S]*ok$/);
      });
    }

    it('a CONNECT to a port above 65535 is refused, and dials nothing', async () => {
      await startHttp();
      const c = client();
      c.s.write('CONNECT a.test:70000 HTTP/1.1\r\nHost: a.test:70000\r\n\r\n');
      await sleep(50);
      expect(c.text()).toMatch(/^HTTP\/1\.1 403/);
      expect(dials).toEqual([]);
    });
  });
});

describe('what a confirmed private origin lets through the proxy', () => {
  let proxy: EgressProxy;
  let site: net.Server;
  let accepted = 0;
  let received = 0;
  const dials: string[] = [];
  const conns: Socket[] = [];

  /** A proxy whose every dial lands on one counting destination, whatever address it names. */
  const start = async (privateOrigins: string[]): Promise<void> => {
    accepted = 0;
    received = 0;
    site = net.createServer((s) => {
      accepted += 1;
      s.on('data', (d) => { received += d.length; });
      s.on('error', () => {});
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const port = (site.address() as AddressInfo).port;
    proxy = await startEgressProxy({
      consent: makeConsent([], privateOrigins),
      network: {
        resolve: async () => { throw new Error('IP literals are never looked up'); },
        dial: (address, p) => { dials.push(`${address}:${p}`); return net.connect(port, '127.0.0.1'); },
      },
    });
    proxy.open();
  };
  /** Raw bytes to the proxy, as a browser-process client that CDP never sees would send them. */
  const send = (raw: string): Promise<string> => new Promise((resolve) => {
    const s = net.connect(proxy.port, '127.0.0.1');
    conns.push(s);
    s.on('error', () => {});
    s.once('data', (d) => resolve(String(d)));
    s.write(raw);
  });
  const connect = (hostPort: string): Promise<string> => send(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`);
  const get = (url: string): Promise<string> => send(`GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n\r\n`);

  afterEach(async () => {
    for (const s of conns.splice(0)) s.destroy();
    dials.length = 0;
    await proxy.close();
    site.close();
  });

  const cases: { v: string; tls: string; plain: string; tlsHost: string; plainHost: string }[] = [
    { v: 'IPv4', tls: 'https://127.0.0.1:8443', plain: 'http://127.0.0.1:8080', tlsHost: '127.0.0.1:8443', plainHost: '127.0.0.1:8080' },
    { v: 'IPv6', tls: 'https://[::1]:8443', plain: 'http://[::1]:8080', tlsHost: '[::1]:8443', plainHost: '[::1]:8080' },
  ];

  for (const c of cases) {
    describe(c.v, () => {
      it('a confirmed https origin lets its CONNECT through', async () => {
        await start([c.tls]);
        expect(await connect(c.tlsHost)).toMatch(/^HTTP\/1\.1 200/);
        expect(dials).toHaveLength(1);
        await sleep(30);
        expect(accepted, 'control: the tunnel reached the destination').toBe(1);
      });

      it('a confirmed https origin does not let plain http to the same host and port through', async () => {
        await start([c.tls]);
        expect(await get(`http://${c.tlsHost}/`)).toMatch(/^HTTP\/1\.1 403/);
        expect(proxy.decisions.at(-1)?.reason).toBe('private-network destination');
        await sleep(30);
        expect({ dials, accepted, received }).toEqual({ dials: [], accepted: 0, received: 0 });
      });

      it('a confirmed http origin lets plain http through', async () => {
        await start([c.plain]);
        void get(`http://${c.plainHost}/x`); // The destination never answers; it only counts.
        await sleep(50);
        expect(dials, 'control').toHaveLength(1);
        expect(accepted).toBe(1);
        expect(received).toBeGreaterThan(0);
      });

      it('a confirmed http origin does not let a CONNECT to the same host and port through', async () => {
        await start([c.plain]);
        expect(await connect(c.plainHost)).toMatch(/^HTTP\/1\.1 403/);
        expect(proxy.decisions.at(-1)?.reason).toBe('private-network destination');
        await sleep(30);
        expect({ dials, accepted }).toEqual({ dials: [], accepted: 0 });
      });

      it('another port on the same host is not covered, either way', async () => {
        await start([c.tls, c.plain]);
        const host = c.tlsHost.slice(0, c.tlsHost.lastIndexOf(':'));
        expect(await connect(`${host}:9443`)).toMatch(/^HTTP\/1\.1 403/);
        expect(await get(`http://${host}:9080/`)).toMatch(/^HTTP\/1\.1 403/);
        await sleep(30);
        expect({ dials, accepted }).toEqual({ dials: [], accepted: 0 });
      });
    });
  }

  it('default ports count: https://10.0.0.1 covers CONNECT :443, not plain http on :80', async () => {
    await start(['https://10.0.0.1']);
    expect(await get('http://10.0.0.1/')).toMatch(/^HTTP\/1\.1 403/);
    expect(dials).toEqual([]);
    expect(await connect('10.0.0.1:443')).toMatch(/^HTTP\/1\.1 200/);
    expect(dials).toEqual(['10.0.0.1:443']);
  });

  it('a request line naming https is refused unread, even for a confirmed https origin', async () => {
    await start(['https://127.0.0.1:8443']);
    expect(await get('https://127.0.0.1:8443/')).toMatch(/^HTTP\/1\.1 403/);
    await sleep(30);
    expect({ dials, accepted }).toEqual({ dials: [], accepted: 0 });
  });

  it('a request line naming https on a public host is refused too, not sent in plain text', async () => {
    await start([]);
    expect(await get('https://203.0.113.9/')).toMatch(/^HTTP\/1\.1 403/);
    await sleep(30);
    expect({ dials, accepted }).toEqual({ dials: [], accepted: 0 });
  });

  it('a public origin confirmed as private covers nothing on a private address', async () => {
    await start(['https://intranet.example:8443']);
    expect(await connect('127.0.0.1:8443')).toMatch(/^HTTP\/1\.1 403/);
    expect(dials).toEqual([]);
  });
});
