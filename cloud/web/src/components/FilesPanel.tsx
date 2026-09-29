import { useEffect, useState, useCallback } from 'react';
import { X, Download, Trash2, Loader2, Folder, Eye } from 'lucide-react';
import { fetchFiles, deleteFile, fileDownloadUrl, fetchFileText, type CloudFile } from '../lib/api.js';
import FileViewerModal from './FileViewerModal.js';
import { fileKind, fileExt } from '../lib/fileKind.js';

// Kinds we preview from the served URL rather than by fetching text: images,
// PDFs (iframe), and Office binaries (download prompt).
const BINARY_EXTS = new Set(['xlsx', 'docx', 'pptx']);
function isBinaryPreview(f: CloudFile): boolean {
  const k = fileKind(f.name, f.mime);
  return k === 'image' || k === 'pdf' || BINARY_EXTS.has(fileExt(f.name));
}

// Office's own colours, as on the file cards in a reply.
const FILE_ICON_BG: Record<string, string> = { docx: '#2B579A', pptx: '#C43E1C', xlsx: '#107C41', pdf: '#B30B00' };

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
    setViewText(null);
    if (isBinaryPreview(f)) return; // shown by URL, no text fetch
    try { setViewText(await fetchFileText(f.id)); } catch { setViewText(''); }
  }, []);

  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const nearFull = pct >= 90;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <aside
        aria-label="Files"
        className="relative flex h-full w-full max-w-[480px] flex-col border-l border-elev/10 bg-side shadow-[var(--glass-shadow-strong)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-elev/10 px-3">
          <Folder size={15} className="text-ink-300" />
          <b className="flex-1 font-medium text-ink-50">Files</b>
          <button type="button" onClick={onClose} aria-label="Close" className="cz-ib cz-ib-sm"><X size={14} /></button>
        </div>

        <div className="border-b border-elev/10 px-[18px] py-3">
          <div className="mb-1.5 flex items-center justify-between text-[12px] text-ink-500">
            <span>{formatBytes(used)} of {formatBytes(limit)}</span>
            <span className="uppercase">{plan}</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-sunk">
            <div className={`h-full rounded-full ${nearFull ? 'bg-danger-500' : 'bg-accent-500'}`} style={{ width: `${pct}%` }} />
          </div>
          {nearFull && (
            <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-danger-300">
              <span>Storage {pct >= 100 ? 'full' : 'almost full'} — delete files{plan !== 'pro' ? ' or upgrade' : ''}.</span>
              {plan !== 'pro' && onUpgrade && (
                <button type="button" onClick={onUpgrade} className="cz-btn cz-btn-sm">Upgrade</button>
              )}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-[18px]">
          {loading ? (
            <div className="flex items-center gap-2 p-3 text-xs text-ink-400"><Loader2 size={13} className="animate-spin" /> Loading…</div>
          ) : files.length === 0 ? (
            <p className="m-0 text-[13px] text-ink-500">
              No saved files yet. When Cascade generates a file, use <b className="text-ink-300">Save</b> on the card to keep it here.
            </p>
          ) : (
            <div className="flex flex-col">
              {files.map((f) => {
                const ext = fileExt(f.name);
                return (
                  <div key={f.id} className="flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-elev/[0.05]">
                    <span
                      aria-hidden="true"
                      className="flex h-[30px] w-[26px] shrink-0 items-end justify-center rounded pb-[3px] font-mono text-[7px] font-semibold uppercase text-white"
                      style={{ background: FILE_ICON_BG[ext] ?? '#57606A' }}
                    >
                      {(ext || 'file').slice(0, 4)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] text-ink-50">{f.name}</div>
                      <div className="text-[12px] text-ink-500">{formatBytes(f.size)} · {new Date(f.createdAt).toLocaleDateString()}</div>
                    </div>
                    <button type="button" onClick={() => void openViewer(f)} className="cz-ib cz-ib-sm" aria-label="Open" title="Open"><Eye size={14} /></button>
                    <a href={fileDownloadUrl(f.id)} className="cz-ib cz-ib-sm" aria-label="Download" title="Download" download><Download size={14} /></a>
                    <button type="button" onClick={() => remove(f.id)} className="cz-ib cz-ib-sm" aria-label="Delete" title="Delete"><Trash2 size={14} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {viewing && (
        // Stop viewer clicks from bubbling to the panel backdrop (which closes it).
        <div onClick={(e) => e.stopPropagation()}>
          <FileViewerModal
            name={viewing.name}
            mime={viewing.mime}
            content={isBinaryPreview(viewing) ? undefined : (viewText ?? '')}
            src={isBinaryPreview(viewing) ? fileDownloadUrl(viewing.id) : undefined}
            onClose={() => { setViewing(null); setViewText(null); }}
          />
        </div>
      )}
    </div>
  );
}
