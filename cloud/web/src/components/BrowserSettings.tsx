import { useEffect, useState } from 'react';
import Segmented from './Segmented.js';
import BrowserDevices from './BrowserDevices.js';
import {
  fetchBrowserPrefs, removeBrowserEndpoint, saveBrowserEndpoint, setBrowserSource,
  type BrowserPrefs, type BrowserSource,
} from '../lib/api.js';

const LABEL: Record<BrowserSource, string> = { device: 'My devices', endpoint: 'My CDP endpoint', desktop: 'Run on my desktop' };

/**
 * Settings → Browser: where runs that use the Browser switch get one. The user's own
 * devices through the relay, their own CDP endpoint, or their desktop app, which the
 * chat is handed to. Whatever is chosen, it's the user's own browser.
 */
export default function BrowserSettings({ onChange }: { onChange?: (prefs: BrowserPrefs) => void }) {
  const [prefs, setPrefs] = useState<BrowserPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const apply = (p: BrowserPrefs) => { setPrefs(p); setError(null); onChange?.(p); };
  useEffect(() => {
    fetchBrowserPrefs().then(apply, (e: unknown) => setError(e instanceof Error ? e.message : 'Could not load your browser settings.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!prefs) {
    return error ? <p role="alert" className="text-[12.5px] text-red-400">{error}</p> : <p className="text-[12.5px] text-ink-500">Loading…</p>;
  }
  const sources = (['device', 'endpoint', 'desktop'] as const).filter((s) => prefs.offers[s]);
  const choose = (s: BrowserSource) => { setBrowserSource(s).then(apply, (e: unknown) => setError(e instanceof Error ? e.message : 'Could not change it.')); };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      apply(await saveBrowserEndpoint(url));
      setUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save it.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {sources.length > 1 && (
        <Segmented label="Where runs get a browser" value={prefs.source} onChange={choose} options={sources.map((s) => ({ value: s, label: LABEL[s] }))} />
      )}
      {error && <p role="alert" className="text-[12.5px] text-red-400">{error}</p>}

      {prefs.source === 'endpoint' && (
        <section aria-labelledby="browser-endpoint-heading" className="space-y-2">
          <h3 id="browser-endpoint-heading" className="text-[13px] font-semibold text-ink-100">Your CDP endpoint</h3>
          <p className="text-[12.5px] leading-snug text-ink-300">
            A browser you run yourself: Steel, Browserless or a Chrome, by its WebSocket connect address. Runs browse in it as they
            would in any browser, with the usual approvals before paying, deleting or sending. It isn't policed by Cascade, so use one
            meant for it, not the browser you sign in with.
          </p>
          {prefs.endpoint ? (
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink-50">{prefs.endpoint.host}</span>
              <button type="button" className="cz-btn cz-btn-ghost cz-btn-sm" onClick={() => { removeBrowserEndpoint().then(apply, () => setError('Could not remove it.')); }}>
                Remove
              </button>
            </div>
          ) : (
            <form onSubmit={(e) => void save(e)} className="flex flex-wrap gap-2">
              <label htmlFor="browser-endpoint-url" className="sr-only">Connect address</label>
              <input
                id="browser-endpoint-url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off"
                placeholder={prefs.privateEndpoints ? 'wss:// or ws:// address' : 'wss://…'}
                className="cz-field h-[34px] min-w-0 flex-1 text-[14px]"
              />
              <button type="submit" disabled={saving || !url.trim()} className="cz-btn cz-btn-sm">{saving ? 'Saving…' : 'Save'}</button>
            </form>
          )}
          <p className="text-[12px] text-ink-500">
            Stored encrypted and shown back only as its host. {prefs.privateEndpoints ? '' : 'Only public addresses: this server doesn\'t connect into private networks.'}
          </p>
        </section>
      )}

      {prefs.source === 'desktop' && (
        <p className="text-[12.5px] leading-snug text-ink-300">
          When a message needs the browser, this chat is handed to the Cascade desktop app with a one-time code, and the run
          happens there, in the app&apos;s own browser. Its reply comes back to this chat when the app syncs.
        </p>
      )}

      {prefs.source === 'device' && prefs.offers.device && <BrowserDevices />}
    </div>
  );
}
