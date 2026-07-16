import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { Send, Paperclip, X, Loader2, Globe, Square, Zap } from 'lucide-react';
import { uploadImage } from '../lib/api.js';
import type { Skill } from '../lib/types.js';
import type { ChatAttachment, ForceTier, RoutingMode, SendInput } from './useChatSession.js';
import type { UiMode } from '../lib/prefs.js';

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_FILES = 4;

interface Pending extends ChatAttachment {
  previewUrl: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const ROUTING_MODES: Array<{ value: RoutingMode; label: string; title: string }> = [
  { value: 'auto', label: 'Auto', title: 'Balanced — Cascade picks the cheapest model that clears the bar' },
  { value: 'quality', label: 'Quality', title: 'Bias toward stronger models' },
  { value: 'fast', label: 'Fast', title: 'Bias toward cheaper, faster models' },
];

const FORCE_TIERS: ForceTier[] = ['auto', 'T1', 'T2', 'T3'];

interface Props {
  skills: Skill[];
  skillId: string;
  onSkillChange: (id: string) => void;
  hasProviders: boolean;
  busy: boolean;
  onSend: (input: SendInput) => void;
  onStop: () => void;
  routingMode: RoutingMode;
  onRoutingModeChange: (m: RoutingMode) => void;
  forceTier: ForceTier;
  onForceTierChange: (t: ForceTier) => void;
  webSearch: boolean;
  onWebSearchChange: (on: boolean) => void;
  uiMode: UiMode;
}

export default function Composer({
  skills, skillId, onSkillChange, hasProviders, busy, onSend, onStop,
  routingMode, onRoutingModeChange, forceTier, onForceTierChange, webSearch, onWebSearchChange, uiMode,
}: Props) {
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function addFiles(files: FileList | File[]) {
    const images = Array.from(files).filter((f) => ALLOWED.has(f.type));
    if (!images.length) return;
    setUploading(true);
    try {
      for (const file of images) {
        if (pending.length >= MAX_FILES) break;
        try {
          const base64 = await fileToBase64(file);
          const { id, mime } = await uploadImage(file.type, base64);
          setPending((prev) =>
            prev.length >= MAX_FILES ? prev : [...prev, { id, mime, previewUrl: URL.createObjectURL(file) }],
          );
        } catch {
          /* one bad file shouldn't block the rest */
        }
      }
    } finally {
      setUploading(false);
    }
  }

  function removePending(id: string) {
    setPending((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  function submit(fast = false) {
    if (!input.trim() || busy || uploading) return;
    onSend({ prompt: input, attachments: pending.map(({ id, mime }) => ({ id, mime })), fast });
    setInput('');
    pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPending([]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (files.some((f) => ALLOWED.has(f.type))) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  }

  const disabled = busy || !hasProviders;

  return (
    <div className="px-4 py-3 sm:px-6">
      <div
        className={clsx(
          'mx-auto max-w-3xl rounded-2xl border bg-elev/[0.04] backdrop-blur-xl transition-colors',
          dragOver ? 'border-accent-500 ring-2 ring-accent-500/40' : 'border-elev/10',
        )}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pending.map((p) => (
              <div key={p.id} className="relative">
                <img src={p.previewUrl} alt="pending" className="h-16 w-16 rounded-xl border border-elev/10 object-cover shadow-lg" />
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => removePending(p.id)}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-elev/10 bg-ink-800 p-0.5 text-ink-200 backdrop-blur hover:text-ink-50"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 p-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
          />
          <motion.button
            type="button"
            aria-label="Attach image"
            title="Attach an image — files coming soon"
            disabled={disabled || pending.length >= MAX_FILES}
            onClick={() => fileRef.current?.click()}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-400 hover:bg-elev/10 hover:text-ink-100 disabled:opacity-40"
          >
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
          </motion.button>

          <select
            aria-label="Skill"
            value={skillId}
            onChange={(e) => onSkillChange(e.target.value)}
            disabled={disabled}
            className="max-w-[9rem] shrink-0 truncate rounded-lg border border-elev/10 bg-elev/[0.04] px-2 py-1.5 text-xs text-ink-200 outline-none backdrop-blur disabled:opacity-40"
          >
            {skills.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          <textarea
            className="max-h-40 min-h-[32px] flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-400"
            placeholder={hasProviders ? 'Message Cascade…' : 'Add a provider key to start chatting'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled}
            rows={1}
          />

          {!busy && (
            <motion.button
              type="button"
              onClick={() => submit(true)}
              disabled={disabled || uploading || !input.trim()}
              aria-label="Fast answer"
              title="Fast answer — one quick model, skips the multi-agent orchestration (cheaper &amp; faster)"
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.92 }}
              className={clsx(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors',
                disabled || uploading || !input.trim()
                  ? 'cursor-not-allowed border-elev/10 text-ink-500'
                  : 'border-warning-500/40 bg-warning-500/10 text-warning-300 hover:bg-warning-500/20',
              )}
            >
              <Zap size={15} />
            </motion.button>
          )}
          {busy ? (
            <motion.button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop this run"
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.92 }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger-500/90 text-white shadow-lg shadow-danger-700/30"
            >
              <Square size={13} fill="currentColor" />
            </motion.button>
          ) : (
            <motion.button
              type="button"
              onClick={() => submit()}
              disabled={disabled || uploading || !input.trim()}
              aria-label="Send"
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.92 }}
              className={clsx(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-shadow',
                disabled || uploading || !input.trim()
                  ? 'cursor-not-allowed bg-ink-700 text-ink-400'
                  : 'accent-grad text-white shadow-lg shadow-accent-700/30',
              )}
            >
              <Send size={15} />
            </motion.button>
          )}
        </div>

        {/* Routing controls: bias Cascade Auto, pin a tier, toggle web tools.
            Advanced view only — Simple keeps the composer minimal. */}
        {uiMode === 'advanced' && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-elev/5 px-2.5 py-1.5">
            <div className="flex items-center gap-0.5 rounded-lg bg-elev/[0.04] p-0.5" role="group" aria-label="Routing mode">
              {ROUTING_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  title={m.title}
                  disabled={disabled}
                  aria-pressed={routingMode === m.value}
                  onClick={() => onRoutingModeChange(m.value)}
                  className={clsx(
                    'rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40',
                    routingMode === m.value
                      ? 'accent-grad text-white shadow-sm'
                      : 'text-ink-400 hover:bg-elev/10 hover:text-ink-100',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-1 text-[11px] text-ink-400">
              <span className="hidden sm:inline">Tier</span>
              <select
                aria-label="Force tier"
                value={forceTier}
                onChange={(e) => onForceTierChange(e.target.value as ForceTier)}
                disabled={disabled}
                className="rounded-lg border border-elev/10 bg-elev/[0.04] px-1.5 py-1 text-[11px] text-ink-200 outline-none backdrop-blur disabled:opacity-40"
              >
                {FORCE_TIERS.map((t) => (
                  <option key={t} value={t}>{t === 'auto' ? 'Auto' : t}</option>
                ))}
              </select>
            </label>

            <button
              type="button"
              title="Allow web search & fetch for this run"
              disabled={disabled}
              aria-pressed={webSearch}
              onClick={() => onWebSearchChange(!webSearch)}
              className={clsx(
                'flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40',
                webSearch
                  ? 'border-accent-500/30 bg-accent-500/10 text-accent-300'
                  : 'border-elev/10 bg-elev/[0.04] text-ink-400 hover:text-ink-100',
              )}
            >
              <Globe size={12} />
              Web
            </button>
          </div>
        )}
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl px-1 text-[11px] text-ink-400">
        Images now · file generation &amp; download coming soon.
      </p>
    </div>
  );
}
