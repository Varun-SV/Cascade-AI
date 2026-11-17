import { describe, expect, it } from 'vitest';
import { makeConsent } from '../../src/browser/relay/egress-rules.js';
import { PRIVATE_DOMAINS, PRIVATE_URL_PATTERNS, tabRules } from './tab-policy.js';

/** The rules applied the way declarativeNetRequest applies them: the highest priority wins. */
function verdict(rules: ReturnType<typeof tabRules>, tabId: number, url: string, type: string, initiator?: string): 'allow' | 'block' | 'none' {
  const hits = rules.filter((r) => {
    const c = r.condition;
    if (c.tabIds && !c.tabIds.includes(tabId)) return false;
    if (c.initiatorDomains) {
      const from = initiator ? new URL(initiator).hostname : '';
      if (!c.initiatorDomains.some((d) => from === d || from.endsWith(`.${d}`))) return false;
    }
    if (c.resourceTypes && !c.resourceTypes.includes(type as never)) return false;
    if (c.urlFilter) {
      // Only the `|prefix` form is used.
      if (!c.urlFilter.startsWith('|') || !url.toLowerCase().startsWith(c.urlFilter.slice(1).toLowerCase())) return false;
    }
    if (c.regexFilter && !new RegExp(c.regexFilter, 'i').test(url)) return false;
    if (c.requestDomains) {
      const host = new URL(url).hostname.replace(/\.$/, '');
      if (!c.requestDomains.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    }
    return true;
  });
  if (!hits.length) return 'none';
  const top = hits.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1))[0]!;
  return top.action.type === 'allow' ? 'allow' : 'block';
}

describe("the run tab's rules", () => {
  const rules = tabRules(7, makeConsent(['https://example.com', 'http://allowed.test:8080']), 500);

  it('documents load only from consented sites, in the main frame and in frames', () => {
    for (const type of ['main_frame', 'sub_frame']) {
      expect(verdict(rules, 7, 'https://example.com/a?b', type)).toBe('allow');
      expect(verdict(rules, 7, 'http://allowed.test:8080/', type)).toBe('allow');
      expect(verdict(rules, 7, 'https://elsewhere.test/', type)).toBe('block');
      // A host that only starts with a consented one is another host.
      expect(verdict(rules, 7, 'https://example.com.evil.test/', type)).toBe('block');
      // Another scheme or port is another origin.
      expect(verdict(rules, 7, 'http://example.com/', type)).toBe('block');
      expect(verdict(rules, 7, 'http://allowed.test/', type)).toBe('block');
    }
  });

  it('subresources from public sites load, so pages work', () => {
    expect(verdict(rules, 7, 'https://cdn.elsewhere.test/lib.js', 'script')).toBe('none');
  });

  it('private-network addresses are blocked for every kind of request, consented or not', () => {
    const consented = tabRules(7, makeConsent(['https://example.com', 'http://localhost:3000']), 500);
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://10.1.2.3/x', 'http://192.168.0.1/', 'http://172.20.0.1/', 'http://169.254.169.254/latest', 'ws://[::1]:9000/', 'http://router.local/', 'http://app.localhost/', 'http://100.64.0.1/']) {
      expect([url, verdict(consented, 7, url, 'xmlhttprequest')]).toEqual([url, 'block']);
      expect([url, verdict(consented, 7, url, 'main_frame')]).toEqual([url, 'block']);
    }
    for (const url of ['https://172.32.0.1/', 'https://8.8.8.8/', 'https://localhost.example.com/', 'https://192.169.0.1/']) {
      expect([url, PRIVATE_URL_PATTERNS.some((p) => new RegExp(p, 'i').test(url)) || PRIVATE_DOMAINS.includes(new URL(url).hostname)]).toEqual([url, false]);
    }
  });

  it("the consented sites' service and shared workers can't reach private addresses either", () => {
    // A worker's requests come from no tab (-1), with the worker's site as initiator.
    for (const url of ['http://127.0.0.1/', 'http://192.168.0.1/admin', 'ws://[::1]:9000/', 'http://router.local/', 'http://10.0.0.5/']) {
      for (const type of ['xmlhttprequest', 'websocket', 'other']) {
        expect([url, type, verdict(rules, -1, url, type, 'https://example.com')]).toEqual([url, type, 'block']);
        expect([url, type, verdict(rules, -1, url, type, 'http://allowed.test:8080')]).toEqual([url, type, 'block']);
      }
    }
    // Their public requests are untouched.
    expect(verdict(rules, -1, 'https://api.elsewhere.test/x', 'xmlhttprequest', 'https://example.com')).toBe('none');
  });

  it("leave other sites' workers alone", () => {
    expect(verdict(rules, -1, 'http://192.168.0.1/', 'xmlhttprequest', 'https://elsewhere.test')).toBe('none');
    expect(verdict(rules, -1, 'http://127.0.0.1/', 'xmlhttprequest', 'https://example.com.evil.test')).toBe('none');
  });

  it('stay inside the run\'s rule ids at the most sites a run can allow', () => {
    const many = Array.from({ length: 50 }, (_, i) => `https://site${i}.example`);
    const r = tabRules(7, makeConsent(many), 1000);
    // The popup rule is firstRuleId + 90, and the next run starts at + 100.
    expect(Math.max(...r.map((x) => x.id))).toBeLessThan(1000 + 90);
  });

  it("apply to the run's tab only: the user's other tabs are untouched", () => {
    expect(verdict(rules, 8, 'https://elsewhere.test/', 'main_frame')).toBe('none');
    expect(verdict(rules, 8, 'http://127.0.0.1/', 'xmlhttprequest')).toBe('none');
  });

  it('use ids from the run\'s own range', () => {
    expect(rules.map((r) => r.id)).toEqual(Array.from({ length: rules.length }, (_, i) => 500 + i));
  });
});
