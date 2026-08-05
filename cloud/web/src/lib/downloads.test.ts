import { describe, it, expect, afterEach, vi } from 'vitest';
import { detectOs, defaultTarget, formatSize, refineMacArch, downloadUrl } from './downloads.js';

/** Swaps in a fake navigator for one assertion, restoring it afterwards. */
function withNavigator(nav: Partial<Navigator> & Record<string, unknown>, fn: () => void) {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  try { fn(); } finally {
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true, writable: true });
  }
}

const UA = {
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 iPad',
};

describe('detectOs', () => {
  it('reads the three desktop platforms', () => {
    withNavigator({ userAgent: UA.macSafari }, () => expect(detectOs()).toBe('mac'));
    withNavigator({ userAgent: UA.windows }, () => expect(detectOs()).toBe('windows'));
    withNavigator({ userAgent: UA.linux }, () => expect(detectOs()).toBe('linux'));
  });

  it('prefers userAgentData.platform when the browser exposes it', () => {
    withNavigator(
      { userAgent: UA.linux, userAgentData: { platform: 'Windows' } },
      () => expect(detectOs()).toBe('windows'),
    );
  });

  it('claims nothing on mobile, which has no build', () => {
    // Android's UA says "Linux" and an iPhone's says "Mac OS X"; both would
    // otherwise be handed a desktop installer they cannot run.
    withNavigator({ userAgent: UA.android }, () => expect(detectOs()).toBeNull());
    withNavigator({ userAgent: UA.iphone }, () => expect(detectOs()).toBeNull());
    withNavigator({ userAgent: UA.ipadDesktop }, () => expect(detectOs()).toBeNull());
  });

  it('returns null for anything unrecognised', () => {
    withNavigator({ userAgent: 'SomeCrawler/1.0' }, () => expect(detectOs()).toBeNull());
  });
});

describe('defaultTarget', () => {
  it('picks a sensible build per OS', () => {
    // Apple silicon: every Mac sold since late 2020. The Intel build stays
    // visible in the UI because this is a guess, not a detection.
    expect(defaultTarget('mac')).toBe('mac-arm64');
    expect(defaultTarget('windows')).toBe('win-x64');
    // AppImage needs no package manager, so it is the safe unknown-distro pick.
    expect(defaultTarget('linux')).toBe('linux-appimage');
    expect(defaultTarget(null)).toBeNull();
  });
});

describe('refineMacArch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports the real architecture when client hints are available', async () => {
    const getHighEntropyValues = vi.fn(async () => ({ architecture: 'x86' }));
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: UA.macSafari, userAgentData: { getHighEntropyValues } },
      configurable: true, writable: true,
    });
    await expect(refineMacArch()).resolves.toBe('x86');
    expect(getHighEntropyValues).toHaveBeenCalledWith(['architecture']);
  });

  it('resolves null on Safari and Firefox, which do not implement it', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: UA.macSafari },
      configurable: true, writable: true,
    });
    await expect(refineMacArch()).resolves.toBeNull();
  });

  it('resolves null rather than rejecting when the call throws', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: UA.macSafari,
        userAgentData: { getHighEntropyValues: async () => { throw new Error('denied'); } },
      },
      configurable: true, writable: true,
    });
    await expect(refineMacArch()).resolves.toBeNull();
  });
});

describe('formatSize', () => {
  it('renders installer sizes the way a download is described', () => {
    expect(formatSize(151237300)).toBe('151 MB');
    expect(formatSize(127347976)).toBe('127 MB');
    expect(formatSize(2_400_000_000)).toBe('2.4 GB');
  });

  it('renders nothing for a missing size instead of "0 MB"', () => {
    expect(formatSize(0)).toBe('');
    expect(formatSize(-1)).toBe('');
  });
});

describe('downloadUrl', () => {
  it('is the stable per-build path, with no version to go stale', () => {
    expect(downloadUrl('mac-arm64')).toBe('/download/mac-arm64');
    expect(downloadUrl('linux-pacman')).toBe('/download/linux-pacman');
  });
});
