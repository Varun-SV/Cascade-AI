import { useState } from 'react';
import { Cloud, Loader2 } from 'lucide-react';
import type { ProviderConfig } from '../lib/types.js';
import { decryptJSON, encryptJSON, type EncryptedBlob } from './crypto.js';
import { downloadFromAppData, requestDriveAccessToken, uploadToAppData } from './googleDrive.js';

interface Props {
  googleClientId: string;
  keys: ProviderConfig[];
  onRestore: (keys: ProviderConfig[]) => void;
}

export default function DriveSyncPanel({ googleClientId, keys, onRestore }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState<'upload' | 'download' | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function handleUpload() {
    if (!passphrase) { setStatus('Enter a passphrase first.'); return; }
    setBusy('upload');
    setStatus(null);
    try {
      const token = await requestDriveAccessToken(googleClientId);
      const blob = await encryptJSON(keys, passphrase);
      await uploadToAppData(token, JSON.stringify(blob));
      setStatus('Synced to Google Drive.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setBusy(null);
    }
  }

  async function handleDownload() {
    if (!passphrase) { setStatus('Enter a passphrase first.'); return; }
    setBusy('download');
    setStatus(null);
    try {
      const token = await requestDriveAccessToken(googleClientId);
      const raw = await downloadFromAppData(token);
      if (!raw) { setStatus('No synced keys found in Drive yet.'); return; }
      const blob = JSON.parse(raw) as EncryptedBlob;
      const restored = await decryptJSON<ProviderConfig[]>(blob, passphrase);
      onRestore(restored);
      setStatus('Restored from Google Drive.');
    } catch {
      // AES-GCM's auth-tag check is what actually fails on a wrong
      // passphrase — surface a plain-language reason rather than a raw
      // "OperationError" from WebCrypto.
      setStatus('Could not restore — check your passphrase and try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-cascade-800 p-3">
      <div className="mb-2 flex items-start gap-2 text-xs text-cascade-300">
        <Cloud size={14} className="mt-0.5 shrink-0 text-cascade-400" />
        <span>
          Sync your keys across devices via Google Drive. They're encrypted with a passphrase only you
          know before upload — we never see the passphrase, the keys, or the decrypted file.
        </span>
      </div>
      <input
        type="password"
        className="mb-2 w-full rounded bg-cascade-950 px-2 py-1.5 text-sm"
        placeholder="Passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={handleUpload}
          className="flex-1 rounded-md bg-cascade-700 px-3 py-1.5 text-xs text-white hover:bg-cascade-600 disabled:opacity-50"
        >
          {busy === 'upload' ? <Loader2 size={14} className="mx-auto animate-spin" /> : 'Upload'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={handleDownload}
          className="flex-1 rounded-md border border-cascade-700 px-3 py-1.5 text-xs text-cascade-200 hover:bg-cascade-900 disabled:opacity-50"
        >
          {busy === 'download' ? <Loader2 size={14} className="mx-auto animate-spin" /> : 'Restore'}
        </button>
      </div>
      {status && <p className="mt-2 text-xs text-cascade-400">{status}</p>}
    </div>
  );
}
