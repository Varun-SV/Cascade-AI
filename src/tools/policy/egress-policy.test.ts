import { describe, it, expect } from 'vitest';
import {
  EgressGovernor,
  normalizeHost,
  DEFAULT_EGRESS_LIMITS,
  type EgressVerdict,
} from './egress-policy.js';

/** A governor with a clock the test drives by hand. */
function fixed() {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  return { now, advance };
}

function expectAllow(v: EgressVerdict): void {
  expect(v.allow).toBe(true);
}
function expectDeny(v: EgressVerdict, code: string): void {
  expect(v.allow).toBe(false);
  if (!v.allow) expect(v.code).toBe(code);
}

describe('normalizeHost', () => {
  it('lower-cases and drops a trailing dot', () => {
    expect(normalizeHost('EXAMPLE.com.')).toBe('example.com');
    expect(normalizeHost('  Example.COM  ')).toBe('example.com');
  });
});

describe('EgressGovernor scheme + denylist', () => {
  it('refuses a non-http(s) scheme', () => {
    const g = new EgressGovernor();
    expectDeny(g.check('file:///etc/passwd'), 'scheme');
    expectDeny(g.check('ftp://host/x'), 'scheme');
  });

  it('refuses an unparseable URL', () => {
    const g = new EgressGovernor();
    expectDeny(g.check('not a url'), 'scheme');
  });

  it('refuses a denylisted host, before counting', () => {
    const g = new EgressGovernor({ denylist: (h) => h === 'blocked.example' });
    expectDeny(g.check('https://blocked.example/a'), 'denylist');
    // A denied host leaves the window empty, so an allowed host still starts fresh.
    expectAllow(g.check('https://ok.example/a'));
  });

  it('matches the denylist on the normalized host', () => {
    const g = new EgressGovernor({ denylist: (h) => h === 'blocked.example' });
    expectDeny(g.check('https://BLOCKED.example./a'), 'denylist');
  });
});

describe('EgressGovernor per-host rate', () => {
  it('allows up to the per-host cap, then blocks', () => {
    const clock = fixed();
    const g = new EgressGovernor({ limits: { maxPerHost: 3, maxHosts: 100, maxTotal: 100 }, now: clock.now });
    expectAllow(g.check('https://a.example/1'));
    expectAllow(g.check('https://a.example/2'));
    expectAllow(g.check('https://a.example/3'));
    expectDeny(g.check('https://a.example/4'), 'host-rate');
  });

  it('a refused request does not fill the window', () => {
    const clock = fixed();
    const g = new EgressGovernor({ limits: { maxPerHost: 2, maxHosts: 100, maxTotal: 100 }, now: clock.now });
    expectAllow(g.check('https://a.example/1'));
    expectAllow(g.check('https://a.example/2'));
    expectDeny(g.check('https://a.example/3'), 'host-rate');
    // Two were recorded, not three. After one falls out of the window, exactly
    // one slot opens — proof the blocked call was never counted.
    clock.advance(DEFAULT_EGRESS_LIMITS.windowMs + 1); // clears both
    expectAllow(g.check('https://a.example/4'));
  });

  it('forgets hits older than the window', () => {
    const clock = fixed();
    const g = new EgressGovernor({ limits: { windowMs: 1000, maxPerHost: 2, maxHosts: 100, maxTotal: 100 }, now: clock.now });
    expectAllow(g.check('https://a.example/1'));
    clock.advance(600);
    expectAllow(g.check('https://a.example/2'));
    expectDeny(g.check('https://a.example/3'), 'host-rate');
    clock.advance(500); // first hit (at +0) now older than 1000ms, second remains
    expectAllow(g.check('https://a.example/4'));
  });
});

describe('EgressGovernor host spread (scanning)', () => {
  it('blocks reaching too many distinct hosts', () => {
    const clock = fixed();
    const g = new EgressGovernor({ limits: { maxHosts: 3, maxPerHost: 100, maxTotal: 100 }, now: clock.now });
    expectAllow(g.check('https://h1.example/'));
    expectAllow(g.check('https://h2.example/'));
    expectAllow(g.check('https://h3.example/'));
    expectDeny(g.check('https://h4.example/'), 'host-spread');
  });

  it('a host already in the window does not count against spread again', () => {
    const clock = fixed();
    const g = new EgressGovernor({ limits: { maxHosts: 2, maxPerHost: 100, maxTotal: 100 }, now: clock.now });
    expectAllow(g.check('https://h1.example/a'));
    expectAllow(g.check('https://h2.example/a'));
    // Revisiting h1 is fine — steady work on a known set is not a sweep.
    expectAllow(g.check('https://h1.example/b'));
    expectAllow(g.check('https://h2.example/b'));
    // A third distinct host is the sweep.
    expectDeny(g.check('https://h3.example/a'), 'host-spread');
  });
});

describe('EgressGovernor total rate', () => {
  it('blocks when the overall cap is reached across hosts', () => {
    const clock = fixed();
    const g = new EgressGovernor({ limits: { maxTotal: 3, maxHosts: 100, maxPerHost: 100 }, now: clock.now });
    expectAllow(g.check('https://a.example/'));
    expectAllow(g.check('https://b.example/'));
    expectAllow(g.check('https://c.example/'));
    expectDeny(g.check('https://d.example/'), 'total-rate');
  });
});

describe('EgressGovernor defaults', () => {
  it('lets ordinary browsing through', () => {
    const g = new EgressGovernor();
    for (let i = 0; i < 10; i++) {
      expectAllow(g.check(`https://docs.example/page/${i}`));
    }
    expectAllow(g.check('https://news.example/'));
    expectAllow(g.check('https://api.example/v1'));
  });
});
