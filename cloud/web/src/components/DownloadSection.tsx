import { useEffect, useMemo, useState } from 'react';
import { Download, ChevronDown, Apple, MonitorDown, Terminal, ExternalLink } from 'lucide-react';
import {
  fetchDownloads, downloadUrl, formatSize, detectOs, defaultTarget, refineMacArch,
  RELEASES_URL, type DownloadManifest, type DownloadTarget, type TargetId, type TargetOs,
} from '../lib/downloads.js';
import { TIER_COLORS } from '../lib/brand.js';

/**
 * The desktop app, downloadable from the page it is advertised on.
 *
 * The old CTA was a link to the GitHub releases page, which answers "I want the
 * app" with twenty files — two .dmg builds, two .exe builds of which only one
 * installs anything, and fourteen blockmaps and updater manifests. The visitor
 * had to know their own CPU architecture and which file extension their machine
 * takes before they could get started.
 *
 * Here the common case is one button with the right file already chosen, the
 * near-miss (an Intel Mac) is a single line beneath it, and every other build is
 * one disclosure away. The bytes still come from GitHub's CDN — /download/:id
 * redirects — so this costs nothing to serve and stays correct automatically as
 * releases ship.
 */

const OS_ICON: Record<TargetOs, typeof Download> = {
  mac: Apple,
  windows: MonitorDown,
  linux: Terminal,
};

export default function DownloadSection({ reduced }: { reduced: boolean }) {
  const [manifest, setManifest] = useState<DownloadManifest | null>(null);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Detected once — the machine does not change mid-visit, and re-running this
  // on every render would re-read the UA string for no reason.
  const [os] = useState<TargetOs | null>(() => detectOs());
  const [primaryId, setPrimaryId] = useState<TargetId | null>(() => defaultTarget(detectOs()));

  useEffect(() => {
    let live = true;
    fetchDownloads()
      .then((m) => { if (live) setManifest(m); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  // Correct the Apple-silicon guess where the browser will actually say.
  useEffect(() => {
    if (os !== 'mac') return;
    let live = true;
    void refineMacArch().then((arch) => {
      if (!live || !arch) return;
      setPrimaryId(arch === 'x86' ? 'mac-x64' : 'mac-arm64');
    });
    return () => { live = false; };
  }, [os]);

  const primary = useMemo(
    () => manifest?.targets.find((t) => t.id === primaryId) ?? null,
    [manifest, primaryId],
  );

  /**
   * The other build for the same OS — an Intel Mac when we guessed Apple
   * silicon, and vice versa. Offered explicitly because client hints are
   * Chromium-only: on Safari the primary button is a guess, and a wrong guess
   * that takes 150 MB to discover deserves a visible escape hatch.
   */
  const sibling = useMemo(() => {
    if (!manifest || !primary || primary.os !== 'mac') return null;
    return manifest.targets.find((t) => t.os === 'mac' && t.id !== primary.id) ?? null;
  }, [manifest, primary]);

  const rest = useMemo(
    () => manifest?.targets.filter((t) => t.id !== primary?.id && t.id !== sibling?.id) ?? [],
    [manifest, primary, sibling],
  );

  return (
    <section id="download" className="scroll-mt-24 py-16">
      <div className="mb-8 max-w-2xl">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Get the desktop app</h2>
        <p className="mt-3 text-ink-400">
          The full orchestrator running locally, with your own keys and your files on your own disk.
          {manifest && (
            <> Version {manifest.version}, free and open source.</>
          )}
        </p>
      </div>

      {failed ? (
        // Degrades to exactly where this link used to point — worse, not broken.
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="glass inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-ink-100 hover:bg-elev/[0.08]"
        >
          <Download size={16} /> Downloads on GitHub <ExternalLink size={13} className="text-ink-500" />
        </a>
      ) : !manifest ? (
        // A pulsing placeholder is motion too. It was the one animation in here
        // that ignored the preference, which rather defeats honouring it in the
        // three that did.
        <div
          data-testid="download-skeleton"
          className={`h-[52px] w-64 rounded-xl bg-elev/[0.06] ${reduced ? '' : 'animate-pulse'}`}
          aria-hidden
        />
      ) : (
        <div className="max-w-2xl">
          {primary ? (
            <>
              <a
                href={downloadUrl(primary.id)}
                className="accent-grad inline-flex items-center gap-2.5 rounded-xl px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-accent-700/25 transition hover:brightness-110"
              >
                <Download size={17} />
                Download for {primary.label}
                <span className="font-normal opacity-70">
                  {primary.detail ? `· ${primary.detail}` : ''} {formatSize(primary.sizeBytes)}
                </span>
              </a>

              {sibling && (
                <p className="mt-3 text-sm text-ink-400">
                  On an {sibling.detail} Mac?{' '}
                  <a href={downloadUrl(sibling.id)} className="text-accent-300 underline-offset-2 hover:underline">
                    Download that build instead
                  </a>
                  .
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-400">Pick the build for your machine:</p>
          )}

          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="mt-4 inline-flex items-center gap-1.5 text-sm text-ink-400 transition hover:text-ink-100"
          >
            <ChevronDown
              size={15}
              style={{
                transform: showAll ? 'rotate(180deg)' : undefined,
                transition: reduced ? undefined : 'transform 200ms ease',
              }}
            />
            {showAll ? 'Hide other platforms' : `All platforms (${manifest.targets.length})`}
          </button>

          {showAll && (
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {[...(primary ? [primary] : []), ...(sibling ? [sibling] : []), ...rest].map((t) => (
                <TargetRow key={t.id} target={t} />
              ))}
            </ul>
          )}

          <p className="mt-5 text-xs text-ink-500">
            Also on npm — <code className="rounded bg-elev/[0.08] px-1.5 py-0.5 text-ink-300">npm i -g cascade-ai</code> for the CLI.
          </p>
        </div>
      )}
    </section>
  );
}

function TargetRow({ target }: { target: DownloadTarget }) {
  const Icon = OS_ICON[target.os];
  const color = target.os === 'mac' ? TIER_COLORS[0] : target.os === 'windows' ? TIER_COLORS[1] : TIER_COLORS[2];
  return (
    <li>
      <a
        href={downloadUrl(target.id)}
        className="glass flex items-center gap-3 rounded-xl px-3.5 py-3 transition hover:bg-elev/[0.08]"
      >
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ background: `${color}1F`, color }}
        >
          <Icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink-100">
            {target.label} <span className="text-ink-400">· {target.detail}</span>
          </span>
          {/* The filename, so what lands in ~/Downloads is identifiable. */}
          <span className="block truncate text-[11px] text-ink-500">{target.filename}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-ink-400">{formatSize(target.sizeBytes)}</span>
      </a>
    </li>
  );
}
