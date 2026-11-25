import { useCallback, useEffect, useState } from 'react';
import { Check, Laptop, Pencil, Puzzle, Terminal, X } from 'lucide-react';
import {
  fetchRelayDevices, fetchWorkspaceDevices, removeRelayDevice, renameRelayDevice,
  type RelayDevice, type RelayFamily, type WorkspaceDevice,
} from '../lib/api.js';
import { toast } from '../lib/toast.js';

type Kind = RelayDevice['kind'];

const KINDS: Record<Kind, { label: string; icon: typeof Laptop }> = {
  desktop: { label: 'Desktop app', icon: Laptop },
  cli: { label: 'Cascade CLI', icon: Terminal },
  extension: { label: 'Chrome extension', icon: Puzzle },
};

/** One paired device, with what each relay says about it. */
export interface EnvironmentRow {
  id: string;
  name: string;
  kind: Kind;
  lastSeenAt: number | null;
  /** Present when this server runs the browser relay: whether the device is connected to it. */
  browser?: { online: boolean };
  /** Present when this server's workspace relay accepts this device: whether it is serving folders now. */
  workspace?: { online: boolean };
}

/**
 * The browser relay's list is every paired device; the workspace relay's is the ones that
 * can serve a folder. A device on both lists is one row. With the browser relay off, the
 * workspace list is all there is (an older server's lacks `kind`, and only desktops serve).
 */
export function mergeDevices(browser: readonly RelayDevice[] | null, workspace: readonly WorkspaceDevice[] | null): EnvironmentRow[] {
  const rows = new Map<string, EnvironmentRow>();
  for (const d of browser ?? []) {
    rows.set(d.id, { id: d.id, name: d.name, kind: d.kind, lastSeenAt: d.lastSeenAt, browser: { online: d.online } });
  }
  for (const d of workspace ?? []) {
    const row = rows.get(d.id) ?? { id: d.id, name: d.name, kind: d.kind ?? 'desktop', lastSeenAt: d.lastSeenAt ?? null };
    row.workspace = { online: d.online };
    rows.set(d.id, row);
  }
  return [...rows.values()];
}

const isOnline = (r: EnvironmentRow) => Boolean(r.browser?.online || r.workspace?.online);

function seen(r: EnvironmentRow, now: number): string {
  if (isOnline(r)) return 'Online now';
  if (!r.lastSeenAt) return 'Never connected';
  const mins = Math.round((now - r.lastSeenAt) / 60_000);
  if (mins < 60) return `Last seen ${Math.max(1, mins)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `Last seen ${hours} h ago`;
  return `Last seen ${new Date(r.lastSeenAt).toLocaleDateString()}`;
}

const code = (text: string) => <code className="rounded bg-sunk px-1">{text}</code>;
const docLink = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-500 underline">{text}</a>
);

function Capability({ label, online, title }: { label: string; online: boolean; title: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-full bg-sunk px-2 py-px text-[11.5px] text-ink-300">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-ink-500'}`} />
      {label}
    </span>
  );
}

/**
 * Settings → Environments: every device the user paired (the desktop app, the CLI, the
 * Chrome extension), whether it is online, and what the server can use it for.
 *
 * Pairing happens on the device itself, never here: a page can't make a computer a device.
 * Here the user sees what is paired, renames it, and removes it, which also ends a run it
 * is serving. Which lists are read follows what the server has on: the browser relay's
 * (every device) and the workspace relay's (the ones that can serve a folder).
 */
export default function EnvironmentsSettings({ browserRelay, workspaceRelay, now = Date.now }: {
  browserRelay: boolean;
  workspaceRelay: boolean;
  now?: () => number;
}) {
  const [rows, setRows] = useState<EnvironmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  // The browser relay's routes work for every device and also end a workspace; the workspace
  // relay's are only for a server that has no browser relay.
  const family: RelayFamily = browserRelay ? 'browser' : 'workspace';
  const anyRelay = browserRelay || workspaceRelay;

  const load = useCallback(async () => {
    if (!anyRelay) { setRows([]); return; }
    const [browser, workspace] = await Promise.allSettled([
      browserRelay ? fetchRelayDevices() : Promise.resolve(null),
      workspaceRelay ? fetchWorkspaceDevices().then((r) => r.devices) : Promise.resolve(null),
    ]);
    const failed = [browser, workspace].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    setError(failed ? (failed.reason instanceof Error ? failed.reason.message : 'Could not load your devices.') : null);
    setRows(mergeDevices(
      browser.status === 'fulfilled' ? browser.value : null,
      workspace.status === 'fulfilled' ? workspace.value : null,
    ));
  }, [anyRelay, browserRelay, workspaceRelay]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    setBusy(editing.id);
    try {
      await renameRelayDevice(editing.id, name, family);
      setEditing(null);
      toast('Device renamed');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename it.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(r: EnvironmentRow) {
    if (!window.confirm(`Remove “${r.name}”? Runs can't use it any more, and a run using it now stops.`)) return;
    setBusy(r.id);
    try {
      await removeRelayDevice(r.id, family);
      toast('Device removed');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove it.');
    } finally {
      setBusy(null);
    }
  }

  const t = now();
  const connect = (
    <section aria-labelledby="env-connect-heading">
      <h3 id="env-connect-heading" className="mb-1 text-[13px] font-semibold text-ink-100">Connect a device</h3>
      <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-snug text-ink-300">
        <li><strong className="font-medium text-ink-100">Desktop app:</strong> in the app, open Settings → Cloud runs and pair it with your account, then Settings → Workspaces to serve a folder.</li>
        <li>
          <strong className="font-medium text-ink-100">CLI:</strong> run {code('cascade login')}, then {code('cascade relay pair')}, and keep {code('cascade relay serve')} running for the browser.
          To let runs work in a folder, run {code('cascade workspace serve [folder]')} (options: {code('--tools read|edit|all')}, {code('--label device|folder')}, {code('--yes-read-only')}).
        </li>
        <li><strong className="font-medium text-ink-100">Chrome extension:</strong> install the Cascade extension, press its toolbar button and pair it with this server.</li>
      </ul>
      <p className="mt-1.5 text-[12.5px] text-ink-500">
        More in {docLink('/docs/workspaces', 'Workspaces')} and {docLink('/docs/browser-relay', 'Browser relay')}.
      </p>
    </section>
  );

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-snug text-ink-300">
        The devices you paired with your account. A run can work in a folder on one (a workspace) or use its browser, and only with your yes on that device.
      </p>

      {!anyRelay && (
        <div role="note" className="space-y-1 rounded-[10px] bg-sunk/60 px-3 py-2.5 text-[12.5px] leading-snug text-ink-300">
          <p className="m-0">This server has workspaces and the browser relay turned off, so there is nothing to connect here. Runs work in the Cloud only.</p>
          <p className="m-0 text-ink-500">
            Running your own server? Set {code('WORKSPACE_RELAY')} and {code('BROWSER_RELAY')} on it. See {docLink('/docs/workspaces', 'Workspaces')} and {docLink('/docs/browser-relay', 'Browser relay')}.
          </p>
        </div>
      )}
      {anyRelay && !workspaceRelay && (
        <p className="text-[12.5px] leading-snug text-ink-500">Workspaces are off on this server, so a device can&apos;t serve a folder for a run. Browser use is on.</p>
      )}
      {anyRelay && !browserRelay && (
        <p className="text-[12.5px] leading-snug text-ink-500">The browser relay is off on this server, so a run can&apos;t use a device&apos;s browser, and a new device can&apos;t be paired.</p>
      )}

      {anyRelay && (
        <section aria-labelledby="env-devices-heading">
          <h3 id="env-devices-heading" className="mb-1 text-[13px] font-semibold text-ink-100">Your devices</h3>
          {error && <p role="alert" className="text-[12.5px] text-red-400">{error}</p>}
          {rows === null && !error && <p className="text-[12.5px] text-ink-500">Loading…</p>}
          {rows?.length === 0 && !error && <p className="text-[12.5px] text-ink-500">No devices yet. Connect one below.</p>}
          {rows && rows.length > 0 && (
            <ul className="divide-y divide-elev/10">
              {rows.map((r) => {
                const { icon: Icon, label } = KINDS[r.kind] ?? KINDS.desktop;
                const editingThis = editing?.id === r.id;
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                    <Icon size={17} aria-hidden className="shrink-0 text-ink-300" />
                    <div className="min-w-0 flex-1 basis-[11rem]">
                      {editingThis ? (
                        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex items-center gap-1.5">
                          <label htmlFor={`env-name-${r.id}`} className="sr-only">Device name</label>
                          <input
                            id={`env-name-${r.id}`} autoFocus value={editing.name} maxLength={80} spellCheck={false}
                            onChange={(e) => setEditing({ id: r.id, name: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
                            className="cz-field h-[30px] min-w-0 flex-1 text-[14px]"
                          />
                          <button type="submit" aria-label="Save name" disabled={busy === r.id || !editing.name.trim()} className="cz-ib cz-ib-sm"><Check size={15} /></button>
                          <button type="button" aria-label="Cancel rename" onClick={() => setEditing(null)} className="cz-ib cz-ib-sm"><X size={15} /></button>
                        </form>
                      ) : (
                        <div className="truncate text-[14px] text-ink-50">{r.name}</div>
                      )}
                      <div className="flex items-center gap-1.5 text-[12px] text-ink-500">
                        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${isOnline(r) ? 'bg-emerald-500' : 'bg-ink-500'}`} />
                        {label} · {seen(r, t)}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {r.workspace && <Capability label="Workspace" online={r.workspace.online} title={r.workspace.online ? 'Serving folders now' : 'Not serving folders right now'} />}
                        {r.browser && <Capability label="Browser" online={r.browser.online} title={r.browser.online ? 'Connected for browser runs' : 'Not connected for browser runs'} />}
                      </div>
                    </div>
                    {!editingThis && (
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button" aria-label={`Rename ${r.name}`} title="Rename" disabled={busy === r.id}
                          onClick={() => setEditing({ id: r.id, name: r.name })} className="cz-btn cz-btn-ghost cz-btn-sm"
                        >
                          <Pencil size={13} /> Rename
                        </button>
                        <button
                          type="button" aria-label={`Remove ${r.name}`} disabled={busy === r.id}
                          onClick={() => void remove(r)} className="cz-btn cz-btn-ghost cz-btn-sm"
                        >
                          {busy === r.id ? 'Working…' : 'Remove'}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {anyRelay && connect}
    </div>
  );
}
