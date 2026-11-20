import { useEffect, useMemo, useState } from 'react';
import { Brain, Plus, Trash2, Check, X, Pencil, Search, Sparkles, ChevronDown, ChevronRight, Quote, History } from 'lucide-react';
import Modal from './Modal.js';
import MemoryBuilder, { type BuildSocket } from './MemoryBuilder.js';
import { addMemory, deleteMemory, fetchMemories, updateMemory } from '../lib/api.js';
import { MEMORY_CATEGORIES, groupOf, labelOf, type MemoryCategoryId } from '../lib/memory-categories.js';
import type { Memory, MemoryDurability, ProviderConfig } from '../lib/types.js';

/**
 * Marks a fact the model is told to distrust when the user contradicts it.
 * Only "True for now" is badged: permanent is the default and the common case,
 * so labelling every row would be noise that hides the ones that matter.
 */
function DurabilityBadge({ durability }: { durability: MemoryDurability }) {
  if (durability !== 'volatile') return null;
  return (
    <span
      title="True for now and expected to change. Cascade prefers what you say in the moment if it conflicts."
      className="rounded bg-elev/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-300"
    >
      for now
    </span>
  );
}

function DurabilityPicker({ value, onChange }: { value: MemoryDurability; onChange: (v: MemoryDurability) => void }) {
  return (
    <select
      aria-label="How long should this hold?"
      className="rounded border border-elev/10 bg-elev/[0.04] px-2 py-1 text-xs text-ink-100 outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value === 'volatile' ? 'volatile' : 'permanent')}
    >
      <option value="permanent">Always true</option>
      <option value="volatile">True for now</option>
    </select>
  );
}

/** A memory's category, picked from the six. One saved before keeps its own label as the first option. */
function CategoryPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const custom = value && groupOf(value) === 'other';
  return (
    <select
      aria-label="Category"
      className="rounded border border-elev/10 bg-elev/[0.04] px-2 py-1 text-xs text-ink-100 outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {custom && <option value={value}>{value}</option>}
      {MEMORY_CATEGORIES.map((c) => <option key={c.id} value={c.id} title={c.hint}>{c.label}</option>)}
    </select>
  );
}

function sourceLine(m: Memory): string | null {
  const chats = new Set((m.evidence ?? []).map((e) => e.conversationId)).size;
  if (chats) return `From ${chats} ${chats === 1 ? 'chat' : 'chats'}`;
  if (m.source === 'session') return 'From a remembered chat';
  if (m.source === 'import') return 'Imported';
  return null;
}

function MemoryRow({ m, onSaved, onDelete }: { m: Memory; onSaved: (m: Memory) => void; onDelete: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(m.content);
  const [category, setCategory] = useState(m.category ?? 'facts');
  const [durability, setDurability] = useState<MemoryDurability>(m.durability);
  const source = sourceLine(m);
  const hasDetail = (m.evidence?.length ?? 0) > 0 || (m.revisions?.length ?? 0) > 0;

  // Every field starts from the memory as it is now: a cancelled change to its
  // category or durability must not ride along with the next edit's save.
  function startEdit() {
    setText(m.content);
    setCategory(m.category ?? 'facts');
    setDurability(m.durability);
    setEditing(true);
  }

  async function save() {
    const content = text.trim();
    if (!content) return;
    const { memory } = await updateMemory(m.id, content, category || null, durability);
    onSaved(memory);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5 rounded-md bg-elev/[0.05] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <CategoryPicker value={category} onChange={setCategory} />
          <DurabilityPicker value={durability} onChange={setDurability} />
        </div>
        <div className="flex items-start gap-2">
          <textarea
            aria-label="Memory"
            className="flex-1 resize-none rounded border border-elev/10 bg-elev/[0.04] px-2 py-1 text-sm text-ink-100 outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            autoFocus
          />
          <div className="flex shrink-0 gap-1">
            <button type="button" aria-label="Save" onClick={save} className="p-1 text-success-500 hover:text-success-300"><Check size={14} /></button>
            <button type="button" aria-label="Cancel" onClick={() => setEditing(false)} className="p-1 text-ink-400 hover:text-ink-100"><X size={14} /></button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col gap-1 rounded-md bg-elev/[0.05] px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <span className="flex-1 whitespace-pre-wrap break-words">{m.content}</span>
        <div className="flex shrink-0 gap-1">
          <button type="button" aria-label="Edit memory" onClick={startEdit} className="p-1 text-ink-400 hover:text-ink-100"><Pencil size={13} /></button>
          <button type="button" aria-label="Delete memory" onClick={() => onDelete(m.id)} className="p-1 text-ink-400 hover:text-danger-500"><Trash2 size={13} /></button>
        </div>
      </div>
      {(source || m.durability === 'volatile' || groupOf(m.category) === 'other') && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
          <DurabilityBadge durability={m.durability} />
          {groupOf(m.category) === 'other' && m.category && (
            <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-300">{m.category}</span>
          )}
          {hasDetail ? (
            <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-0.5 hover:text-ink-100">
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {source ?? 'Details'}
              {(m.revisions?.length ?? 0) > 0 && ` · updated ${m.revisions!.length}×`}
            </button>
          ) : source && <span>{source}</span>}
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-1 border-l border-elev/15 pl-2">
          {(m.evidence ?? []).map((e, k) => (
            <p key={k} className="flex items-start gap-1 text-[11px] italic text-ink-400"><Quote size={10} className="mt-0.5 shrink-0" /> {e.quote}</p>
          ))}
          {(m.revisions ?? []).map((r, k) => (
            <p key={`r${k}`} className="flex items-start gap-1 text-[11px] text-ink-400 line-through decoration-ink-400/40"><History size={10} className="mt-0.5 shrink-0" /> {r.content}</p>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MemoryModal({ onClose, socket = null, providers = [] }: {
  onClose: () => void;
  socket?: BuildSocket | null;
  providers?: ProviderConfig[];
}) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [view, setView] = useState<'list' | 'build'>('list');
  const [draft, setDraft] = useState('');
  const [draftCategory, setDraftCategory] = useState<string>('preferences');
  const [draftDurability, setDraftDurability] = useState<MemoryDurability>('permanent');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = () => fetchMemories().then((r) => setMemories(r.memories)).catch(() => setMemories([]));
  useEffect(() => { void load(); }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (memories ?? []).filter((m) => !q || m.content.toLowerCase().includes(q) || (m.category ?? '').toLowerCase().includes(q));
    const order: Array<MemoryCategoryId | 'other'> = [...MEMORY_CATEGORIES.map((c) => c.id), 'other'];
    return order
      .map((id) => ({ id, label: labelOf(id), items: list.filter((m) => groupOf(m.category) === id) }))
      .filter((g) => g.items.length);
  }, [memories, query]);

  const total = memories?.length ?? 0;
  const shown = groups.reduce((n, g) => n + g.items.length, 0);

  async function add() {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const { memory } = await addMemory(content, draftCategory, draftDurability);
      setMemories((prev) => [...(prev ?? []), memory]);
      setDraft('');
      setDraftDurability('permanent');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await deleteMemory(id);
    setMemories((prev) => (prev ?? []).filter((m) => m.id !== id));
  }

  function toggleGroup(id: string) {
    setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  return (
    <Modal title="Memory" onClose={onClose} maxWidth="max-w-xl">
      <div className="flex flex-col gap-3 p-4 text-sm text-ink-100">
        {view === 'build' ? (
          <MemoryBuilder
            socket={socket}
            providers={providers}
            onBack={() => setView('list')}
            onDone={() => { setView('list'); void load(); }}
          />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <p className="flex items-start gap-2 text-xs text-ink-300">
                <Brain size={16} className="mt-0.5 shrink-0 text-ink-400" />
                What Cascade keeps in mind about you, in every chat.
              </p>
              <button
                type="button"
                onClick={() => setView('build')}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-accent-500/40 px-2.5 py-1.5 text-xs font-semibold text-accent-300 hover:bg-accent-500/10"
              >
                <Sparkles size={13} /> Build from my chats
              </button>
            </div>

            {/* Shown while a search is on, however few are left: a filter must never hide memories with no way to clear it. */}
            {(total > 5 || query) && (
              <div className="flex items-center gap-2 rounded-md border border-elev/10 bg-elev/[0.04] px-2.5 py-1.5">
                <Search size={13} className="text-ink-400" />
                <input
                  className="flex-1 bg-transparent text-sm text-ink-100 outline-none placeholder:text-ink-400"
                  placeholder="Search memories…"
                  aria-label="Search memories"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )}

            <div className="flex max-h-[40dvh] flex-col gap-3 overflow-y-auto">
              {memories !== null && total === 0 && (
                <p className="rounded-md border border-dashed border-elev/10 px-3 py-4 text-center text-xs text-ink-400">
                  No memories yet. Add one below, or build them from your chats.
                </p>
              )}
              {total > 0 && shown === 0 && <p className="px-3 py-4 text-center text-xs text-ink-400">No memories match “{query}”.</p>}
              {groups.map((g) => {
                const isOpen = !collapsed.has(g.id) || !!query.trim();
                return (
                  <section key={g.id} aria-label={g.label} className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => toggleGroup(g.id)}
                      className="flex items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-400 hover:text-ink-100"
                    >
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      {g.label} <span className="font-normal normal-case tracking-normal">({g.items.length})</span>
                    </button>
                    {isOpen && g.items.map((m) => (
                      <MemoryRow
                        key={m.id}
                        m={m}
                        onSaved={(next) => setMemories((prev) => (prev ?? []).map((x) => (x.id === next.id ? next : x)))}
                        onDelete={remove}
                      />
                    ))}
                  </section>
                );
              })}
            </div>

            <div className="flex flex-col gap-2 border-t border-elev/10 pt-3">
              <div className="flex items-center gap-2">
                <CategoryPicker value={draftCategory} onChange={setDraftCategory} />
                <DurabilityPicker value={draftDurability} onChange={setDraftDurability} />
              </div>
              <div className="flex items-end gap-2">
                <textarea
                  aria-label="New memory"
                  className="flex-1 resize-none rounded-md border border-elev/10 bg-elev/[0.04] px-2 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-400"
                  placeholder="e.g. I prefer TypeScript and concise answers"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void add(); } }}
                  rows={2}
                />
                <button
                  type="button"
                  onClick={add}
                  disabled={busy || !draft.trim()}
                  className="flex h-9 items-center gap-1 rounded-md bg-accent-500 px-3 text-xs font-semibold text-white hover:bg-accent-400 disabled:opacity-40"
                >
                  <Plus size={14} /> Add
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
