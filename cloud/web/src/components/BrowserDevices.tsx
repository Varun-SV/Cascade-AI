import { useCallback, useEffect, useState } from 'react';
import { fetchRelayDevices, removeRelayDevice, type RelayDevice } from '../lib/api.js';

const KIND: Record<RelayDevice['kind'], string> = {
  extension: 'Chrome extension',
  cli: 'Computer (Cascade CLI)',
  desktop: 'Desktop app',
};

function seen(d: RelayDevice, now: number): string {
  if (d.online) return 'Online now';
  if (!d.lastSeenAt) return 'Never connected';
  const mins = Math.round((now - d.lastSeenAt) / 60_000);
  if (mins < 60) return `Last seen ${Math.max(1, mins)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Last seen ${hours} h ago`;
  return `Last seen ${new Date(d.lastSeenAt).toLocaleDateString()}`;
}

/**
 * Settings → Browser: the user's own browsers that runs can ask for.
 *
 * Pairing happens on the device itself (the extension's toolbar button, or
 * `cascade relay pair`), never from here: a page can't make a browser a device.
 * Here the user sees what is paired and can remove it, which also ends any run
 * it is serving.
 */
export default function BrowserDevices({ now = Date.now }: { now?: () => number }) {
  const [devices, setDevices] = useState<RelayDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await fetchRelayDevices());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your devices.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function remove(d: RelayDevice) {
    if (!window.confirm(`Remove “${d.name}”? Runs can't ask it for a browser any more, and a run using it now stops.`)) return;
    setRemoving(d.id);
    try {
      await removeRelayDevice(d.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove it.');
    } finally {
      setRemoving(null);
    }
  }

  const t = now();
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-snug text-ink-300">
        Runs that use the Browser switch open a window in one of your own browsers, on sites you allow each time.
        Nothing runs without your yes on that device.
      </p>

      <section aria-labelledby="browser-devices-heading">
        <h3 id="browser-devices-heading" className="mb-1 text-[13px] font-semibold text-ink-100">Your devices</h3>
        {error && <p role="alert" className="text-[12.5px] text-red-400">{error}</p>}
        {devices === null && !error && <p className="text-[12.5px] text-ink-500">Loading…</p>}
        {devices?.length === 0 && (
          <p className="text-[12.5px] text-ink-500">No devices yet. Pair one below.</p>
        )}
        {devices && devices.length > 0 && (
          <ul className="divide-y divide-elev/10">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-2">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${d.online ? 'bg-emerald-500' : 'bg-ink-500'}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] text-ink-50">{d.name}</div>
                  <div className="text-[12px] text-ink-500">{KIND[d.kind] ?? d.kind} · {seen(d, t)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(d)}
                  disabled={removing === d.id}
                  aria-label={`Remove ${d.name}`}
                  className="cz-btn cz-btn-ghost cz-btn-sm"
                >
                  {removing === d.id ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="browser-pair-heading">
        <h3 id="browser-pair-heading" className="mb-1 text-[13px] font-semibold text-ink-100">Add one</h3>
        <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-snug text-ink-300">
          <li>Chrome: install the Cascade extension, press its toolbar button and pair it with this server. Runs get a window of their own in your Chrome, and sites you're signed in to see you signed in.</li>
          <li>A computer: run <code className="rounded bg-sunk px-1">cascade relay pair</code>, then <code className="rounded bg-sunk px-1">cascade relay serve</code>. Runs get a fresh browser with an empty profile.</li>
        </ul>
      </section>

      <section aria-labelledby="browser-egress-heading">
        <h3 id="browser-egress-heading" className="mb-1 text-[13px] font-semibold text-ink-100">What leaves your device during a run</h3>
        <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-snug text-ink-300">
          <li>The addresses, text and structure of pages in the run's window, and what the run types into them.</li>
          <li>No screenshots and no live picture: you watch and take over on the device itself.</li>
          <li>Pages on sites you didn't allow don't load in the run's window.</li>
        </ul>
      </section>
    </div>
  );
}
