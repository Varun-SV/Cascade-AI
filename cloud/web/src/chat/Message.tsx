import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Copy, Check, RotateCcw, ChevronDown, ChevronLeft, ChevronRight, Pencil, Trash2, FileText, Download, UploadCloud, Loader2, Eye, ThumbsUp, ThumbsDown, Image as ImageIcon, Film, Clock } from 'lucide-react';
import { uploadUrl, saveFile, setFeedback, clearFeedback, fileDownloadUrl, type Verdict, type PendingMedia } from '../lib/api.js';
import { usePendingMedia, markPendingMediaSaved } from '../lib/pendingMedia.js';
import Markdown from '../components/Markdown.js';
import FileViewerModal from '../components/FileViewerModal.js';
import { fileExt } from '../lib/fileKind.js';
import { isExportableExt, renderExport, exportLabel, sourceHint } from '../lib/exporters.js';
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

/** base64 (no data: prefix) of a Blob, for the metered binary save. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** View + free browser download (client Blob) + optional metered save to Cascade.
 *  For Office/PDF names (.pdf/.xlsx/.docx/.pptx) the model's Markdown/CSV source
 *  is rendered into the real binary in the browser: View previews it (PDF inline,
 *  Office as its source), Download and Save produce the binary. */
function GeneratedFileCard({ file }: { file: GeneratedFile }) {
  const [busy, setBusy] = useState(false);     // metered save
  const [saved, setSaved] = useState(false);
  const [dl, setDl] = useState(false);          // binary render + download
  const [vw, setVw] = useState(false);          // rendering the PDF for preview
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const ext = fileExt(file.name);
  const exportable = isExportableExt(ext);
  const size = new Blob([file.content]).size;
  // How to preview an Office export's *source* (the fenced body the model wrote).
  const sourceKind = ext === 'xlsx' ? 'csv' : ext === 'docx' || ext === 'pptx' ? 'markdown' : undefined;

  function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function download() {
    if (exportable) {
      setDl(true); setError(null);
      try { saveBlob(await renderExport(ext, file.content, file.name), file.name); }
      catch (e) { setError(e instanceof Error ? e.message : `Could not generate the ${exportLabel(ext)}.`); }
      finally { setDl(false); }
      return;
    }
    saveBlob(new Blob([file.content], { type: 'text/plain;charset=utf-8' }), file.name);
  }
  async function view() {
    setError(null);
    if (ext === 'pdf') { // render the real PDF and preview it inline
      setVw(true);
      try { setPdfUrl(URL.createObjectURL(await renderExport('pdf', file.content, file.name))); setViewing(true); }
      catch (e) { setError(e instanceof Error ? e.message : 'Could not render the PDF.'); }
      finally { setVw(false); }
      return;
    }
    setViewing(true); // text files, and Office source previews
  }
  function closeView() {
    setViewing(false);
    if (pdfUrl) { URL.revokeObjectURL(pdfUrl); setPdfUrl(null); }
  }
  async function save() {
    if (busy || saved) return;
    setBusy(true); setError(null);
    try {
      if (exportable) {
        const b64 = await blobToBase64(await renderExport(ext, file.content, file.name));
        await saveFile({ name: file.name, content: b64, encoding: 'base64' });
      } else {
        await saveFile({ name: file.name, content: file.content });
      }
      setSaved(true); window.dispatchEvent(new CustomEvent('cascade:files-changed'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }
  const saveButton = (small: boolean) => (
    <button type="button" onClick={save} disabled={busy || saved} className={`flex ${small ? 'shrink-0 ' : ''}items-center gap-1 rounded-lg bg-accent-600 px-2.5 py-1 text-xs text-white hover:bg-accent-500 disabled:opacity-60`}>
      {busy ? <Loader2 size={small ? 12 : 13} className="animate-spin" /> : saved ? <Check size={small ? 12 : 13} /> : <UploadCloud size={small ? 12 : 13} />} {saved ? 'Saved' : 'Save'}
    </button>
  );
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-elev/10 bg-elev/[0.05] px-3 py-2.5">
      <FileText size={16} className="shrink-0 text-accent-300" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-ink-100">{file.name}</span>
          {exportable && (
            <span className="shrink-0 rounded bg-accent-500/12 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-accent-300">
              {exportLabel(ext)}
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-ink-500">
          {exportable ? `${exportLabel(ext)} document ${sourceHint(ext)}` : formatBytes(size)}{error ? ` · ${error}` : ''}
        </div>
      </div>
      <button type="button" onClick={view} disabled={vw} className="flex items-center gap-1 rounded-lg border border-elev/10 px-2.5 py-1 text-xs text-ink-200 hover:bg-elev/[0.06] disabled:opacity-60">
        {vw ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />} View
      </button>
      <button type="button" onClick={download} disabled={dl} className="flex items-center gap-1 rounded-lg border border-elev/10 px-2.5 py-1 text-xs text-ink-200 hover:bg-elev/[0.06] disabled:opacity-60">
        {dl ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download
      </button>
      {saveButton(false)}
      {viewing && (
        <FileViewerModal
          name={file.name}
          mime={ext === 'pdf' ? 'application/pdf' : undefined}
          content={exportable ? (ext === 'pdf' ? undefined : file.content) : file.content}
          src={ext === 'pdf' ? (pdfUrl ?? undefined) : undefined}
          kindOverride={exportable ? (ext === 'pdf' ? 'pdf' : sourceKind) : undefined}
          onClose={closeView}
          actions={saveButton(true)}
        />
      )}
    </div>
  );
}

// Generated media is referenced in the reply as `/api/files/<id>` — usually
// `![alt](…)` for an image, a plain link for a video/audio clip. Collect every
// such id so the still-unsaved ones can be offered a Save card; ids the server
// doesn't list as pending are saved files and need no card.
function extractMediaIds(md: string): string[] {
  const ids = new Set<string>();
  for (const m of md.matchAll(/\/api\/files\/([A-Za-z0-9._~%-]+)/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return [...ids];
}

/** "23h" / "45m" / "expired" — how long is left to decide. */
function formatRemaining(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / (60 * 1000)))}m`;
}

/**
 * The unsaved-artifact card for a generated image/video — the media twin of
 * GeneratedFileCard.
 *
 * The asymmetry with text/office exports is unavoidable: those live in the
 * model's own reply, so the browser can rebuild them at any time and nothing
 * is stored until Save. A picture is real binary that only exists because a
 * server-side tool call produced it, so it is parked server-side — but
 * deliberately outside the storage quota and on a timer, so the user's choice
 * still decides whether it is kept. Download is free (the bytes are already
 * theirs to fetch); Save is the metered action, and the only one that spends
 * quota.
 */
function GeneratedMediaCard({ media, saved }: { media: PendingMedia; saved: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isVideo = media.mime.startsWith('video/');
  const Icon = isVideo ? Film : ImageIcon;

  async function save() {
    if (busy || saved) return;
    setBusy(true); setError(null);
    try {
      // The same POST /api/files the text/office cards use — the server holds
      // the bytes already, so this sends the id instead of re-uploading them.
      await saveFile({ pendingMediaId: media.id });
      markPendingMediaSaved(media.id);
      window.dispatchEvent(new CustomEvent('cascade:files-changed'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  }

  return (
    <div data-testid="generated-media-card" className="flex items-center gap-2.5 rounded-xl border border-elev/10 bg-elev/[0.05] px-3 py-2.5">
      <Icon size={16} className="shrink-0 text-accent-300" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-ink-100">{media.name}</span>
          {saved ? (
            <span className="shrink-0 rounded bg-success-500/12 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-success-300">
              Saved
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-0.5 rounded bg-warning-500/12 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-warning-300">
              <Clock size={9} /> Temporary
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-ink-500">
          {formatBytes(media.size)} · {saved
            ? 'Saved to your Cascade files.'
            : `Expires in ${formatRemaining(media.expiresAt)} unless you save it.`}
          {error ? ` · ${error}` : ''}
        </div>
      </div>
      <a
        href={fileDownloadUrl(media.id)}
        download={media.name}
        className="flex items-center gap-1 rounded-lg border border-elev/10 px-2.5 py-1 text-xs text-ink-200 hover:bg-elev/[0.06]"
      >
        <Download size={13} /> Download
      </a>
      <button
        type="button"
        onClick={save}
        disabled={busy || saved}
        className="flex items-center gap-1 rounded-lg bg-accent-600 px-2.5 py-1 text-xs text-white hover:bg-accent-500 disabled:opacity-60"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} /> : <UploadCloud size={13} />} {saved ? 'Saved' : 'Save'}
      </button>
    </div>
  );
}

// Tier dots take the theme's tier tokens (azure → sky → teal), so a reply's
// tier reads the same here as in the run tree, the tier mix and the mark.
const TIER_DOT: Record<string, string> = { T1: 'bg-t1', T2: 'bg-t2', T3: 'bg-t3' };

/**
 * The receipt line under every reply: which tier and model served it, what it
 * cost, and what delegating below T1 saved. It IS the /why toggle — the
 * detail sits behind the number it explains.
 */
function Receipt({ message, open, onToggle }: { message: ChatMessage; open: boolean; onToggle?: () => void }) {
  const saved = message.why?.savedUsd ?? 0;
  // A reply doesn't always carry its tier/model directly. The /why report
  // names the tier that did the most work (`why.tier`/`why.model`), so fall
  // back to that; only if it's missing, look the model up by tier.
  const whyModels = message.why?.models ?? {};
  const tier = message.tier ?? message.why?.tier ?? undefined;
  const rawModel = message.model ?? message.why?.model ?? (tier ? whyModels[tier] : undefined);
  // "openai-compatible:stub-model" → "stub-model": the provider is noise here.
  const model = rawModel ? rawModel.slice(rawModel.indexOf(':') + 1) : undefined;
  const body = (
    <>
      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${tier ? TIER_DOT[tier] ?? 'bg-ink-500' : 'accent-grad'}`} />
      {tier && <span>{tier}</span>}
      {model ? <span className="truncate">{tier ? '· ' : ''}{model}</span> : !tier && <span className="font-sans">Cascade</span>}
      {typeof message.costUsd === 'number' && message.costUsd > 0 && <span>· ${message.costUsd.toFixed(4)}</span>}
      {saved > 0 && <span className="text-success-300">· saved ${saved < 0.01 ? saved.toFixed(4) : saved.toFixed(2)}</span>}
      {message.cancelled && (
        <span className="rounded-full bg-danger-500/15 px-1.5 font-sans text-[10.5px] text-danger-300">stopped</span>
      )}
    </>
  );
  if (!onToggle) {
    return <span className="receipt flex min-w-0 items-center gap-1.5 text-ink-500">{body}</span>;
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title="Why this tier and model, and what it saved"
      className="receipt -ml-2 flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-ink-500 hover:bg-elev/[0.05] hover:text-ink-300"
    >
      {body}
      <span className="sr-only">/why</span>
      <ChevronDown size={11} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
    </button>
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
  const spent = tiers.reduce((sum, t) => sum + (why.costByTier[t] ?? 0), 0);
  const allT1 = spent + Math.max(0, why.savedUsd);
  return (
    <div className="mt-1 rounded-2xl border border-elev/10 bg-ink-900 p-4 text-xs text-ink-300">
      {why.savedUsd > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          <p className="text-[13px] text-ink-100">
            Saved <span className="receipt text-success-300">${why.savedUsd.toFixed(4)}</span> · {why.savedPct}% less than running it all on T1
          </p>
          {/* Both bars share one scale: the all-T1 cost is the full width. */}
          <div className="receipt grid grid-cols-[5.5rem_1fr_auto] items-center gap-x-3 gap-y-1.5 text-ink-400">
            <span>Cascade</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-elev/10">
              <span className="block h-full rounded-full" style={{ width: `${allT1 > 0 ? Math.max(2, (spent / allT1) * 100) : 0}%`, background: 'var(--cascade-ramp-x)' }} />
            </span>
            <span>${spent.toFixed(4)}</span>
            <span>All on T1</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-elev/10">
              <span className="block h-full w-full rounded-full bg-ink-500" />
            </span>
            <span>${allT1.toFixed(4)}</span>
          </div>
        </div>
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
        <div className="mt-3 flex flex-col gap-1 border-t border-elev/10 pt-3">
          {tiers.map((t) => (
            <div key={t} className="flex items-center justify-between font-mono text-[11px]">
              <span className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${TIER_DOT[t] ?? 'bg-ink-500'}`} />{t}{why.models[t] ? ` · ${why.models[t]}` : ''}</span>
              <span className="text-ink-400">${(why.costByTier[t] ?? 0).toFixed(4)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Thumbs up / down on one assistant reply.
 *
 * Pressing the active thumb again withdraws the vote rather than casting the
 * opposite one — "I take that back" and "I disagree" are different, and only
 * the user knows which they meant.
 *
 * The button state updates before the request resolves and rolls back on
 * failure: a rating is a throwaway gesture, and making someone wait on a round
 * trip to see their own click register is how a feature like this goes unused.
 */
function FeedbackButtons({ messageId, initial }: { messageId: string; initial?: Verdict }) {
  const [verdict, setVerdict] = useState<Verdict | undefined>(initial);

  const cast = async (next: Verdict) => {
    const prev = verdict;
    const withdrawing = prev === next;
    setVerdict(withdrawing ? undefined : next);
    try {
      if (withdrawing) await clearFeedback(messageId);
      else await setFeedback(messageId, next);
    } catch {
      setVerdict(prev);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Good response"
        aria-pressed={verdict === 'good'}
        onClick={() => void cast('good')}
        className={verdict === 'good' ? 'text-success-500' : 'hover:text-ink-100'}
      >
        <ThumbsUp size={14} />
      </button>
      <button
        type="button"
        aria-label="Poor response"
        aria-pressed={verdict === 'bad'}
        onClick={() => void cast('bad')}
        className={verdict === 'bad' ? 'text-danger-300' : 'hover:text-ink-100'}
      >
        <ThumbsDown size={14} />
      </button>
    </>
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

// Reasoning-tuned models (Anthropic thinking, OpenAI reasoning, and local GGUF
// models that emit it natively) surface their chain-of-thought as literal
// `<think>…</think>` markup inline in the text (see src/providers/anthropic.ts
// and openai.ts). Split it out so it renders as a collapsed "Thoughts" block
// instead of leaking into the answer. An unterminated trailing `<think>` means
// the model is still thinking — everything after it is in-progress reasoning,
// not answer text. Mirrors the desktop app's ChatPanel.
function splitThinking(content: string): { thinking: string; answer: string; thinkingOpen: boolean } {
  let thinking = '';
  let answer = content.replace(/<think>([\s\S]*?)<\/think>\s*/g, (_m, inner: string) => {
    thinking += (thinking ? '\n\n' : '') + inner.trim();
    return '';
  });
  let thinkingOpen = false;
  const openIdx = answer.indexOf('<think>');
  if (openIdx !== -1) {
    thinkingOpen = true;
    thinking += (thinking ? '\n\n' : '') + answer.slice(openIdx + '<think>'.length).trim();
    answer = answer.slice(0, openIdx);
  }
  return { thinking: thinking.trim(), answer: answer.trim(), thinkingOpen };
}

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="-ml-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-ink-400 hover:bg-elev/[0.05] hover:text-ink-200"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{streaming ? 'Thinking…' : 'Thoughts'}</span>
        {streaming && <span className="accent-grad h-1.5 w-1.5 animate-pulse rounded-full" />}
      </button>
      {open && (
        <div className="prose prose-invert prose-sm mt-1 max-w-none border-l-2 border-elev/15 py-0.5 pl-3 text-ink-400">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
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
  // Only a reply that actually references generated media asks the server
  // which of it is still unsaved — an ordinary chat turn costs no request.
  const mediaIds = message.role === 'assistant' && !message.streaming ? extractMediaIds(message.content) : [];
  const { media: pendingMedia, savedIds } = usePendingMedia(mediaIds.length > 0);
  const unsavedMedia = mediaIds.length
    ? pendingMedia.filter((m) => mediaIds.includes(m.id))
    : [];

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
                className="rounded-lg bg-ink-50 px-3 py-1 text-xs text-ink-900 hover:opacity-90 disabled:opacity-60"
              >
                Save &amp; submit
              </button>
            </div>
          </div>
        ) : (
          message.content && (
            <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-ink-800 px-4 py-2.5 text-[15px] text-ink-50">
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

  const hasReceipt = Boolean(message.tier || message.model || message.why || message.cancelled || message.costUsd);
  return (
    <div data-role="assistant" className="group flex flex-col gap-2">
      {message.streaming && !message.content ? (
        <span className="shimmer-text text-sm">Writing…</span>
      ) : (() => {
        // Reasoning (<think>…</think>) renders as a collapsed "Thoughts" block,
        // never inline in the answer. Files are pulled from the answer only once
        // complete — a partial fence mid-stream would render half a file.
        const { thinking, answer, thinkingOpen } = splitThinking(message.content);
        const { files, rest } = message.streaming
          ? { files: [] as GeneratedFile[], rest: answer }
          : extractGeneratedFiles(answer);
        return (
          <>
            {thinking && <ThinkingBlock text={thinking} streaming={message.streaming && thinkingOpen} />}
            {rest && (
              <div className="cascade-answer prose prose-invert max-w-none text-ink-100">
                <Markdown>{rest}</Markdown>
              </div>
            )}
            {(files.length > 0 || unsavedMedia.length > 0) && (
              <div className="mt-1 flex flex-col gap-2">
                {files.map((f, i) => <GeneratedFileCard key={`${f.name}-${i}`} file={f} />)}
                {unsavedMedia.map((m) => (
                  <GeneratedMediaCard key={m.id} media={m} saved={savedIds.has(m.id)} />
                ))}
              </div>
            )}
          </>
        );
      })()}
      {/* The receipt stands on its own: a run stopped before its first token
          has no content but still needs "stopped" and its /why. The actions
          act on the text, so they wait for some. */}
      {!message.streaming && (message.content || hasReceipt) && (
        <div className="flex min-h-[28px] flex-wrap items-center gap-2">
          {hasReceipt && (
            <Receipt
              message={message}
              open={whyOpen}
              onToggle={message.why ? () => setWhyOpen((o) => !o) : undefined}
            />
          )}
          {message.content && (
            <div className="ml-auto flex items-center gap-2 text-ink-400 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              <SiblingNav message={message} onSelect={onSelectSibling} />
              <CopyButton getText={() => splitThinking(message.content).answer || message.content} />
              {/* Only a persisted message can carry a verdict — an id is what the
                  server keys the vote on, and a still-streaming reply has none. */}
              {message.id && <FeedbackButtons messageId={message.id} initial={message.verdict} />}
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
            </div>
          )}
        </div>
      )}
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
    </div>
  );
}
