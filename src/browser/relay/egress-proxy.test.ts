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
});
