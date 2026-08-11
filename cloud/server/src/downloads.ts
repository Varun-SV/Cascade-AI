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

import fs from 'node:fs/promises';
import path from 'node:path';

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

/** How far ahead of now a persisted `fetchedAt` may sit before it is junk. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

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
 * True when a URL's last path segment IS the given filename.
 *
 * GitHub builds `browser_download_url` by appending the asset name, so this
 * holds for anything buildManifest() produced — which is why the check lives on
 * the STORED path only: the cache file is what sits on a volume an operator can
 * edit, while the API response is already trusted for the asset list itself.
 * Decoded, so a name carrying a space or a `+` still matches its escaped form.
 */
function urlPointsAt(url: string, filename: string): boolean {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    return decodeURIComponent(last) === filename;
  } catch {
    return false;
  }
}

/**
 * Re-validates a manifest read back from disk.
 *
 * The file is ours, but it can be truncated by a crash mid-write, left behind
 * by an older format, or edited on a volume an operator has shell access to.
 * The asset URLs in it are rendered as links by the site, so they go through
 * the same trust check a freshly fetched manifest does — `/download/:target`
 * re-checks before redirecting, but `/api/downloads` hands the list to the
 * page as-is.
 *
 * Only the three fields that genuinely VARY per release are taken from the
 * file: filename, size and url. `os`, `label` and `detail` are constants keyed
 * by the target id (TARGET_META), so they are rebuilt from the validated id
 * rather than trusted — the same reasoning as `releasesUrl` below. Reading
 * them from disk would let a stale or hand-edited entry reach the page with,
 * say, no `os`, and the download section indexes its icon map by that field:
 * an undefined lookup throws while rendering and takes the whole section down,
 * which is a worse outcome than the missing-manifest fallback this warm start
 * exists to avoid.
 */
function parseStoredEntry(raw: unknown): CacheEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { manifest, fetchedAt } = raw as { manifest?: unknown; fetchedAt?: unknown };
  // A timestamp in the FUTURE is rejected, not just a malformed one. Both the
  // freshness and staleness checks in get() are `now - fetchedAt`, so a future
  // value makes that age negative — which reads as "fetched moments ago"
  // forever, pinning the site to one obsolete release with the 15-minute TTL
  // never able to expire it. A host clock corrected backwards is enough to
  // produce one. The tolerance absorbs ordinary skew between the writing and
  // reading process without admitting a value that could wedge the cache.
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null;
  if (fetchedAt > Date.now() + CLOCK_SKEW_TOLERANCE_MS) return null;
  if (typeof manifest !== 'object' || manifest === null) return null;
  const m = manifest as Partial<DownloadManifest>;
  if (typeof m.version !== 'string' || !Array.isArray(m.targets)) return null;

  const targets: DownloadTarget[] = [];
  for (const raw of m.targets) {
    if (typeof raw !== 'object' || raw === null) continue;
    const t = raw as Partial<DownloadTarget>;
    if (typeof t.id !== 'string' || !isTargetId(t.id)) continue;
    if (typeof t.filename !== 'string' || !t.filename) continue;
    if (typeof t.sizeBytes !== 'number' || !Number.isFinite(t.sizeBytes) || t.sizeBytes <= 0) continue;
    if (typeof t.url !== 'string' || !isTrustedAssetUrl(t.url)) continue;
    // The filename has to still CLASSIFY as the target it claims to be. Each
    // field was checked on its own, so an entry labelled `mac-arm64` whose
    // filename was a Windows installer passed — its URL is a genuine GitHub
    // one, and the metadata is rebuilt from the id — and the site would then
    // offer that .exe to Mac visitors under a macOS label, with
    // `/download/mac-arm64` redirecting to it. Re-deriving the id from the
    // filename is the check that ties the two together.
    if (classifyAsset(t.filename) !== t.id) continue;
    // …and the URL has to point at THAT filename. Classifying the filename ties
    // it to the id, but left the url free: an entry with a genuine `.dmg`
    // filename and a github.com URL ending in the Windows installer passed both
    // checks, and `/download/mac-arm64` would then redirect a Mac visitor to
    // that .exe. The three fields only mean anything together.
    if (!urlPointsAt(t.url, t.filename)) continue;
    const meta = TARGET_META.find((candidate) => candidate.id === t.id);
    if (!meta) continue;
    targets.push({ ...meta, filename: t.filename, sizeBytes: t.sizeBytes, url: t.url });
  }
  if (targets.length === 0) return null;

  return {
    fetchedAt,
    manifest: {
      version: m.version,
      releasedAt: typeof m.releasedAt === 'string' ? m.releasedAt : null,
      targets,
      // Always ours, never the file's — a stored value has no reason to differ
      // and every reason not to be trusted with where visitors are sent.
      releasesUrl: RELEASES_PAGE_URL,
    },
  };
}

export interface DownloadResolverOptions {
  /**
   * A GitHub token for the release lookup. Needs no scopes — it reads a public
   * release — and only raises the rate limit. Omitted in tests and in local dev.
   */
  token?: string;
  /**
   * Where to keep the last good manifest so a restart starts warm. Lives under
   * DATA_DIR, which is a persistent volume in the hosted deployment. Omitted
   * means memory-only, which is the old behaviour.
   */
  cacheFile?: string;
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
  /** Guards the one-time warm start; set before awaiting so it cannot double-run. */
  private diskRead: Promise<void> | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly options: DownloadResolverOptions = {},
  ) {}

  async get(): Promise<DownloadManifest | null> {
    await this.warmStart();
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

  /**
   * Seeds the in-memory cache from disk, once, before the first lookup.
   *
   * Without this the cache is purely in-process, so it can only ever help a
   * process that has already succeeded at least once. A redeploy starts cold,
   * and if that first fetch fails — a rate limit is the likely reason, see
   * `authHeaders` — `CACHE_STALE_MS` has nothing to fall back TO and the site
   * shows its "downloads unavailable" fallback until GitHub answers again.
   * That is precisely when the fallback is least wanted and most visible.
   */
  private async warmStart(): Promise<void> {
    this.diskRead ??= (async () => {
      const file = this.options.cacheFile;
      if (!file) return;
      try {
        const entry = parseStoredEntry(JSON.parse(await fs.readFile(file, 'utf8')));
        // Never overwrites a live result: a refresh may have landed while this
        // read was in flight, and the fetched copy is the newer one.
        if (entry && !this.cache) this.cache = entry;
      } catch { /* no file yet, or unreadable — a cold start is still correct */ }
    })();
    await this.diskRead;
  }

  /** Best-effort write-through, so the NEXT process starts warm. */
  private async persist(entry: CacheEntry): Promise<void> {
    const file = this.options.cacheFile;
    if (!file) return;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Written to a temp file and renamed: a crash partway through a direct
      // write leaves truncated JSON that the next boot cannot parse, which
      // costs exactly the warm start this exists to provide.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(entry), 'utf8');
      await fs.rename(tmp, file);
    } catch { /* an unwritable DATA_DIR must not break downloads */ }
  }

  /**
   * Authorization for the GitHub API when a token is configured.
   *
   * Unauthenticated, the API allows 60 requests per hour PER IP — and on a
   * shared host (Railway) that IP is shared with every other tenant on the
   * same egress, so the real allowance is some unknown fraction of 60 that
   * this service never sees coming. A token raises it to 5,000/hour and, more
   * importantly, makes it OURS rather than the neighbourhood's. The token
   * needs no scopes: it reads a public release.
   */
  private authHeaders(): Record<string, string> {
    const token = this.options.token?.trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async refresh(): Promise<DownloadManifest | null> {
    try {
      const res = await this.fetchImpl(RELEASE_API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': '2022-11-28',
          ...this.authHeaders(),
        },
      });
      if (!res.ok) return null;
      const manifest = buildManifest(await res.json());
      if (!manifest) return null;
      const entry = { manifest, fetchedAt: this.now() };
      this.cache = entry;
      // Not awaited: a slow or failing disk must not hold up the response that
      // already has its answer. Failures are swallowed inside persist().
      void this.persist(entry);
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
