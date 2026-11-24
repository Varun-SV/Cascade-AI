import { useEffect, useState, type CSSProperties } from 'react';
import { FileQuestion } from 'lucide-react';
import type { FileKind } from '../lib/file-kind.js';

interface Props { path: string; kind: Exclude<FileKind, 'text'>; mime: string | null; size: number }

const baseName = (p: string) => p.split(/[/\\]/).pop() ?? p;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const center: CSSProperties = { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, padding: 24, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' };
const btn: CSSProperties = { padding: '7px 14px', background: 'var(--bg-raised)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' };

export function FilePreview({ path, kind, mime, size }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const name = baseName(path);
  const showable = kind !== 'binary' && mime !== null;

  useEffect(() => {
    if (!showable || !window.cascade) return;
    let cancelled = false;
    let blobUrl: string | null = null;
    setSrc(null); setError(null); setDims(null);
    (async () => {
      try {
        const res = await window.cascade!.fs.readFileDataUrl(path, mime!);
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error === 'too-large'
            ? `This file is too large to preview here (${formatBytes(size)}; the limit is ${formatBytes(res.limit ?? 0)}).`
            : `This file can't be previewed (${res.error}).`);
          return;
        }
        // A blob URL keeps big media seekable and works with the PDF viewer.
        const blob = await (await fetch(res.url)).blob();
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch (e) {
        if (!cancelled) setError(`Couldn't read this file: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [path, mime, showable, size]);

  const placeholder = (message: string) => (
    <div style={center}>
      <FileQuestion size={34} style={{ color: 'var(--text-dim)' }} />
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>This file can't be shown here</div>
      <div>{name} · {formatBytes(size)}</div>
      {message && <div style={{ maxWidth: 380, lineHeight: 1.5 }}>{message}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button style={btn} onClick={() => { void window.cascade?.fs.openPath(path); }}>Open in default app</button>
        <button style={btn} onClick={() => { void window.cascade?.fs.showInFolder(path); }}>Show in folder</button>
      </div>
    </div>
  );

  if (!showable) return placeholder('');
  if (error) return placeholder(error);
  if (!src) return <div style={center}>Loading…</div>;

  if (kind === 'pdf') {
    return <iframe src={src} title={name} style={{ width: '100%', height: '100%', border: 0, background: 'var(--bg-base)' }} />;
  }

  if (kind === 'image') {
    const checker = 'repeating-conic-gradient(var(--bg-raised) 0% 25%, var(--bg-surface) 0% 50%) 50% / 16px 16px';
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflow: 'hidden' }}>
          <img src={src} alt={name}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', background: checker, border: '1px solid var(--border)' }} />
        </div>
        <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {dims ? `${dims.w} × ${dims.h} px · ` : ''}{formatBytes(size)}
        </div>
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div style={center}>
        <div style={{ color: 'var(--text)', fontWeight: 600 }}>{name}</div>
        <audio src={src} controls style={{ width: 'min(480px, 90%)' }} />
        <div style={{ fontSize: 11 }}>{formatBytes(size)}</div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#000' }}>
      <video src={src} controls style={{ flex: 1, minHeight: 0, width: '100%', objectFit: 'contain' }}
        onError={() => setError("This video format isn't supported by the built-in player.")} />
      <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-surface)' }}>{name} · {formatBytes(size)}</div>
    </div>
  );
}
