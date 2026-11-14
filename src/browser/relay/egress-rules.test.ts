import { describe, expect, it } from 'vitest';
import { isPrivateHost, makeConsent, onConsentedSite, requestVerdict } from './egress-rules.js';

describe('isPrivateHost', () => {
  it.each(['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', 'printer.local', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '[::1]', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::', '2002:c0a8:1::',
    '192.0.0.1', '::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '64:ff9b:1::c0a8:101', '64:ff9b:1:ffff::1', 'fec0::1', '100::1'])('private: %s', (h) => {
    expect(isPrivateHost(h)).toBe(true);
  });
  it.each(['example.com', 'localhost.example.com', 'local', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::', '192.0.1.1', '192.0.2.1', '::ffff:0:808:808', '64:ff9b:2::1', '100:0:0:1::1'])('public: %s', (h) => {
    expect(isPrivateHost(h)).toBe(false);
  });
});

describe('requestVerdict', () => {
  const consent = makeConsent(['https://ok.test', 'http://site.test:8080'], ['http://192.168.1.1', 'http://localhost:3000']);
  const allowed = (u: string, t: string) => requestVerdict(u, t, consent).allow;

  it('a document needs a consented origin, whatever started it', () => {
    expect(allowed('https://ok.test/a', 'Document')).toBe(true);
    expect(allowed('http://site.test:8080/', 'Document')).toBe(true);
    expect(allowed('https://offlist.test/', 'Document')).toBe(false);
    expect(allowed('http://ok.test/', 'Document')).toBe(false);
    expect(allowed('http://site.test/', 'Document')).toBe(false);
  });
  it('a document on any other scheme is refused, and file: of any type', () => {
    for (const u of ['file:///etc/hostname', 'chrome://version', 'data:text/html,x', 'about:config']) expect(allowed(u, 'Document'), u).toBe(false);
    expect(allowed('file:///etc/hostname', 'Script')).toBe(false);
  });
  it('a public subresource is allowed, as the stated limit says', () => {
    expect(allowed('https://cdn.test/lib.js', 'Script')).toBe(true);
    expect(allowed('wss://cdn.test/s', 'WebSocket')).toBe(true);
    expect(allowed('data:image/png,x', 'Image')).toBe(true);
  });
  it('a private destination needs its own confirmation', () => {
    for (const u of ['http://127.0.0.1/', 'http://10.0.0.1/x', 'ws://127.0.0.1:9/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'http://localhost:3001/']) {
      expect(allowed(u, 'Fetch'), u).toBe(false);
    }
    expect(allowed('http://192.168.1.1/', 'Document')).toBe(true);
    expect(allowed('ws://192.168.1.1/', 'WebSocket')).toBe(true);
    expect(allowed('http://localhost:3000/', 'Fetch')).toBe(true);
  });
  it('ordinary site consent on a private origin is not enough', () => {
    const plain = makeConsent(['http://192.168.1.1']);
    expect(requestVerdict('http://192.168.1.1/', 'Document', plain).allow).toBe(false);
    expect(onConsentedSite('http://192.168.1.1/', plain)).toBe(false);
  });
  it('an unparseable URL is refused', () => {
    expect(allowed('http://', 'Fetch')).toBe(false);
  });
});

describe('onConsentedSite', () => {
  const consent = makeConsent(['https://ok.test']);
  it.each([['about:blank', true], ['about:srcdoc', true], ['', true], ['https://ok.test/a', true], ['blob:https://ok.test/id', true],
    ['https://offlist.test/', false], ['blob:https://offlist.test/id', false], ['file:///x', false], ['chrome://version', false], ['data:text/html,x', false]])('%s → %s', (u, want) => {
    expect(onConsentedSite(u as string, consent)).toBe(want);
  });
});
