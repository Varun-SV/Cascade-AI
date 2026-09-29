import { useState } from 'react';
import { Sparkles, Plus, Trash2, Pencil, Check, X, Lock } from 'lucide-react';
import Modal from './Modal.js';
import { createSkill, deleteSkill, updateSkill } from '../lib/api.js';
import type { Skill } from '../lib/types.js';

interface Props {
  skills: Skill[];
  onClose: () => void;
  onChange: () => void;
  /** The skill the composer is using, and a way to switch to another from here. */
  activeSkillId?: string;
  onUse?: (id: string) => void;
  /** A run is working: it took its skill when it started, so switching waits for it to end. */
  useLocked?: boolean;
}

interface DraftState {
  id: string | null; // null = creating a new skill
  name: string;
  description: string;
  systemPrompt: string;
}

const EMPTY_DRAFT: DraftState = { id: null, name: '', description: '', systemPrompt: '' };

export default function SkillsModal({ skills, onClose, onChange, activeSkillId, onUse, useLocked = false }: Props) {
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

  const use = (id: string) =>
    !onUse ? null : id === activeSkillId ? (
      <span className="shrink-0 rounded-full bg-success-500/[0.14] px-2 py-px text-[11px] text-success-300">In use</span>
    ) : (
      <button
        type="button"
        onClick={() => onUse(id)}
        disabled={useLocked}
        title={useLocked ? 'Available when this run ends' : undefined}
        className="cz-btn cz-btn-quiet cz-btn-sm shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Use
      </button>
    );

  return (
    <Modal title="Skills" onClose={onClose} maxWidth="max-w-lg">
      <div className="flex flex-col gap-3.5 px-5 pb-5 pt-1.5 text-[14px] text-ink-50">
        <div className="flex items-center gap-2 text-xs text-ink-300">
          <Sparkles size={16} className="text-ink-400" />
          <p>Reusable personas Cascade adopts for a chat. Pick one here, or from the + menu in the composer.</p>
        </div>

        {draft ? (
          <div className="flex flex-col gap-2">
            <input
              className="cz-field text-[14px] placeholder:text-ink-500"
              placeholder="Name (e.g. SQL Tutor)"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
            <input
              className="cz-field text-[14px] placeholder:text-ink-500"
              placeholder="Short description (optional)"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <textarea
              className="cz-field h-auto min-h-[120px] resize-y py-2.5 text-[14px] placeholder:text-ink-500"
              placeholder="Instructions — the system prompt Cascade follows when this skill is active."
              value={draft.systemPrompt}
              onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            />
            {error && <p className="text-xs text-danger-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setDraft(null); setError(null); }}
                className="cz-btn cz-btn-quiet cz-btn-sm"
              >
                <X size={13} /> Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || !draft.name.trim() || !draft.systemPrompt.trim()}
                className="cz-btn cz-btn-sm"
              >
                <Check size={13} /> {draft.id ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setDraft({ ...EMPTY_DRAFT }); setError(null); }}
            className="cz-btn cz-btn-ghost cz-btn-sm self-start"
          >
            <Plus size={14} /> New skill
          </button>
        )}

        {custom.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11.5px] font-medium tracking-[0.02em] text-ink-500">Your skills</p>
            {custom.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 border-b border-elev/10 py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink-100">{s.name}</span>
                    <span className="shrink-0 rounded bg-elev/10 px-1.5 py-0.5 text-[10px] text-ink-400">
                      used {s.usageCount}×
                    </span>
                  </div>
                  {s.description && <p className="mt-0.5 truncate text-xs text-ink-400">{s.description}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {use(s.id)}
                  <button
                    type="button"
                    aria-label="Edit skill"
                    onClick={() => setDraft({ id: s.id, name: s.name, description: s.description, systemPrompt: s.systemPrompt ?? '' })}
                    className="cz-ib cz-ib-sm"
                  >
                    <Pencil size={13} />
                  </button>
                  <button type="button" aria-label="Delete skill" onClick={() => remove(s.id)} className="cz-ib cz-ib-sm">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <p className="text-[11.5px] font-medium tracking-[0.02em] text-ink-500">Built-in</p>
          {builtin.map((s) => (
            <div key={s.id} className="flex items-center gap-2.5 border-b border-elev/10 py-2.5 last:border-0">
              <Lock size={12} className="shrink-0 text-ink-500" />
              <div className="min-w-0 flex-1">
                <span className="font-medium text-ink-50">{s.name}</span>
                {s.description && <p className="truncate text-[12.5px] text-ink-500">{s.description}</p>}
              </div>
              {use(s.id)}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
