import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type EgressProxy, PROFILE_PREFERENCES } from './egress-proxy.js';
import { TESTED_CHROMIUM_MAJORS, claimFreshBrowser, commandLineProblem, isBrowserOwnUi, launchBehindProxy, launchForRelayTests, preferencesProblem, testArgProblem, versionProblem } from './launch.js';

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

describe('what a caller can ask the launch to do', () => {
  const proxy = { port: 1 } as EgressProxy;

  it.each(['extraArgs', 'testArgs', 'env', 'bareProfileDir', 'args', 'anythingElse'])('the real launch refuses %s, before starting anything', async (name) => {
    const opts = { chromiumPath: '/nonexistent/browser', proxy, [name]: ['--no-proxy-server'] };
    await expect(launchBehindProxy(opts as never)).rejects.toThrow(`the launch takes no ${name}`);
  });

  it.each([
    '--proxy-server=http://evil.test:1', '--no-proxy-server', '--proxy-bypass-list=*', '--proxy-pac-url=http://evil.test/p', '--proxy-auto-detect',
    '--host-resolver-rules=MAP * 127.0.0.1', '--host-rules=MAP * 127.0.0.1', '--remote-debugging-address=0.0.0.0', '--remote-debugging-port=9222', '--remote-debugging-pipe',
    '--remote-allow-origins=*', '--user-data-dir=/tmp/reused', '--profile-directory=Other', '--load-extension=/tmp/x', '--enable-features=Prerender2', '--disable-features=X',
    '--headless', '--webrtc-ip-handling-policy=default', '--enable-background-networking', '-proxy-server=http://evil.test:1', '--unsafely-treat-insecure-origin-as-secure-x=1',
    '--enable-quicker', 'about:blank', '',
  ])('a test may not add %s', async (arg) => {
    expect(testArgProblem(arg)).toMatch(/not a test switch/);
    await expect(launchForRelayTests({ chromiumPath: '/nonexistent/browser', proxy, testArgs: [arg] })).rejects.toThrow(/not a test switch/);
  });

  it('nothing but a test names the launch that takes switches', () => {
    const root = path.join(process.cwd(), 'src');
    const named = (fs.readdirSync(root, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts') && fs.readFileSync(path.join(root, f), 'utf8').includes('launchForRelayTests'))
      .map((f) => f.split(path.sep).join('/'));
    expect(named).toEqual(['browser/relay/launch.ts']);
  });
});

describe('the command line the running browser reports', () => {
  const asked = ['--a=1', '--user-data-dir=/tmp/my profile', '--b'];
  it('accepts what was asked, whatever the path or the page after it, and a switch that controls nothing', () => {
    expect(commandLineProblem('/opt/chrome --a=1 --user-data-dir=/tmp/my profile --b about:blank', asked)).toBeNull();
    expect(commandLineProblem('/opt/chrome --noerrdialogs --a=1 --user-data-dir=/tmp/my profile --b --disable-gpu about:blank', asked)).toBeNull();
  });
  it('refuses a controlling switch added, however it is spelled, or one of ours given twice', () => {
    const added = ['--no-proxy-server', '-no-proxy-server', '--proxy-server=http://x:1', '--proxy-bypass-list=*', '--host-resolver-rules=MAP', '--remote-allow-origins=*', '--remote-debugging-address=0.0.0.0', '--load-extension=/x', '--enable-features=X', '--user-data-dir=/other', '--a=2', '--a=1', '--b'];
    for (const extra of added) {
      expect(commandLineProblem(`/opt/chrome --a=1 --user-data-dir=/tmp/my profile --b ${extra} about:blank`, asked), extra).toMatch(/did not ask for/);
    }
  });
  it('refuses one missing or changed, and anything unreadable', () => {
    expect(commandLineProblem('/opt/chrome --a=1 --b about:blank', asked)).toMatch(/missing switch: --user-data-dir/);
    expect(commandLineProblem('/opt/chrome --a=12 --user-data-dir=/tmp/my profile --b', asked)).toMatch(/missing switch: --a=1/);
    for (const r of ['', '   ']) expect(commandLineProblem(r, asked)).toMatch(/unreadable/);
  });
});
