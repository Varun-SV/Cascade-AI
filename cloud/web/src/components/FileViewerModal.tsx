import { useEffect, useState } from 'react';
import { X, Download, Code2, Eye, Play, ShieldAlert } from 'lucide-react';
import Markdown from './Markdown.js';
import { fileKind, codeLanguage, parseDelimited, type FileKind } from '../lib/fileKind.js';

interface Props {
  name: string;
  mime?: string;
  /** Text content — for generated files and text-kind saved files. */
  content?: string;
  /** URL for binary/image saved files (served by /api/files/:id). */
  src?: string;
  onClose: () => void;
  /** Optional actions rendered in the header (e.g. Save to Cascade). */
  actions?: React.ReactNode;
}

const KIND_LABEL: Record<FileKind, string> = {
  markdown: 'Markdown', code: 'Code', csv: 'Table', html: 'HTML', svg: 'SVG', image: 'Image', text: 'Text',
};

/**
 * A modal that previews a generated/saved file by type: markdown (with the same
 * rich renderer as chat — math, mermaid, code), highlighted code, CSV as a table,
 * and HTML/SVG in a sandboxed iframe (scripts OFF by default, opt-in per view).
 * Untrusted content never touches the app DOM — HTML/SVG go through `srcdoc` in a
 * `sandbox`ed frame, and markdown does not render raw HTML.
 */
export default function FileViewerModal({ name, mime, content, src, onClose, actions }: Props) {
  const kind = fileKind(name, mime);
  const [showSource, setShowSource] = useState(false);
  const [runScripts, setRunScripts] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function download() {
    if (src) { const a = document.createElement('a'); a.href = src; a.download = name; a.click(); return; }
    const url = URL.createObjectURL(new Blob([content ?? ''], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="glass relative flex max-h-[88dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-elev/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-elev/10 px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-100" title={name}>{name}</span>
          <span className="shrink-0 rounded bg-elev/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
            {KIND_LABEL[kind]}
          </span>
          {(kind === 'html' || kind === 'svg') && (
            <button
              type="button"
              onClick={() => setShowSource((s) => !s)}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-elev/10 px-2 py-1 text-xs text-ink-300 hover:bg-elev/[0.06]"
            >
              {showSource ? <Eye size={12} /> : <Code2 size={12} />} {showSource ? 'Preview' : 'Source'}
            </button>
          )}
          {actions}
          <button
            type="button"
            onClick={download}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-elev/10 px-2 py-1 text-xs text-ink-300 hover:bg-elev/[0.06]"
          >
            <Download size={12} /> Download
          </button>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 text-ink-500 hover:text-ink-200">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <Body kind={kind} name={name} content={content} src={src} showSource={showSource} runScripts={runScripts} setRunScripts={setRunScripts} />
        </div>
      </div>
    </div>
  );
}

function Body({
  kind, name, content, src, showSource, runScripts, setRunScripts,
}: {
  kind: FileKind; name: string; content?: string; src?: string;
  showSource: boolean; runScripts: boolean; setRunScripts: (v: boolean) => void;
}) {
  if (kind === 'image' && src) {
    return <div className="flex justify-center p-4"><img src={src} alt={name} className="max-h-full max-w-full rounded-lg" /></div>;
  }

  const text = content ?? '';

  if (kind === 'markdown') {
    return <div className="prose prose-invert prose-sm max-w-none px-5 py-4 text-ink-100">{text ? <Markdown>{text}</Markdown> : <Empty />}</div>;
  }

  if (kind === 'csv') {
    const rows = parseDelimited(text, name);
    if (!rows.length) return <Empty />;
    const [head, ...body] = rows;
    return (
      <div className="overflow-auto p-4">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>{head!.map((c, i) => <th key={i} className="border border-elev/10 bg-elev/[0.06] px-2 py-1 text-left font-semibold text-ink-100">{c}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i} className="odd:bg-elev/[0.02]">{r.map((c, j) => <td key={j} className="border border-elev/10 px-2 py-1 text-ink-300">{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (kind === 'html' || kind === 'svg') {
    if (showSource) {
      return <div className="prose prose-invert prose-sm max-w-none px-5 py-4"><Markdown>{'```' + (kind === 'svg' ? 'xml' : 'html') + '\n' + text + '\n```'}</Markdown></div>;
    }
    // Sandboxed preview: no same-origin, scripts only when the user opts in per-view.
    const sandbox = runScripts ? 'allow-scripts' : '';
    return (
      <div className="flex h-full flex-col">
        {kind === 'html' && (
          <div className="flex items-center gap-2 border-b border-elev/10 bg-elev/[0.03] px-4 py-2 text-[11px] text-ink-400">
            <ShieldAlert size={13} className="text-warning-400" />
            <span className="flex-1">Sandboxed preview. Scripts are off — this file can't touch your account.</span>
            {!runScripts && (
              <button type="button" onClick={() => setRunScripts(true)} className="flex items-center gap-1 rounded-md border border-warning-500/30 px-2 py-0.5 text-warning-300 hover:bg-warning-500/10">
                <Play size={11} /> Run scripts
              </button>
            )}
          </div>
        )}
        <iframe
          title={name}
          srcDoc={text}
          sandbox={sandbox}
          className="min-h-[60vh] w-full flex-1 bg-white"
        />
      </div>
    );
  }

  // code + text
  if (!text) return <Empty />;
  if (kind === 'code') {
    return <div className="prose prose-invert prose-sm max-w-none px-5 py-4"><Markdown>{'```' + codeLanguage(name) + '\n' + text + '\n```'}</Markdown></div>;
  }
  return <pre className="overflow-auto px-5 py-4 text-sm text-ink-200">{text}</pre>;
}

function Empty() {
  return <div className="p-8 text-center text-sm text-ink-500">This file is empty.</div>;
}
