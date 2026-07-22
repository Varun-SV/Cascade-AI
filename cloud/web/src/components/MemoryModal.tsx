import { useEffect, useMemo, useState } from 'react';
import { Brain, Plus, Trash2, Check, X, Pencil, Search } from 'lucide-react';
import Modal from './Modal.js';
import { addMemory, deleteMemory, fetchMemories, updateMemory } from '../lib/api.js';
import type { Memory } from '../lib/types.js';

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-300">
      {category}
    </span>
  );
}

export default function MemoryModal({ onClose }: { onClose: () => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [draft, setDraft] = useState('');
  const [draftCategory, setDraftCategory] = useState('');
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editCategory, setEditCategory] = useState('');
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
      const { memory } = await addMemory(content, draftCategory.trim() || null);
      setMemories((prev) => [...prev, memory]);
      setDraft('');
      setDraftCategory('');
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    const content = editText.trim();
    if (!content) return;
    const { memory } = await updateMemory(id, content, editCategory.trim() || null);
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
          <p>Facts Cascade keeps in mind across every chat. Tag them with a category and search any time.</p>
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
                  <input
                    className="w-32 rounded border border-elev/10 bg-elev/[0.04] px-2 py-1 text-xs text-ink-100 outline-none placeholder:text-ink-400"
                    placeholder="Category (optional)"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                  />
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
                    <span className="whitespace-pre-wrap break-words">{m.content}</span>
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-label="Edit memory"
                      onClick={() => { setEditingId(m.id); setEditText(m.content); setEditCategory(m.category ?? ''); }}
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
          <input
            className="w-40 rounded-md border border-elev/10 bg-elev/[0.04] px-2 py-1.5 text-xs text-ink-100 outline-none placeholder:text-ink-400"
            placeholder="Category (optional)"
            value={draftCategory}
            onChange={(e) => setDraftCategory(e.target.value)}
          />
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
