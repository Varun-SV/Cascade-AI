import { useEffect, useState, useCallback } from 'react';
import { X, FileText, Download, Trash2, Loader2, HardDrive, Eye } from 'lucide-react';
import { fetchFiles, deleteFile, fileDownloadUrl, fetchFileText, type CloudFile } from '../lib/api.js';
import FileViewerModal from './FileViewerModal.js';
import { fileKind } from '../lib/fileKind.js';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Right-hand drawer listing your saved Cascade files: storage usage bar,
 * per-file download + delete, and an upgrade prompt at the free cap. Refreshes
 * when a message saves a new file (the `cascade:files-changed` event).
 */
export default function FilesPanel({ onClose, onUpgrade }: { onClose: () => void; onUpgrade?: () => void }) {
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [used, setUsed] = useState(0);
  const [limit, setLimit] = useState(0);
  const [plan, setPlan] = useState('free');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetchFiles();
      setFiles(r.files); setUsed(r.usedBytes); setLimit(r.limitBytes); setPlan(r.plan);
    } catch { /* not signed in / offline */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener('cascade:files-changed', onChanged);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('cascade:files-changed', onChanged); window.removeEventListener('keydown', onKey); };
  }, [load, onClose]);

  async function remove(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    try { const r = await deleteFile(id); setUsed(r.usedBytes); } catch { void load(); }
  }

  // The file being previewed. Images are shown by URL; text kinds are fetched.
  const [viewing, setViewing] = useState<CloudFile | null>(null);
  const [viewText, setViewText] = useState<string | null>(null);
  const openViewer = useCallback(async (f: CloudFile) => {
    setViewing(f);
    if (fileKind(f.name, f.mime) === 'image') { setViewText(null); return; }
    setViewText(null);
    try { setViewText(await fetchFileText(f.id)); } catch { setViewText(''); }
  }, []);

  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const nearFull = pct >= 90;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="glass relative flex h-full w-full max-w-sm flex-col border-l border-elev/10" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-elev/10 px-4 py-3">
          <HardDrive size={16} className="text-accent-300" />
          <span className="flex-1 text-sm font-semibold text-ink-100">Files</span>
          <button onClick={onClose} aria-label="Close" className="text-ink-500 hover:text-ink-200"><X size={16} /></button>
        </div>

        <div className="border-b border-elev/10 px-4 py-3">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-400">
            <span>{formatBytes(used)} of {formatBytes(limit)}</span>
            <span className="uppercase">{plan}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-elev/10">
            <div className={`h-full rounded-full ${nearFull ? 'bg-danger-500' : 'bg-accent-500'}`} style={{ width: `${pct}%` }} />
          </div>
          {nearFull && (
            <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-danger-300">
              <span>Storage {pct >= 100 ? 'full' : 'almost full'} — delete files{plan !== 'pro' ? ' or upgrade' : ''}.</span>
              {plan !== 'pro' && onUpgrade && (
                <button onClick={onUpgrade} className="rounded bg-accent-600 px-2 py-0.5 font-medium text-white hover:bg-accent-500">Upgrade</button>
              )}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex items-center gap-2 p-3 text-xs text-ink-400"><Loader2 size={13} className="animate-spin" /> Loading…</div>
          ) : files.length === 0 ? (
            <p className="p-4 text-center text-xs text-ink-500">
              No saved files yet. When Cascade generates a file, use <b className="text-ink-300">Save</b> on the card to keep it here.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {files.map((f) => (
                <div key={f.id} className="flex items-center gap-2.5 rounded-xl border border-elev/10 bg-elev/[0.04] px-3 py-2">
                  <FileText size={15} className="shrink-0 text-ink-300" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink-100">{f.name}</div>
                    <div className="text-[10.5px] text-ink-500">{formatBytes(f.size)} · {new Date(f.createdAt).toLocaleDateString()}</div>
                  </div>
                  <button onClick={() => void openViewer(f)} className="rounded-md p-1 text-ink-400 hover:bg-elev/[0.06] hover:text-ink-100" title="View"><Eye size={14} /></button>
                  <a href={fileDownloadUrl(f.id)} className="rounded-md p-1 text-ink-400 hover:bg-elev/[0.06] hover:text-ink-100" title="Download" download><Download size={14} /></a>
                  <button onClick={() => remove(f.id)} className="rounded-md p-1 text-ink-500 hover:bg-danger-500/10 hover:text-danger-300" title="Delete"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {viewing && (
        // Stop viewer clicks from bubbling to the panel backdrop (which closes it).
        <div onClick={(e) => e.stopPropagation()}>
          <FileViewerModal
            name={viewing.name}
            mime={viewing.mime}
            content={fileKind(viewing.name, viewing.mime) === 'image' ? undefined : (viewText ?? '')}
            src={fileKind(viewing.name, viewing.mime) === 'image' ? fileDownloadUrl(viewing.id) : undefined}
            onClose={() => { setViewing(null); setViewText(null); }}
          />
        </div>
      )}
    </div>
  );
}
