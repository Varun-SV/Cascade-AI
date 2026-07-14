import { useState } from 'react';
import { Sparkles, Plus, Trash2, Pencil, Check, X, Lock } from 'lucide-react';
import Modal from './Modal.js';
import { createSkill, deleteSkill, updateSkill } from '../lib/api.js';
import type { Skill } from '../lib/types.js';

interface Props {
  skills: Skill[];
  onClose: () => void;
  onChange: () => void;
}

interface DraftState {
  id: string | null; // null = creating a new skill
  name: string;
  description: string;
  systemPrompt: string;
}

const EMPTY_DRAFT: DraftState = { id: null, name: '', description: '', systemPrompt: '' };

export default function SkillsModal({ skills, onClose, onChange }: Props) {
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const custom = skills.filter((s) => s.custom);
  const builtin = skills.filter((s) => !s.custom);

  async function save() {
    if (!draft || busy) return;
    const input = { name: draft.name.trim(), description: draft.description.trim(), systemPrompt: draft.systemPrompt.trim() };
    if (!input.name || !input.systemPrompt) { setError('Name and instructions are required.'); return; }
    setBusy(true);
    setError(null);
    try {
      if (draft.id) await updateSkill(draft.id, input);
      else await createSkill(input);
      setDraft(null);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save skill.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await deleteSkill(id);
    onChange();
  }

  return (
    <Modal title="Skills" onClose={onClose} maxWidth="max-w-lg">
      <div className="flex flex-col gap-3 p-4 text-sm text-ink-100">
        <div className="flex items-center gap-2 text-xs text-ink-300">
          <Sparkles size={16} className="text-ink-400" />
          <p>Reusable personas Cascade adopts for a chat. Pick one from the composer’s skill menu.</p>
        </div>

        {draft ? (
          <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.04] p-3">
            <input
              className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-400"
              placeholder="Name (e.g. SQL Tutor)"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
            <input
              className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-400"
              placeholder="Short description (optional)"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <textarea
              className="min-h-[120px] resize-y rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-400"
              placeholder="Instructions — the system prompt Cascade follows when this skill is active."
              value={draft.systemPrompt}
              onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            />
            {error && <p className="text-xs text-danger-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setDraft(null); setError(null); }}
                className="flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-ink-300 hover:bg-white/10 hover:text-ink-100"
              >
                <X size={13} /> Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || !draft.name.trim() || !draft.systemPrompt.trim()}
                className="flex items-center gap-1 rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-accent-400 disabled:opacity-40"
              >
                <Check size={13} /> {draft.id ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setDraft({ ...EMPTY_DRAFT }); setError(null); }}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 px-3 py-2.5 text-xs font-medium text-ink-300 hover:border-accent-500/40 hover:text-ink-100"
          >
            <Plus size={14} /> New skill
          </button>
        )}

        {custom.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Your skills</p>
            {custom.map((s) => (
              <div key={s.id} className="flex items-start justify-between gap-2 rounded-md bg-white/[0.05] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink-100">{s.name}</span>
                    <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-ink-400">
                      used {s.usageCount}×
                    </span>
                  </div>
                  {s.description && <p className="mt-0.5 truncate text-xs text-ink-400">{s.description}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label="Edit skill"
                    onClick={() => setDraft({ id: s.id, name: s.name, description: s.description, systemPrompt: s.systemPrompt ?? '' })}
                    className="p-1 text-ink-400 hover:text-ink-100"
                  >
                    <Pencil size={13} />
                  </button>
                  <button type="button" aria-label="Delete skill" onClick={() => remove(s.id)} className="p-1 text-ink-400 hover:text-danger-500">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Built-in</p>
          {builtin.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-3 py-2 text-ink-300">
              <Lock size={12} className="shrink-0 text-ink-500" />
              <div className="min-w-0">
                <span className="font-medium text-ink-200">{s.name}</span>
                {s.description && <p className="truncate text-xs text-ink-500">{s.description}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
