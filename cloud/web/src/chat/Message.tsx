import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Copy, Check, RotateCcw, ChevronDown, ChevronLeft, ChevronRight, Pencil, Trash2, FileText, Download, UploadCloud, Loader2, Eye } from 'lucide-react';
import { uploadUrl, saveFile } from '../lib/api.js';
import Markdown from '../components/Markdown.js';
import FileViewerModal from '../components/FileViewerModal.js';
import type { ChatMessage } from './useChatSession.js';
import type { WhyReport } from '../lib/types.js';

// Compact "12k chars" / "980 chars" label for a document attachment's size.
function formatChars(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k chars` : `${n} chars`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface GeneratedFile { name: string; content: string }

// A hosted run delivers files as ```file:<name>``` fenced blocks (it has no disk
// tools). Pull them out so we can render download/save cards instead of raw code.
function extractGeneratedFiles(md: string): { files: GeneratedFile[]; rest: string } {
  const files: GeneratedFile[] = [];
  const rest = md.replace(/```file:([^\n`]+)\n([\s\S]*?)```/g, (_m, name: string, content: string) => {
    files.push({ name: name.trim().slice(0, 200), content: content.replace(/\n$/, '') });
    return '';
  });
  return { files, rest: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

/** View + free browser download (client Blob) + optional metered save to Cascade. */
function GeneratedFileCard({ file }: { file: GeneratedFile }) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const size = new Blob([file.content]).size;

  function download() {
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function save() {
    if (busy || saved) return;
    setBusy(true); setError(null);
    try { await saveFile({ name: file.name, content: file.content }); setSaved(true); window.dispatchEvent(new CustomEvent('cascade:files-changed')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-elev/10 bg-elev/[0.05] px-3 py-2.5">
      <FileText size={16} className="shrink-0 text-accent-300" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink-100">{file.name}</div>
        <div className="truncate text-[11px] text-ink-500">{formatBytes(size)}{error ? ` · ${error}` : ''}</div>
      </div>
      <button type="button" onClick={() => setViewing(true)} className="flex items-center gap-1 rounded-lg border border-elev/10 px-2.5 py-1 text-xs text-ink-200 hover:bg-elev/[0.06]">
        <Eye size={13} /> View
      </button>
      <button type="button" onClick={download} className="flex items-center gap-1 rounded-lg border border-elev/10 px-2.5 py-1 text-xs text-ink-200 hover:bg-elev/[0.06]">
        <Download size={13} /> Download
      </button>
      <button type="button" onClick={save} disabled={busy || saved} className="flex items-center gap-1 rounded-lg bg-accent-600 px-2.5 py-1 text-xs text-white hover:bg-accent-500 disabled:opacity-60">
        {busy ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} /> : <UploadCloud size={13} />} {saved ? 'Saved' : 'Save'}
      </button>
      {viewing && (
        <FileViewerModal
          name={file.name}
          content={file.content}
          onClose={() => setViewing(false)}
          actions={
            <button type="button" onClick={save} disabled={busy || saved} className="flex shrink-0 items-center gap-1 rounded-lg bg-accent-600 px-2 py-1 text-xs text-white hover:bg-accent-500 disabled:opacity-60">
              {busy ? <Loader2 size={12} className="animate-spin" /> : saved ? <Check size={12} /> : <UploadCloud size={12} />} {saved ? 'Saved' : 'Save'}
            </button>
          }
        />
      )}
    </div>
  );
}

// Tier accent colors match the run-explorer design (T1 green / T2 amber /
// T3 violet), rendered as subtle tinted chips over the existing dark surface.
const TIER_STYLE: Record<string, string> = {
  T1: 'text-[#4ade80] bg-[#4ade80]/12 ring-[#4ade80]/25',
  T2: 'text-[#f0b429] bg-[#f0b429]/12 ring-[#f0b429]/25',
  T3: 'text-[#c084fc] bg-[#c084fc]/12 ring-[#c084fc]/25',
};

function TierBadge({ tier }: { tier: string }) {
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wide ring-1 ${
        TIER_STYLE[tier] ?? 'text-ink-300 bg-elev/5 ring-elev/10'
      }`}
    >
      {tier}
    </span>
  );
}

const KIND_DOT: Record<string, string> = {
  complexity: 'bg-info-500',
  model: 'bg-accent-500',
  failover: 'bg-warning-500',
  escalation: 'bg-danger-500',
};

function WhyPanel({ why }: { why: WhyReport }) {
  const tiers = Object.keys(why.costByTier).filter((t) => (why.costByTier[t] ?? 0) > 0);
  return (
    <div className="mt-1 rounded-lg border border-elev/10 bg-black/30 p-3 text-xs text-ink-300">
      {why.savedUsd > 0 && (
        <p className="mb-2 text-success-300">
          Saved <span className="font-mono">${why.savedUsd.toFixed(4)}</span> ({why.savedPct}%) by delegating below the
          top tier.
        </p>
      )}
      {why.decisions.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {why.decisions.map((d, i) => (
            <li key={i} className="flex gap-2">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[d.kind] ?? 'bg-ink-400'}`} />
              <span className="leading-snug">
                <span className="font-mono text-[10.5px] uppercase text-ink-400">{d.kind}</span> · {d.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
      {tiers.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-elev/10 pt-2">
          {tiers.map((t) => (
            <div key={t} className="flex items-center justify-between font-mono text-[11px]">
              <span>{t}{why.models[t] ? ` · ${why.models[t]}` : ''}</span>
              <span className="text-ink-400">${(why.costByTier[t] ?? 0).toFixed(4)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ getText, className }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(getText());
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={className ?? 'text-ink-400 hover:text-ink-100'}
    >
      {copied ? <Check size={14} className="text-success-500" /> : <Copy size={14} />}
    </button>
  );
}

// The < n/m > branch navigator — shown on any message that has siblings (an
// edited prompt or a regenerated reply), stepping the active path between them.
function SiblingNav({ message, onSelect }: { message: ChatMessage; onSelect?: (id: string) => void }) {
  const ids = message.siblingIds;
  if (!ids || ids.length < 2 || !onSelect) return null;
  const idx = ids.indexOf(message.id);
  if (idx < 0) return null;
  const prev = ids[idx - 1];
  const next = ids[idx + 1];
  return (
    <span className="flex items-center gap-0.5 text-[11px] text-ink-500">
      <button
        type="button"
        aria-label="Previous version"
        disabled={!prev}
        onClick={() => prev && onSelect(prev)}
        className="rounded p-0.5 hover:text-ink-200 disabled:opacity-30"
      >
        <ChevronLeft size={13} />
      </button>
      <span className="tabular-nums">{idx + 1}/{ids.length}</span>
      <button
        type="button"
        aria-label="Next version"
        disabled={!next}
        onClick={() => next && onSelect(next)}
        className="rounded p-0.5 hover:text-ink-200 disabled:opacity-30"
      >
        <ChevronRight size={13} />
      </button>
    </span>
  );
}

interface Props {
  message: ChatMessage;
  /** A run is in flight — gates edit/regenerate submission. */
  busy?: boolean;
  /** Regenerate this assistant reply as a new sibling. */
  onRegenerate?: () => void;
  /** Edit this user turn: forks a new branch and re-runs. */
  onEdit?: (newText: string) => void;
  /** Delete this message and its whole subtree. */
  onDelete?: () => void;
  /** Switch the active path to a sibling (the < n/m > arrows). */
  onSelectSibling?: (messageId: string) => void;
}

export default function Message({ message, busy, onRegenerate, onEdit, onDelete, onSelectSibling }: Props) {
  const attachments = message.attachments ?? [];
  const images = attachments.filter((a) => a.mime.startsWith('image/'));
  const docs = attachments.filter((a) => a.kind === 'document' || (!a.mime.startsWith('image/') && !!a.filename));
  const [whyOpen, setWhyOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  function submitEdit() {
    const text = draft.trim();
    if (!text || busy) return;
    onEdit?.(text);
    setEditing(false);
  }

  if (message.role === 'user') {
    return (
      <div data-role="user" className="group flex flex-col items-end gap-2">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((a) => (
              <img
                key={a.id}
                src={uploadUrl(a.id)}
                alt="attachment"
                className="max-h-40 rounded-xl border border-elev/10 object-cover shadow-lg"
              />
            ))}
          </div>
        )}
        {docs.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {docs.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 rounded-xl border border-elev/10 bg-elev/[0.06] px-3 py-2 text-xs text-ink-200 shadow-lg"
              >
                <FileText size={14} className="shrink-0 text-accent-300" />
                <span className="max-w-[12rem] truncate font-medium">{a.filename ?? 'document'}</span>
                {typeof a.charCount === 'number' && a.charCount > 0 && (
                  <span className="text-ink-500">{formatChars(a.charCount)}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {editing ? (
          <div className="w-full max-w-[80%]">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitEdit(); }
                if (e.key === 'Escape') { setEditing(false); setDraft(message.content); }
              }}
              rows={Math.min(10, draft.split('\n').length + 1)}
              autoFocus
              className="w-full resize-y rounded-2xl border border-accent-500/30 bg-elev/[0.06] px-4 py-2 text-sm text-ink-100 focus:outline-none focus:ring-1 focus:ring-accent-500"
            />
            <div className="mt-1.5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setEditing(false); setDraft(message.content); }}
                className="rounded-lg px-3 py-1 text-xs text-ink-400 hover:text-ink-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitEdit}
                disabled={busy || !draft.trim()}
                className="rounded-lg bg-accent-600 px-3 py-1 text-xs text-white hover:bg-accent-500 disabled:opacity-60"
              >
                Save &amp; submit
              </button>
            </div>
          </div>
        ) : (
          message.content && (
            <div className="accent-grad max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2 font-medium text-white shadow-lg shadow-accent-700/20">
              {message.content}
            </div>
          )
        )}
        {!editing && (message.content || (message.siblingIds?.length ?? 0) > 1) && (
          <div className="flex items-center gap-1.5 text-ink-400 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
            <SiblingNav message={message} onSelect={onSelectSibling} />
            <CopyButton getText={() => message.content} />
            {onEdit && (
              <button
                type="button"
                aria-label="Edit"
                onClick={() => { setDraft(message.content); setEditing(true); }}
                className="hover:text-ink-100"
              >
                <Pencil size={14} />
              </button>
            )}
            {onDelete && (
              <button type="button" aria-label="Delete" onClick={onDelete} className="hover:text-danger-300">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-role="assistant" className="group flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-ink-400">
        {message.tier ? (
          <TierBadge tier={message.tier} />
        ) : (
          <span className="accent-grad h-2 w-2 rounded-full" />
        )}
        <span>Cascade</span>
        {message.model && <span className="text-ink-500">{message.model}</span>}
        {message.cancelled && (
          <span className="rounded bg-danger-500/15 px-1.5 py-0.5 text-[10px] font-medium text-danger-300">stopped</span>
        )}
        {message.why && (
          <button
            type="button"
            onClick={() => setWhyOpen((o) => !o)}
            className="flex items-center gap-0.5 font-mono text-[11px] text-ink-500 hover:text-ink-300"
          >
            /why
            <ChevronDown size={11} className={whyOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {whyOpen && message.why && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <WhyPanel why={message.why} />
          </motion.div>
        )}
      </AnimatePresence>
      {message.streaming && !message.content ? (
        <span className="shimmer-text text-sm">Composing a response…</span>
      ) : (() => {
        // Only pull out file blocks once the message is complete — a partial
        // fence mid-stream would render half a file.
        const { files, rest } = message.streaming
          ? { files: [] as GeneratedFile[], rest: message.content }
          : extractGeneratedFiles(message.content);
        return (
          <>
            {rest && (
              <div className="prose prose-invert prose-sm max-w-none text-ink-100">
                <Markdown>{rest}</Markdown>
              </div>
            )}
            {files.length > 0 && (
              <div className="mt-1 flex flex-col gap-2">
                {files.map((f, i) => <GeneratedFileCard key={`${f.name}-${i}`} file={f} />)}
              </div>
            )}
          </>
        );
      })()}
      {!message.streaming && message.content && (
        <div className="flex items-center gap-2 pt-0.5 text-ink-400 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
          <SiblingNav message={message} onSelect={onSelectSibling} />
          <CopyButton getText={() => message.content} />
          {onRegenerate && (
            <button type="button" aria-label="Regenerate" onClick={onRegenerate} className="hover:text-ink-100">
              <RotateCcw size={14} />
            </button>
          )}
          {onDelete && (
            <button type="button" aria-label="Delete" onClick={onDelete} className="hover:text-danger-300">
              <Trash2 size={14} />
            </button>
          )}
          {typeof message.costUsd === 'number' && message.costUsd > 0 && (
            <span className="ml-1 text-[11px] tabular-nums">${message.costUsd.toFixed(4)}</span>
          )}
        </div>
      )}
    </div>
  );
}
