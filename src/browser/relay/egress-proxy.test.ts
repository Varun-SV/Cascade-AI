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
  });
});
