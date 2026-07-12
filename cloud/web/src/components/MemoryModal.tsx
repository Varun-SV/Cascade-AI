import { useEffect, useState } from 'react';
import { Brain, Plus, Trash2, Check, X, Pencil } from 'lucide-react';
import Modal from './Modal.js';
import { addMemory, deleteMemory, fetchMemories, updateMemory } from '../lib/api.js';
import type { Memory } from '../lib/types.js';

export default function MemoryModal({ onClose }: { onClose: () => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchMemories().then((r) => setMemories(r.memories)).catch(() => setMemories([]));
  }, []);

  async function add() {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const { memory } = await addMemory(content);
      setMemories((prev) => [...prev, memory]);
      setDraft('');
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    const content = editText.trim();
    if (!content) return;
    const { memory } = await updateMemory(id, content);
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
          <p>Facts Cascade keeps in mind across every chat. Add, edit, or remove them any time.</p>
        </div>

        <div className="flex flex-col gap-2">
          {memories.length === 0 && (
            <p className="rounded-md border border-dashed border-ink-700 px-3 py-4 text-center text-xs text-ink-400">
              No memories yet. Add something Cascade should remember about you.
            </p>
          )}
          {memories.map((m) => (
            <div key={m.id} className="flex items-start justify-between gap-2 rounded-md bg-ink-800 px-3 py-2">
              {editingId === m.id ? (
                <>
                  <textarea
                    className="flex-1 resize-none rounded border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none"
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
                </>
              ) : (
                <>
                  <span className="flex-1 whitespace-pre-wrap break-words">{m.content}</span>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-label={`Edit memory`}
                      onClick={() => { setEditingId(m.id); setEditText(m.content); }}
                      className="p-1 text-ink-400 hover:text-ink-100"
                    >
                      <Pencil size={13} />
                    </button>
                    <button type="button" aria-label={`Delete memory`} onClick={() => remove(m.id)} className="p-1 text-ink-400 hover:text-danger-500">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-end gap-2">
          <textarea
            className="flex-1 resize-none rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-400"
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
            className="flex h-9 items-center gap-1 rounded-md bg-accent-500 px-3 text-xs font-semibold text-ink-950 hover:bg-accent-400 disabled:opacity-40"
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </div>
    </Modal>
  );
}
