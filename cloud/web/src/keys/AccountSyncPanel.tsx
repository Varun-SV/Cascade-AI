import { useState } from 'react';
import { Cloud, Loader2, UploadCloud, DownloadCloud } from 'lucide-react';
import type { ProviderConfig, WebSearchSettings } from '../lib/types.js';
import { stripRetiredProviders } from '../lib/retired-providers.js';
import { describeRevokedRemoval, stripRevokedCredentials } from '../lib/revoked-credentials.js';
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

/**
 * Union local + incoming providers; incoming wins, local-only entries survive.
 *
 * The incoming half is filtered for retired provider types. A sync bundle is
 * a snapshot of whatever the vault held when it was uploaded, so a restore
 * from before a provider was retired would otherwise reintroduce the dead
 * entry into a vault that had already been migrated — and keep doing it on
 * every restore, which reads as the cleanup not working.
 *
 * …and for dead Claude subscription credentials, for the same reason and with
 * more at stake. The CLI and desktop filter those in the SDK's applySyncBundle;
 * this merge is the browser's own and goes nowhere near it, so a pre-0.75
 * bundle pulled here kept a row the web cannot use — `authToken` is not even a
 * field it sends — and let that row overwrite a perfectly good local API key,
 * ready to be pushed back on the next sync.
 */
export function mergeProviders(
  local: ProviderConfig[],
  incoming: ProviderConfig[],
): { merged: ProviderConfig[]; removed: string[]; revoked: number; unusable: string[] } {
  const map = new Map<string, ProviderConfig>();
  for (const l of local) map.set(providerSig(l), l);
  const { kept: live, removed } = stripRetiredProviders(incoming);
  const { kept, removed: revoked } = stripRevokedCredentials(live);
  const unusable: string[] = [];
  for (const i of kept) {
    // The browser can only USE `apiKey` — its ProviderConfig has no bearer
    // field and neither does the hosted run schema — so an incoming row
    // carrying only a gateway `authToken` is a valid credential elsewhere and
    // no credential here.
    const prior = map.get(providerSig(i));
    if (!i.apiKey) {
      if (prior?.apiKey) {
        // Keep the local key rather than letting the bearer row displace it.
        // That overwrote a working browser key with something unusable and
        // persisted it, leaving the next chat with nothing.
        map.set(providerSig(i), { ...i, apiKey: prior.apiKey });
        continue;
      }
      // Nothing local to fall back on, so this row would enter the vault with
      // no credential the browser can send. It is not harmless: KeyVault shows
      // it as a configured provider and useChatSession puts it in `providers`,
      // where the hosted ChatRunPayloadSchema — which has no `authToken` field
      // — strips the bearer and the server receives a keyless Anthropic
      // provider. The restore reported success for a credential that cannot
      // run here. Dropped instead, and named in the notice.
      //
      // Consequence, deliberately accepted: a bundle pulled and later re-pushed
      // FROM the browser no longer carries that row. Keeping a gateway bearer
      // in localStorage where nothing can ever use it is storage risk with no
      // benefit, and the notice tells the user to keep managing it from the
      // desktop or CLI, which do support bearers.
      unusable.push(i.type);
      continue;
    }
    map.set(providerSig(i), i);
  }
  // `removed` is returned rather than dropped so the restore can SAY a synced
  // key was skipped. The CLI and desktop pull paths both explain it; the
  // browser staying silent would be the one surface where a key disappears
  // with no reason given.
  return { merged: [...map.values()], removed, revoked, unusable };
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
      let skippedProviders: string[] = [];
      let revokedCount = 0;
      let unusableHere: string[] = [];
      if (bundle.providers) {
        const { merged, removed, revoked, unusable } = mergeProviders(keys, bundle.providers);
        skippedProviders = removed;
        revokedCount = revoked;
        unusableHere = unusable;
        onRestoreKeys(merged);
      }
      if (bundle.webSearch) onRestoreWebSearch(toWebSearch(bundle.webSearch));
      const skippedNote = skippedProviders.length
        ? ` Skipped ${skippedProviders.join(', ')} — no longer supported.`
        : '';
      // Named separately from "no longer supported": the PROVIDER is fine, the
      // credential is the problem, and the two ask different things of the user.
      const revokedNote = revokedCount ? ` ${describeRevokedRemoval()}` : '';
      // A third, distinct case: the provider is supported and the credential is
      // live — it just cannot be used from a browser, which can only send an
      // API key. Saying which one, and where it still works, is the difference
      // between a missing provider and a mystery.
      const unusableNote = unusableHere.length
        ? ` Skipped ${[...new Set(unusableHere)].join(', ')} — a gateway token can't be used from the browser;`
          + ' keep using it from the desktop app or CLI.'
        : '';
      setStatus(`Restored from your account${updatedAt ? ` (synced ${relativeTime(updatedAt)})` : ''}.${skippedNote}${revokedNote}${unusableNote}`);
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
