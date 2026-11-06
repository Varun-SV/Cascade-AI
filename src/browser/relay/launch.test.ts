import { describe, expect, it } from 'vitest';
import { PROFILE_PREFERENCES } from './egress-proxy.js';
import { TESTED_CHROMIUM_MAJORS, isBrowserOwnUi, claimFreshBrowser, preferencesProblem, versionProblem } from './launch.js';

const report = (over: object = {}): string => JSON.stringify({
  net: { network_prediction_options: { value: PROFILE_PREFERENCES.net.network_prediction_options } },
  webrtc: { ip_handling_policy: { value: PROFILE_PREFERENCES.webrtc.ip_handling_policy } },
  ...over,
});

describe('what a launched browser must show', () => {
  it('sets aside only the browser\'s own chrome:// interface', () => {
    expect(isBrowserOwnUi({ type: 'browser_ui', url: 'chrome://omnibox-popup.top-chrome/' })).toBe(true);
    for (const t of [{ type: 'browser_ui', url: 'https://evil.test/' }, { type: 'browser_ui', url: '' }, { type: 'service_worker', url: 'chrome://x/' }, { type: 'page', url: 'chrome://x/' }]) {
      expect(isBrowserOwnUi(t), JSON.stringify(t)).toBe(false);
    }
  });

  it('accepts the tested major version only', () => {
    for (const major of TESTED_CHROMIUM_MAJORS) {
      expect(versionProblem(`Chrome/${major}.0.1.2`)).toBeNull();
      expect(versionProblem(`HeadlessChrome/${major}.0.1.2`)).toBeNull();
    }
    for (const v of [`Chrome/${Math.max(...TESTED_CHROMIUM_MAJORS) + 1}.0.1.2`, `Chrome/${Math.min(...TESTED_CHROMIUM_MAJORS) - 1}.0.1.2`, 'Firefox/153.0', 'Chrome/', '']) {
      expect(versionProblem(v), v).toMatch(/untested/);
    }
  });
  it('accepts a report with every setting in force', () => {
    expect(preferencesProblem(report())).toBeNull();
  });
  it('refuses a report with a setting wrong, missing, or unreadable', () => {
    expect(preferencesProblem(report({ net: { network_prediction_options: { value: 0 } } }))).toMatch(/network_prediction/);
    expect(preferencesProblem(report({ net: {} }))).toMatch(/network_prediction/);
    expect(preferencesProblem(report({ webrtc: undefined }))).toMatch(/ip_handling_policy/);
    for (const r of ['', 'not json', 'null', '[]', '{}']) expect(preferencesProblem(r), r).not.toBeNull();
  });
  it('an object no launch produced is not fresh', () => {
    expect(claimFreshBrowser({})).toBe(false);
  });
});
