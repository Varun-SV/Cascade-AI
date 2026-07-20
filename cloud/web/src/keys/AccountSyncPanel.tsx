import { useState } from 'react';
import { Cloud, Loader2, UploadCloud, DownloadCloud } from 'lucide-react';
import type { ProviderConfig, WebSearchSettings } from '../lib/types.js';
import { decryptJSON, encryptJSON, type EncryptedBlob } from './crypto.js';
import { pullKeySync, pushKeySync } from '../lib/api.js';

// The portable subset the web contributes to the shared sync bundle. Field names
// match the SDK's SyncBundle, so a blob written here decrypts on the CLI/desktop
// (and vice-versa). See docs/key-sync.md.
interface WebSyncBundle {
  v: 1;
  providers?: ProviderConfig[];
  webSearch?: { braveApiKey?: string; tavilyApiKey?: string; searxngUrl?: string };
}

interface Props {
  keys: ProviderConfig[];
  webSearch: WebSearchSettings | null;
  onRestoreKeys: (keys: ProviderConfig[]) => void;
  onRestoreWebSearch: (s: WebSearchSettings | null) => void;
}

/** Identity of a provider entry, so a re-sync updates rather than duplicates it. */
function providerSig(p: ProviderConfig): string {
  return [p.type, p.baseUrl ?? '', p.deploymentName ?? '', p.label ?? ''].join(' ');
}

/** Union local + incoming providers; incoming wins, local-only entries survive. */
function mergeProviders(local: ProviderConfig[], incoming: ProviderConfig[]): ProviderConfig[] {
  const map = new Map<string, ProviderConfig>();
  for (const l of local) map.set(providerSig(l), l);
  for (const i of incoming) map.set(providerSig(i), i);
  return [...map.values()];
}

/** Rebuild the web's `backend` discriminator from whichever key is present. */
function toWebSearch(ws: WebSyncBundle['webSearch']): WebSearchSettings | null {
  if (!ws || (!ws.braveApiKey && !ws.tavilyApiKey && !ws.searxngUrl)) return null;
  const backend: WebSearchSettings['backend'] = ws.searxngUrl ? 'searxng' : ws.tavilyApiKey ? 'tavily' : 'brave';
  return { backend, braveApiKey: ws.braveApiKey, tavilyApiKey: ws.tavilyApiKey, searxngUrl: ws.searxngUrl };
}

function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function AccountSyncPanel({ keys, webSearch, onRestoreKeys, onRestoreWebSearch }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState<'push' | 'pull' | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function handlePush() {
    if (!passphrase) { setStatus('Enter a passphrase first.'); return; }
    setBusy('push');
    setStatus(null);
    try {
      const bundle: WebSyncBundle = { v: 1, providers: keys };
      if (webSearch) bundle.webSearch = { braveApiKey: webSearch.braveApiKey, tavilyApiKey: webSearch.tavilyApiKey, searxngUrl: webSearch.searxngUrl };
      const blob = await encryptJSON(bundle, passphrase);
      const r = await pushKeySync(blob);
      setStatus(`Synced to your account (v${r.version}).`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setBusy(null);
    }
  }

  async function handlePull() {
    if (!passphrase) { setStatus('Enter a passphrase first.'); return; }
    setBusy('pull');
    setStatus(null);
    try {
      const { blob, updatedAt } = await pullKeySync();
      if (!blob) { setStatus('Nothing synced to your account yet.'); return; }
      const bundle = await decryptJSON<WebSyncBundle>(blob as EncryptedBlob, passphrase);
      if (bundle.providers) onRestoreKeys(mergeProviders(keys, bundle.providers));
      if (bundle.webSearch) onRestoreWebSearch(toWebSearch(bundle.webSearch));
      setStatus(`Restored from your account${updatedAt ? ` (synced ${relativeTime(updatedAt)})` : ''}.`);
    } catch {
      // AES-GCM's auth-tag check is what fails on a wrong passphrase — say so
      // plainly rather than surfacing a raw WebCrypto "OperationError".
      setStatus('Could not restore — check your passphrase and try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-elev/10 p-3">
      <div className="mb-2 flex items-start gap-2 text-xs text-ink-300">
        <Cloud size={14} className="mt-0.5 shrink-0 text-ink-400" />
        <span>
          Sync your keys across web, desktop &amp; CLI through your Cascade account. They're encrypted with a
          passphrase only you know before they leave this device — we store only ciphertext we can't read.
        </span>
      </div>
      <input
        type="password"
        className="mb-2 w-full rounded border border-elev/10 bg-elev/[0.04] px-2 py-1.5 text-sm text-ink-100"
        placeholder="Passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={handlePush}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent-600 px-3 py-1.5 text-xs text-white hover:bg-accent-500 disabled:opacity-50"
        >
          {busy === 'push' ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />} Push
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={handlePull}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-elev/10 px-3 py-1.5 text-xs text-ink-200 hover:bg-elev/[0.05] disabled:opacity-50"
        >
          {busy === 'pull' ? <Loader2 size={14} className="animate-spin" /> : <DownloadCloud size={14} />} Pull
        </button>
      </div>
      {status && <p className="mt-2 text-xs text-ink-400">{status}</p>}
    </div>
  );
}
