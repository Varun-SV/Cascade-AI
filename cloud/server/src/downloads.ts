// ─────────────────────────────────────────────
//  Cascade Cloud Server — Desktop download resolver
// ─────────────────────────────────────────────
//
// The landing page used to hand visitors a link to the GitHub releases page.
// That asks somebody who wants "the app" to first work out why there are two
// .dmg files, which of the two .exe files installs and which one doesn't, and
// to ignore the ten .blockmap files and three updater manifests sitting beside
// them — twenty assets, of which seven are things a person can actually
// install. This module reads the latest release once, keeps the seven, and
// gives each one a stable URL on our own domain.
//
// The BYTES still come from GitHub's CDN: `/download/:target` answers a 302
// rather than streaming ~150 MB per click through this process. Proxying the
// installers would put every download on Railway's egress bill and hold a
// connection open in the app server for the length of a large file transfer,
// which is a poor trade for hiding a hostname. What changes for the visitor is
// the path they take — they press Download on the site and get a file, instead
// of arriving at a directory listing and having to choose correctly.
//
// The release is fetched at most once per TTL because GitHub's unauthenticated
// API allows 60 requests per hour per IP. Calling it per page view would spend
// that in a minute of ordinary traffic and then serve errors, so the cache is a
// correctness requirement rather than an optimisation.

const RELEASE_API_URL = 'https://api.github.com/repos/Varun-SV/Cascade-AI/releases/latest';
const RELEASES_PAGE_URL = 'https://github.com/Varun-SV/Cascade-AI/releases/latest';

/** How long a resolved release is served without re-asking GitHub. */
const CACHE_TTL_MS = 15 * 60 * 1000;
/**
 * How long a previously resolved release keeps being served once refreshing it
 * starts failing. A day-old asset list is still correct — releases are
 * append-only and the URLs in it do not rot — so an outage at GitHub's API
 * should degrade to "slightly stale" rather than to "no downloads on the site".
 */
const CACHE_STALE_MS = 24 * 60 * 60 * 1000;
/**
 * How long a FAILED refresh suppresses the next attempt.
 *
 * Without this the TTL only paces the happy path: `cache.fetchedAt` advances
 * on success alone, so a failing upstream is re-asked by every request that
 * arrives. Two minutes caps the failure path at 30 calls an hour — comfortably
 * under the 60/hour limit, and short enough that a transient blip clears
 * quickly rather than blacking the section out for a full TTL.
 */
const REFRESH_RETRY_MS = 2 * 60 * 1000;

/** GitHub rejects API requests without one. */
const USER_AGENT = 'cascade-ai-cloud';

/** Every build a person can install, in the order the site lists them. */
export const TARGET_IDS = [
  'mac-arm64', 'mac-x64', 'win-x64',
  'linux-appimage', 'linux-deb', 'linux-rpm', 'linux-pacman',
] as const;

export type TargetId = (typeof TARGET_IDS)[number];

const TARGET_SET: ReadonlySet<string> = new Set(TARGET_IDS);

export function isTargetId(value: string): value is TargetId {
  return TARGET_SET.has(value);
}

export interface TargetMeta {
  id: TargetId;
  os: 'mac' | 'windows' | 'linux';
  /** Shown as the button's own label. */
  label: string;
  /** Disambiguates two builds of the same OS; empty when there is only one. */
  detail: string;
}

export const TARGET_META: readonly TargetMeta[] = [
  { id: 'mac-arm64', os: 'mac', label: 'macOS', detail: 'Apple silicon' },
  { id: 'mac-x64', os: 'mac', label: 'macOS', detail: 'Intel' },
  { id: 'win-x64', os: 'windows', label: 'Windows', detail: 'Installer' },
  { id: 'linux-appimage', os: 'linux', label: 'Linux', detail: 'AppImage' },
  { id: 'linux-deb', os: 'linux', label: 'Linux', detail: 'Debian / Ubuntu' },
  { id: 'linux-rpm', os: 'linux', label: 'Linux', detail: 'Fedora / RHEL' },
  { id: 'linux-pacman', os: 'linux', label: 'Linux', detail: 'Arch' },
];

export interface DownloadTarget extends TargetMeta {
  /** The asset's own filename, shown so a download is identifiable on disk. */
  filename: string;
  sizeBytes: number;
  /** Where the bytes live. `/download/:id` redirects here. */
  url: string;
}

export interface DownloadManifest {
  version: string;
  releasedAt: string | null;
  targets: DownloadTarget[];
  /** Kept so the site can still offer "every file" for anything unlisted. */
  releasesUrl: string;
}

/**
 * Which installable — if any — an asset is.
 *
 * Returning null is the common case and the important one: a release carries
 * more machinery than product. `.blockmap` files and `latest*.yml` are
 * electron-updater's delta/version metadata, and the `-mac.zip` pair is what
 * the updater downloads to patch an existing install — none of the four is
 * something a person should be offered, and listing them is how a download
 * page becomes as confusing as the releases page it replaced.
 */
export function classifyAsset(name: string): TargetId | null {
  const n = name.toLowerCase();

  if (n.endsWith('.blockmap') || n.endsWith('.yml') || n.endsWith('.yaml')) return null;
  // The mac .zip builds exist for the auto-updater; humans want the .dmg.
  if (n.endsWith('.zip')) return null;

  if (n.endsWith('.dmg')) return n.includes('arm64') ? 'mac-arm64' : 'mac-x64';
  // Two .exe files ship: the NSIS installer ("Setup") and a portable binary.
  // Only the installer is offered — a portable .exe that quietly does not
  // install anything is not what "Download for Windows" should hand over.
  if (n.endsWith('.exe')) return n.includes('setup') ? 'win-x64' : null;
  if (n.endsWith('.appimage')) return 'linux-appimage';
  if (n.endsWith('.deb')) return 'linux-deb';
  if (n.endsWith('.rpm')) return 'linux-rpm';
  if (n.endsWith('.pacman')) return 'linux-pacman';

  return null;
}

interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface ReleaseResponse {
  tag_name?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

/** True for a URL we are willing to send a visitor's browser to. */
export function isTrustedAssetUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  return parsed.hostname === 'github.com' || parsed.hostname.endsWith('.github.com');
}

/**
 * Turns GitHub's release JSON into the manifest, dropping anything unrecognised.
 *
 * Exported separately from the fetching so the mapping — which is where the
 * real decisions live — can be tested against a recorded release payload
 * without a network round trip.
 */
export function buildManifest(payload: unknown): DownloadManifest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const release = payload as ReleaseResponse;

  const tag = typeof release.tag_name === 'string' ? release.tag_name : null;
  if (!tag) return null;
  const version = tag.replace(/^v/, '');

  const rawAssets = Array.isArray(release.assets) ? release.assets : [];
  const byTarget = new Map<TargetId, DownloadTarget>();

  for (const raw of rawAssets) {
    if (typeof raw !== 'object' || raw === null) continue;
    const asset = raw as Partial<ReleaseAsset>;
    if (typeof asset.name !== 'string') continue;
    if (typeof asset.browser_download_url !== 'string') continue;
    if (!isTrustedAssetUrl(asset.browser_download_url)) continue;

    const id = classifyAsset(asset.name);
    if (!id) continue;
    // First match wins. A release should never carry two assets for one
    // target, but if one ever does, picking deterministically beats picking
    // whichever the API happened to list last.
    if (byTarget.has(id)) continue;

    const meta = TARGET_META.find((m) => m.id === id);
    if (!meta) continue;

    byTarget.set(id, {
      ...meta,
      filename: asset.name,
      sizeBytes: typeof asset.size === 'number' && asset.size > 0 ? asset.size : 0,
      url: asset.browser_download_url,
    });
  }

  if (byTarget.size === 0) return null;

  return {
    version,
    releasedAt: typeof release.published_at === 'string' ? release.published_at : null,
    // Ordered by TARGET_META, not by GitHub's asset order, so the page is laid
    // out the same way on every deploy.
    targets: TARGET_META.map((m) => byTarget.get(m.id)).filter((t): t is DownloadTarget => t !== undefined),
    releasesUrl: RELEASES_PAGE_URL,
  };
}

interface CacheEntry {
  manifest: DownloadManifest;
  fetchedAt: number;
}

/**
 * Resolves the latest release, cached.
 *
 * A single instance is enough — the manifest is public and identical for every
 * visitor, so there is nothing per-user to key on.
 */
export class DownloadResolver {
  private cache: CacheEntry | null = null;
  /** De-duplicates CONCURRENT refreshes so a cold cache costs one request, not one per visitor. */
  private inFlight: Promise<DownloadManifest | null> | null = null;
  /**
   * When a refresh was last ATTEMPTED, successful or not. Null until the first.
   *
   * `cache.fetchedAt` only advances on success, so it cannot pace retries: with
   * it alone, a failing upstream is re-asked by every single request, because
   * `inFlight` covers concurrent callers and nothing covers sequential ones.
   * During a rate limit that turns each page view into another GitHub call —
   * spending the very allowance the cache exists to protect, and making every
   * visitor wait for a doomed request before they get the stale answer.
   */
  private lastAttemptAt: number | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<DownloadManifest | null> {
    const cached = this.cache;
    if (cached && this.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.manifest;

    // Negative caching: hold off re-asking a failing upstream. Worst case is
    // one call per retry window (30/hour) rather than one per request, which
    // stays under the 60/hour limit even while everything is going wrong.
    if (this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < REFRESH_RETRY_MS) {
      return this.staleOrNull(cached);
    }

    this.inFlight ??= this.refresh().finally(() => { this.inFlight = null; });
    const fresh = await this.inFlight;
    if (fresh) return fresh;

    return this.staleOrNull(cached);
  }

  /**
   * A previously resolved list, if it is not yet ancient.
   *
   * Stale but correct: release assets are append-only, so an old list still
   * points at files that exist. Serving it beats serving nothing.
   */
  private staleOrNull(cached: CacheEntry | null): DownloadManifest | null {
    if (cached && this.now() - cached.fetchedAt < CACHE_STALE_MS) return cached.manifest;
    return null;
  }

  private async refresh(): Promise<DownloadManifest | null> {
    try {
      const res = await this.fetchImpl(RELEASE_API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) return null;
      const manifest = buildManifest(await res.json());
      if (!manifest) return null;
      this.cache = { manifest, fetchedAt: this.now() };
      return manifest;
    } catch {
      // Network failure, malformed JSON, DNS — all the same to a caller that
      // just needs to know whether it can render buttons yet.
      return null;
    } finally {
      // Records the attempt whatever the outcome. This is the half that paces
      // retries; `cache.fetchedAt` only ever records successes.
      this.lastAttemptAt = this.now();
    }
  }
}

export { RELEASES_PAGE_URL, CACHE_TTL_MS, CACHE_STALE_MS, REFRESH_RETRY_MS };
