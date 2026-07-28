import { useEffect, useMemo, useState } from 'react';
import { Brain, Plus, Trash2, Check, X, Pencil, Search } from 'lucide-react';
import Modal from './Modal.js';
import { addMemory, deleteMemory, fetchMemories, updateMemory } from '../lib/api.js';
import type { Memory, MemoryDurability } from '../lib/types.js';

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-300">
      {category}
    </span>
  );
}

/**
 * Marks a fact the model is told to distrust when the user contradicts it.
 * Only "Current" is badged: permanent is the default and the common case, so
 * labelling every row would be noise that hides the ones that matter.
 */
function DurabilityBadge({ durability }: { durability: MemoryDurability }) {
  if (durability !== 'volatile') return null;
  return (
    <span
      title="Current context — expected to change. Cascade prefers what you say now if it conflicts."
      className="rounded bg-elev/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-300"
    >
      current
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
      <option value="volatile">Current context</option>
    </select>
  );
}

export default function MemoryModal({ onClose }: { onClose: () => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [draft, setDraft] = useState('');
  const [draftCategory, setDraftCategory] = useState('');
  const [draftDurability, setDraftDurability] = useState<MemoryDurability>('permanent');
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editDurability, setEditDurability] = useState<MemoryDurability>('permanent');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchMemories().then((r) => setMemories(r.memories)).catch(() => setMemories([]));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memories;
    return memories.filter(
      (m) => m.content.toLowerCase().includes(q) || (m.category ?? '').toLowerCase().includes(q),
    );
  }, [memories, query]);

  async function add() {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const { memory } = await addMemory(content, draftCategory.trim() || null, draftDurability);
      setMemories((prev) => [...prev, memory]);
      setDraft('');
      setDraftCategory('');
      setDraftDurability('permanent');
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    const content = editText.trim();
    if (!content) return;
    const { memory } = await updateMemory(id, content, editCategory.trim() || null, editDurability);
    setMemories((prev) => prev.map((m) => (m.id === id ? memory : m)));
    setEditingId(null);
  }

  async function remove(id: string) {
    await deleteMemory(id);
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }

  return (
    <Modal title="Memory" onClose={onClose}>
      <div className="flex flex-col gap-3 p-4 text-sm text-ink-100">
        <div className="flex items-center gap-2 text-xs text-ink-300">
          <Brain size={16} className="text-ink-400" />
          <p>
            Facts Cascade keeps in mind across every chat. Mark a fact “Current context” when it is
            true now but expected to change — Cascade will prefer what you say in the moment over it.
          </p>
        </div>

        {memories.length > 3 && (
          <div className="flex items-center gap-2 rounded-md border border-elev/10 bg-elev/[0.04] px-2.5 py-1.5">
            <Search size={13} className="text-ink-400" />
            <input
              className="flex-1 bg-transparent text-sm text-ink-100 outline-none placeholder:text-ink-400"
              placeholder="Search memories…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        <div className="flex max-h-[45dvh] flex-col gap-2 overflow-y-auto">
          {memories.length === 0 && (
            <p className="rounded-md border border-dashed border-elev/10 px-3 py-4 text-center text-xs text-ink-400">
              No memories yet. Add something Cascade should remember about you.
            </p>
          )}
          {memories.length > 0 && filtered.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-ink-400">No memories match “{query}”.</p>
          )}
          {filtered.map((m) => (
            <div key={m.id} className="flex items-start justify-between gap-2 rounded-md bg-elev/[0.05] px-3 py-2">
              {editingId === m.id ? (
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      className="w-32 rounded border border-elev/10 bg-elev/[0.04] px-2 py-1 text-xs text-ink-100 outline-none placeholder:text-ink-400"
                      placeholder="Category (optional)"
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value)}
                    />
                    <DurabilityPicker value={editDurability} onChange={setEditDurability} />
                  </div>
                  <div className="flex items-start gap-2">
                    <textarea
                      className="flex-1 resize-none rounded border border-elev/10 bg-elev/[0.04] px-2 py-1 text-sm text-ink-100 outline-none"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                      autoFocus
                    />
                    <div className="flex shrink-0 gap-1">
                      <button type="button" aria-label="Save" onClick={() => saveEdit(m.id)} className="p-1 text-success-500 hover:text-success-300">
                        <Check size={14} />
                      </button>
                      <button type="button" aria-label="Cancel" onClick={() => setEditingId(null)} className="p-1 text-ink-400 hover:text-ink-100">
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <span className="flex flex-1 flex-col gap-1">
                    {m.category && <span><CategoryBadge category={m.category} /></span>}
                    <DurabilityBadge durability={m.durability} />
                    <span className="whitespace-pre-wrap break-words">{m.content}</span>
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-label="Edit memory"
                      onClick={() => { setEditingId(m.id); setEditText(m.content); setEditCategory(m.category ?? ''); setEditDurability(m.durability); }}
                      className="p-1 text-ink-400 hover:text-ink-100"
                    >
                      <Pencil size={13} />
                    </button>
                    <button type="button" aria-label="Delete memory" onClick={() => remove(m.id)} className="p-1 text-ink-400 hover:text-danger-500">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 border-t border-elev/10 pt-3">
          <div className="flex items-center gap-2">
            <input
              className="w-40 rounded-md border border-elev/10 bg-elev/[0.04] px-2 py-1.5 text-xs text-ink-100 outline-none placeholder:text-ink-400"
              placeholder="Category (optional)"
              value={draftCategory}
              onChange={(e) => setDraftCategory(e.target.value)}
            />
            <DurabilityPicker value={draftDurability} onChange={setDraftDurability} />
          </div>
          <div className="flex items-end gap-2">
            <textarea
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
      </div>
    </Modal>
  );
}
