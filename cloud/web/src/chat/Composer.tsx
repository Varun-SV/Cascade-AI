import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { browserChip, CHECKING, type BrowserAllowanceView } from './browserAllowance.js';
import clsx from 'clsx';
import {
  ArrowUp, Paperclip, X, Loader2, Globe, Square, Zap, FileText, MonitorPlay, Plus, SlidersHorizontal,
  ChevronDown, Sparkles, Settings2, Plug,
} from 'lucide-react';
import Menu, { type MenuItem } from '../components/Menu.js';
import { fetchMcpServers, setMcpServerEnabled, uploadImage, uploadDocument, uploadUrl, type McpServer } from '../lib/api.js';
import type { Skill } from '../lib/types.js';
import type { ChatAttachment, ForceTier, RoutingMode, SendInput } from './useChatSession.js';

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Document MIME types + a filename-extension fallback (browsers often report a
// blank or octet-stream type for .md/.csv/.txt). Parsing happens server-side.
const DOC_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'application/json', 'text/json', 'application/xml', 'text/xml', 'text/html',
  'text/yaml', 'application/x-yaml', 'text/x-yaml',
]);
const DOC_EXT = /\.(pdf|docx|txt|md|markdown|csv|tsv|json|xml|html?|ya?ml)$/i;
const FILE_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,.docx,.txt,.md,.csv,.tsv,.json,.xml,.html,.yaml,.yml';
const MAX_FILES = 6;

function isImage(f: File): boolean {
  return ALLOWED.has(f.type);
}
function isDocument(f: File): boolean {
  return DOC_MIME.has(f.type) || DOC_EXT.test(f.name);
}

// An image is uploaded before it joins the list, so its preview is the
// server's copy (`uploadUrl`), exactly as the sent message will show it —
// not an object URL built in the page from the picked file.
type Pending = ChatAttachment;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const ROUTING_MODES: Array<{ value: RoutingMode; label: string; sub: string }> = [
  { value: 'auto', label: 'Auto', sub: 'Best value per step' },
  { value: 'quality', label: 'Quality', sub: 'Stronger models' },
  { value: 'fast', label: 'Fast', sub: 'Cheaper, quicker models' },
];

const FORCE_TIERS: ForceTier[] = ['auto', 'T1', 'T2', 'T3'];

/** How many browser sessions are left, for the Browser switch's second line. */
function browserSub(allowance: BrowserAllowanceView): string {
  if (allowance === CHECKING) return 'Checking today’s sessions…';
  if (!allowance) return 'A real browser for this run';
  const left = Math.max(0, allowance.limit - allowance.used);
  return left === 0 ? `All ${allowance.limit} used today` : `${left} of ${allowance.limit} left today`;
}

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
  browserMode: boolean;
  onBrowserModeChange: (on: boolean) => void;
  browserAvailable: boolean;
  /** Today's browser sessions against the plan's allowance. See `browserChip`. */
  browserAllowance?: BrowserAllowanceView;
  onWebSearchChange: (on: boolean) => void;
  onManageSkills?: () => void;
  onManageConnectors?: () => void;
  /** A suggestion from the empty state, placed in the box for the user to send or edit. */
  draftRequest?: { text: string; seq: number } | null;
}

type MenuKey = 'plus' | 'tools' | 'mode';

export default function Composer({
  skills, skillId, onSkillChange, hasProviders, busy, onSend, onStop,
  routingMode, onRoutingModeChange, forceTier, onForceTierChange, webSearch, onWebSearchChange,
  browserMode, onBrowserModeChange, browserAvailable, browserAllowance,
  onManageSkills, onManageConnectors, draftRequest,
}: Props) {
  const chip = browserChip(browserAllowance ?? null);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Fast answer applies to the next message only, like the prototype's toggle.
  const [fastNext, setFastNext] = useState(false);
  const [menu, setMenu] = useState<{ key: MenuKey; anchor: HTMLElement } | null>(null);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the draft, up to a limit, then scroll.
  useEffect(() => {
    const t = textRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    if (!draftRequest) return;
    setInput(draftRequest.text);
    textRef.current?.focus();
  }, [draftRequest]);

  // A run takes its options when it starts, so they are locked until it ends:
  // a switch flipped mid-run would describe a run that never had it.
  useEffect(() => {
    if (busy) setMenu(null);
  }, [busy]);

  // The tools menu lists your connectors; read them when it opens so a change
  // made in the Connectors window shows up here.
  useEffect(() => {
    if (menu?.key !== 'tools') return;
    fetchMcpServers().then((r) => setServers(r.servers)).catch(() => setServers([]));
  }, [menu?.key]);

  async function addFiles(files: FileList | File[]) {
    const usable = Array.from(files).filter((f) => isImage(f) || isDocument(f));
    if (!usable.length) return;
    setUploadError(null);
    setUploading(true);
    try {
      for (const file of usable) {
        if (pending.length >= MAX_FILES) break;
        try {
          const base64 = await fileToBase64(file);
          if (isImage(file)) {
            const { id, mime } = await uploadImage(file.type, base64);
            setPending((prev) =>
              prev.length >= MAX_FILES ? prev : [...prev, { id, mime, kind: 'image' }],
            );
          } else {
            const res = await uploadDocument(file.type || 'application/octet-stream', base64, file.name);
            setPending((prev) =>
              prev.length >= MAX_FILES
                ? prev
                : [...prev, { id: res.id, mime: res.mime, kind: 'document', filename: res.filename ?? file.name, charCount: res.charCount ?? null }],
            );
          }
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : `Couldn't add "${file.name}".`);
        }
      }
    } finally {
      setUploading(false);
    }
  }

  function removePending(id: string) {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }

  function submit() {
    if (!input.trim() || busy || uploading) return;
    onSend({
      prompt: input,
      attachments: pending.map(({ id, mime, kind, filename, charCount }) => ({ id, mime, kind, filename, charCount })),
      fast: fastNext,
    });
    setFastNext(false);
    setInput('');
    setUploadError(null);
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
    if (files.some((f) => isImage(f) || isDocument(f))) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  }


  async function toggleServer(server: McpServer) {
    const next = !server.enabled;
    setServers((prev) => prev?.map((s) => (s.id === server.id ? { ...s, enabled: next } : s)) ?? prev);
    try { await setMcpServerEnabled(server.id, next); }
    catch { setServers((prev) => prev?.map((s) => (s.id === server.id ? { ...s, enabled: !next } : s)) ?? prev); }
  }

  const skillName = skills.find((s) => s.id === skillId)?.name;
  const openMenu = (key: MenuKey) => (e: React.MouseEvent<HTMLElement>) => {
    const anchor = e.currentTarget;
    setMenu((m) => (m?.key === key ? null : { key, anchor }));
  };

  function itemsFor(key: MenuKey): MenuItem[] {
    if (key === 'plus') {
      return [
        {
          kind: 'action', label: 'Attach files', icon: <Paperclip size={15} />,
          disabled: !hasProviders || uploading || pending.length >= MAX_FILES,
          onSelect: () => fileRef.current?.click(),
        },
        { kind: 'separator' },
        { kind: 'label', label: 'Skill' },
        ...skills.map<MenuItem>((s) => ({ kind: 'radio', label: s.name, checked: s.id === skillId, onSelect: () => onSkillChange(s.id) })),
        ...(onManageSkills ? [{ kind: 'action', label: 'Manage skills', icon: <Settings2 size={15} />, onSelect: onManageSkills } as MenuItem] : []),
      ];
    }
    if (key === 'tools') {
      const list: MenuItem[] = [
        { kind: 'toggle', label: 'Web search', icon: <Globe size={15} />, checked: webSearch, onToggle: () => onWebSearchChange(!webSearch) },
      ];
      // Absent, not disabled, where no provider is configured: the capability
      // does not exist until an operator supplies an endpoint. Web and Browser
      // are mutually exclusive; `useChatSession` clears one when the other is set.
      if (browserAvailable) {
        list.push({
          kind: 'toggle', label: 'Browser', icon: <MonitorPlay size={15} />, checked: browserMode,
          sub: browserSub(browserAllowance ?? null), title: chip.title, disabled: chip.disabled,
          onToggle: () => onBrowserModeChange(!browserMode),
        });
      }
      list.push({ kind: 'separator' }, { kind: 'label', label: 'Connectors' });
      if (servers === null) list.push({ kind: 'custom', key: 'loading', render: <p className="m-0 px-[9px] py-1 text-[12.5px] text-ink-500">Loading…</p> });
      else if (servers.length === 0) list.push({ kind: 'custom', key: 'none', render: <p className="m-0 px-[9px] py-1 text-[12.5px] text-ink-500">None connected yet</p> });
      else list.push(...servers.map<MenuItem>((s) => ({ kind: 'toggle', label: s.name, icon: <Plug size={15} />, checked: s.enabled, onToggle: () => void toggleServer(s) })));
      if (onManageConnectors) list.push({ kind: 'action', label: 'Manage connectors', icon: <Settings2 size={15} />, onSelect: onManageConnectors });
      return list;
    }
    return [
      { kind: 'label', label: 'Routing' },
      ...ROUTING_MODES.map<MenuItem>((m) => ({ kind: 'radio', label: m.label, sub: m.sub, checked: routingMode === m.value, onSelect: () => onRoutingModeChange(m.value) })),
      { kind: 'separator' },
      { kind: 'label', label: 'Tier' },
      ...FORCE_TIERS.map<MenuItem>((t) => ({ kind: 'radio', label: t === 'auto' ? 'Let Cascade decide' : `${t} only`, checked: forceTier === t, onSelect: () => onForceTierChange(t) })),
      { kind: 'separator' },
      { kind: 'toggle', label: 'Fast answer', sub: 'Next message skips orchestration', icon: <Zap size={15} />, checked: fastNext, onToggle: () => setFastNext((f) => !f) },
    ];
  }

  // What is switched on shows as a chip beside the menus, with its own way off —
  // a billed capability like the browser is never on without saying so.
  const tokens: Array<{ key: string; icon: ReactNode; label: string; off: () => void }> = [];
  if (fastNext) tokens.push({ key: 'fast', icon: <Zap size={14} />, label: 'Fast answer', off: () => setFastNext(false) });
  if (webSearch) tokens.push({ key: 'web', icon: <Globe size={14} />, label: 'Web', off: () => onWebSearchChange(false) });
  if (browserMode) tokens.push({ key: 'browser', icon: <MonitorPlay size={14} />, label: 'Browser', off: () => onBrowserModeChange(false) });
  if (skillId && skillId !== 'general' && skillName) tokens.push({ key: 'skill', icon: <Sparkles size={14} />, label: skillName, off: () => onSkillChange('general') });

  const routeLabel = ROUTING_MODES.find((m) => m.value === routingMode)?.label ?? 'Auto';
  const canSend = hasProviders && !busy && !uploading && input.trim().length > 0;

  return (
    <div
      className={clsx(
        'flex flex-col rounded-[20px] bg-card p-2 transition-shadow',
        dragOver ? 'ring-2 ring-accent-500' : '',
      )}
      style={{ boxShadow: 'var(--glass-shadow), inset 0 0 0 1px rgb(var(--c-elev) / 0.17)' }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <input
        ref={fileRef}
        type="file"
        accept={FILE_ACCEPT}
        multiple
        hidden
        onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
      />
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1.5 pb-0.5 pt-1.5">
          {pending.map((p) =>
            p.kind === 'document' ? (
              <div
                key={p.id}
                className="relative inline-flex h-[34px] max-w-[240px] items-center gap-[7px] rounded-lg bg-card px-2.5 text-[12.5px] text-ink-100"
                style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--c-elev) / 0.17)' }}
              >
                <FileText size={14} className="shrink-0 text-ink-300" />
                <span className="truncate">{p.filename ?? 'document'}</span>
                {typeof p.charCount === 'number' && p.charCount > 0 && (
                  <span className="font-mono text-ink-500">{p.charCount >= 1000 ? `${Math.round(p.charCount / 1000)}k` : p.charCount}</span>
                )}
                <RemoveAttachment onClick={() => removePending(p.id)} />
              </div>
            ) : (
              <div key={p.id} className="relative">
                <img src={uploadUrl(p.id)} alt="pending" className="block h-[52px] w-[52px] rounded-lg object-cover" />
                <RemoveAttachment onClick={() => removePending(p.id)} />
              </div>
            ),
          )}
        </div>
      )}
      {uploadError && <div className="px-2 pt-1.5 text-[12px] text-danger-500">{uploadError}</div>}

      <textarea
        ref={textRef}
        aria-label="Message Cascade"
        className="max-h-[200px] min-h-12 w-full resize-none bg-transparent px-2 pb-1.5 pt-2 text-[15.5px] leading-[1.45] text-ink-50 outline-none placeholder:text-ink-500"
        placeholder={hasProviders ? 'Ask Cascade anything' : 'Add an API key to start'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        disabled={!hasProviders}
        rows={1}
      />

      <div className="flex flex-wrap items-center gap-1">
        <button type="button" aria-label="Attach and skills" aria-haspopup="menu" aria-expanded={menu?.key === 'plus'} onClick={openMenu('plus')} disabled={busy} className="cz-ib">
          {uploading ? <Loader2 size={17} className="animate-spin" /> : <Plus size={17} />}
        </button>
        <button
          type="button"
          aria-label="Tools"
          aria-haspopup="menu"
          aria-expanded={menu?.key === 'tools'}
          onClick={openMenu('tools')}
          disabled={busy}
          className={clsx('cz-ib', (webSearch || browserMode) && 'text-accent-500')}
        >
          <SlidersHorizontal size={17} />
        </button>
        {tokens.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tokens.map((t) => (
              <span key={t.key} className="cz-chip" aria-pressed="true">
                {t.icon} {t.label}
                {!busy && (
                  <button type="button" aria-label={`Remove ${t.label}`} onClick={t.off} className="inline-flex opacity-70 hover:opacity-100">
                    <X size={14} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu?.key === 'mode'}
          title="Routing and tier"
          onClick={openMenu('mode')}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-[5px] text-[13px] text-ink-300 hover:bg-elev/[0.05] hover:text-ink-50 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
        >
          <b className="font-medium text-ink-50">{routeLabel}</b>
          {forceTier !== 'auto' && <span>· {forceTier}</span>}
          <ChevronDown size={14} />
        </button>
        {busy ? (
          <button type="button" aria-label="Stop" title="Stop this run" onClick={onStop} className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-ink-50 text-paper">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            onClick={submit}
            disabled={!canSend}
            className={clsx(
              'inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] transition-colors',
              canSend ? 'bg-accent-500 text-white hover:bg-accent-600' : 'cursor-not-allowed bg-sunk text-ink-500',
            )}
          >
            <ArrowUp size={16} />
          </button>
        )}
      </div>
      {menu && (
        <Menu
          label={menu.key === 'plus' ? 'Attach and skills' : menu.key === 'tools' ? 'Tools' : 'Routing and tier'}
          anchor={menu.anchor}
          items={itemsFor(menu.key)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function RemoveAttachment({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Remove attachment"
      onClick={onClick}
      className="absolute -right-[7px] -top-[7px] flex h-[19px] w-[19px] items-center justify-center rounded-full bg-card p-0 text-ink-300"
      style={{ boxShadow: '0 0 0 1px rgb(var(--c-elev) / 0.17)' }}
    >
      <X size={12} />
    </button>
  );
}
