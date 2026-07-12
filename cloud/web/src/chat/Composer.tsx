import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { Send, Paperclip, X, Loader2 } from 'lucide-react';
import { uploadImage } from '../lib/api.js';
import type { Skill } from '../lib/types.js';
import type { ChatAttachment, SendInput } from './useChatSession.js';

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

interface Props {
  skills: Skill[];
  skillId: string;
  onSkillChange: (id: string) => void;
  hasProviders: boolean;
  busy: boolean;
  onSend: (input: SendInput) => void;
}

export default function Composer({ skills, skillId, onSkillChange, hasProviders, busy, onSend }: Props) {
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

  function submit() {
    if (!input.trim() || busy || uploading) return;
    onSend({ prompt: input, attachments: pending.map(({ id, mime }) => ({ id, mime })) });
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
          'mx-auto max-w-3xl rounded-2xl border bg-ink-900 transition-colors',
          dragOver ? 'border-accent-500' : 'border-ink-700',
        )}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pending.map((p) => (
              <div key={p.id} className="relative">
                <img src={p.previewUrl} alt="pending" className="h-16 w-16 rounded-lg border border-ink-700 object-cover" />
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => removePending(p.id)}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-ink-800 p-0.5 text-ink-200 hover:text-ink-50"
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
          <button
            type="button"
            aria-label="Attach image"
            title="Attach an image — files coming soon"
            disabled={disabled || pending.length >= MAX_FILES}
            onClick={() => fileRef.current?.click()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-400 hover:bg-ink-800 hover:text-ink-100 disabled:opacity-40"
          >
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
          </button>

          <select
            aria-label="Skill"
            value={skillId}
            onChange={(e) => onSkillChange(e.target.value)}
            disabled={disabled}
            className="max-w-[9rem] shrink-0 truncate rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-xs text-ink-200 outline-none disabled:opacity-40"
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

          <button
            type="button"
            onClick={submit}
            disabled={disabled || uploading || !input.trim()}
            aria-label="Send"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-500 text-ink-950 hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl px-1 text-[11px] text-ink-400">
        Images now · file generation &amp; download coming soon.
      </p>
    </div>
  );
}
