import { describe, expect, it } from 'vitest';
import { PROFILE_PREFERENCES } from './egress-proxy.js';
import { TESTED_CHROMIUM_MAJOR, claimFreshBrowser, preferencesProblem, versionProblem } from './launch.js';

const report = (over: object = {}): string => JSON.stringify({
  net: { network_prediction_options: { value: PROFILE_PREFERENCES.net.network_prediction_options } },
  webrtc: { ip_handling_policy: { value: PROFILE_PREFERENCES.webrtc.ip_handling_policy } },
  ...over,
});

describe('what a launched browser must show', () => {
  it('accepts the tested major version only', () => {
    expect(versionProblem(`Chrome/${TESTED_CHROMIUM_MAJOR}.0.1.2`)).toBeNull();
    expect(versionProblem(`HeadlessChrome/${TESTED_CHROMIUM_MAJOR}.0.1.2`)).toBeNull();
    for (const v of [`Chrome/${TESTED_CHROMIUM_MAJOR + 1}.0.1.2`, `Chrome/${TESTED_CHROMIUM_MAJOR - 1}.0.1.2`, 'Firefox/153.0', 'Chrome/', '']) {
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
