/**
 * Desktop download manifest + platform detection for the landing page.
 *
 * The server resolves the current release into a short list of installables
 * (see cloud/server/src/downloads.ts); this side decides which one to put under
 * the visitor's cursor and how to say so honestly when it cannot tell.
 */

export type TargetId =
  | 'mac-arm64' | 'mac-x64' | 'win-x64'
  | 'linux-appimage' | 'linux-deb' | 'linux-rpm' | 'linux-pacman';

export type TargetOs = 'mac' | 'windows' | 'linux';

export interface DownloadTarget {
  id: TargetId;
  os: TargetOs;
  label: string;
  detail: string;
  filename: string;
  sizeBytes: number;
  url: string;
}

export interface DownloadManifest {
  version: string;
  releasedAt: string | null;
  targets: DownloadTarget[];
  releasesUrl: string;
}

export const RELEASES_URL = 'https://github.com/Varun-SV/Cascade-AI/releases/latest';

/** The stable per-build URL. Server-side 302 to wherever the bytes live. */
export function downloadUrl(id: TargetId): string {
  return `/download/${id}`;
}

export async function fetchDownloads(): Promise<DownloadManifest> {
  const res = await fetch('/api/downloads');
  if (!res.ok) throw new Error(`Downloads unavailable: ${res.status}`);
  return res.json() as Promise<DownloadManifest>;
}

/** Bytes → "151 MB". Base-1000, which is what a download of this size is sold as. */
export function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return '';
  const mb = bytes / 1_000_000;
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * Which OS the visitor is on.
 *
 * `userAgentData.platform` where it exists, the UA string otherwise. Both are
 * spoofable and neither matters much if wrong — every alternative is one click
 * away in the full list underneath.
 */
export function detectOs(): TargetOs | null {
  if (typeof navigator === 'undefined') return null;

  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = (uaData?.platform ?? '').toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  const haystack = `${platform} ${ua}`;

  // Order matters: Android reports "linux" and every iOS device reports
  // "Mac OS X". None of them has a build, so they resolve to null and get the
  // full list rather than a button that hands them the wrong file.
  if (/android|iphone|ipad|ipod/.test(ua)) return null;
  if (/win/.test(haystack)) return 'windows';

  if (/mac/.test(haystack)) {
    // An iPad in desktop mode sends a Mac user-agent with NO iPad token — that
    // is the entire point of the mode, so the string genuinely cannot tell the
    // two apart and the guard above never fires for it. Touch points can: a Mac
    // reports 0 even with a trackpad or a Touch Bar, an iPad reports 5.
    if ((navigator.maxTouchPoints ?? 0) > 1) return null;
    return 'mac';
  }

  if (/linux|x11|ubuntu|fedora|debian/.test(haystack)) return 'linux';
  return null;
}

/**
 * Best guess before anything async has resolved.
 *
 * macOS defaults to Apple silicon: every Mac sold since late 2020 has it, so
 * it is right far more often than not — and `refineMacArch` corrects it on the
 * browsers that will say. The UI still shows the Intel build directly beneath,
 * because "probably" is not good enough to hide the alternative.
 */
export function defaultTarget(os: TargetOs | null): TargetId | null {
  switch (os) {
    case 'mac': return 'mac-arm64';
    case 'windows': return 'win-x64';
    // AppImage runs anywhere without a package manager, so it is the safe
    // default for a distro we cannot identify from a browser.
    case 'linux': return 'linux-appimage';
    default: return null;
  }
}

/**
 * Asks the browser what CPU it is actually on.
 *
 * `navigator.platform` is useless here — it reports "MacIntel" on Apple silicon
 * too, which is exactly the distinction that matters. High-entropy client hints
 * are the only way to know, and only Chromium implements them; Safari and
 * Firefox return nothing, which is why the guess above has to be defensible on
 * its own.
 *
 * Resolves null when it cannot tell, never throws.
 */
export async function refineMacArch(): Promise<'arm' | 'x86' | null> {
  if (typeof navigator === 'undefined') return null;
  const uaData = (navigator as Navigator & {
    userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string }> };
  }).userAgentData;
  if (!uaData?.getHighEntropyValues) return null;

  try {
    const { architecture } = await uaData.getHighEntropyValues(['architecture']);
    if (architecture === 'arm') return 'arm';
    if (architecture === 'x86') return 'x86';
    return null;
  } catch {
    return null;
  }
}
