import { useEffect, useRef, useState } from 'react';
import { Sparkles, Plus, Trash2, Pencil, Check, X, Lock, Wand2, Loader2, Square, MessagesSquare } from 'lucide-react';
import Modal from './Modal.js';
import SkillSuggest from './SkillSuggest.js';
import { createSkill, deleteSkill, updateSkill } from '../lib/api.js';
import { cancelSkillAi, draftSkill, refineSkill, type SkillAiSocket, type SkillDraft, type SkillSuggestion } from '../lib/skill-ai.js';
import type { ProviderConfig, Skill } from '../lib/types.js';

interface Props {
  skills: Skill[];
  onClose: () => void;
  onChange: () => void;
  /** The skill the composer is using, and a way to switch to another from here. */
  activeSkillId?: string;
  onUse?: (id: string) => void;
  /** A run is working: it took its skill when it started, so switching waits for it to end. */
  useLocked?: boolean;
  /** For writing skills with the person's own model. Without them, the AI help is not offered. */
  socket?: SkillAiSocket | null;
  providers?: ProviderConfig[];
}

interface DraftState {
  id: string | null; // null = creating a new skill
  name: string;
  description: string;
  systemPrompt: string;
}

const EMPTY_DRAFT: DraftState = { id: null, name: '', description: '', systemPrompt: '' };

export default function SkillsModal({ skills, onClose, onChange, activeSkillId, onUse, useLocked = false, socket = null, providers = [] }: Props) {
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'suggest'>('list');
  /** What the person asked the model for: a new skill's purpose, or a change to this one. */
  const [ask, setAsk] = useState('');
  const [thinking, setThinking] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  /** A proposed change to an existing skill, shown beside what it replaces until accepted. */
  const [proposal, setProposal] = useState<{ before: SkillDraft; after: SkillDraft } | null>(null);
  const aiRunning = useRef(false);
  /** Which form a model answer belongs to: bumped whenever another form opens, so a late answer is dropped. */
  const formToken = useRef(0);
  /** Suggestions from the last pass, kept while one of them is open in the form. */
  const [suggestions, setSuggestions] = useState<SkillSuggestion[] | null>(null);
  /** The suggestion the open form came from, so saving it takes it off the list and cancelling goes back. */
  const [fromSuggestion, setFromSuggestion] = useState<number | null>(null);
  const canAi = !!socket && providers.length > 0;

  // Closing while the model writes stops it.
  useEffect(() => () => { if (aiRunning.current && socket) cancelSkillAi(socket); }, [socket]);

  function openDraft(next: DraftState) {
    formToken.current += 1;
    // A model still writing for the form being left is stopped: its answer is for that form.
    if (aiRunning.current && socket) cancelSkillAi(socket);
    aiRunning.current = false;
    setThinking(false);
    setDraft(next);
    setFromSuggestion(null);
    setError(null);
    setAsk('');
    setAiError(null);
    setProposal(null);
  }

  async function writeWithAi() {
    if (!socket || !draft || !ask.trim() || thinking) return;
    const token = formToken.current;
    setThinking(true);
    setAiError(null);
    aiRunning.current = true;
    if (draft.id) {
      // An existing skill, as the form holds it now: unsaved edits are what the change is made to.
      // The proposal is shown beside it, and applied only on "Use this".
      const r = await refineSkill(socket, providers, draft.id, ask.trim(), { name: draft.name, description: draft.description, instructions: draft.systemPrompt });
      if (token !== formToken.current) return;
      aiRunning.current = false;
      setThinking(false);
      if (!r.ok) { if ('error' in r) setAiError(r.error); return; }
      setProposal({ before: r.value.before, after: r.value.draft });
      return;
    }
    const r = await draftSkill(socket, providers, ask.trim());
    if (token !== formToken.current) return;
    aiRunning.current = false;
    setThinking(false);
    if (!r.ok) { if ('error' in r) setAiError(r.error); return; }
    const out = r.value.draft;
    setDraft((d) => (d ? { ...d, name: out.name, description: out.description, systemPrompt: out.instructions } : d));
  }

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
      // Saved from a suggestion: it leaves the list, and the rest are still there to add.
      if (fromSuggestion !== null && suggestions) {
        const rest = suggestions.filter((_, i) => i !== fromSuggestion);
        setSuggestions(rest);
        setFromSuggestion(null);
        if (rest.length) setView('suggest');
      }
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

        {view === 'suggest' ? (
          <SkillSuggest
            socket={socket}
            providers={providers}
            onBack={() => { setView('list'); setSuggestions(null); }}
            results={suggestions}
            onResults={setSuggestions}
            onAdd={(d, index) => {
              setView('list');
              openDraft({ id: null, name: d.name, description: d.description, systemPrompt: d.instructions });
              setFromSuggestion(index);
            }}
          />
        ) : draft ? (
          <div className="flex flex-col gap-2">
            {canAi && (
              <div className="flex flex-col gap-2 rounded-lg border border-t2/25 bg-t2/[0.06] p-2.5">
                <label className="flex items-center gap-1.5 text-[12px] font-medium text-ink-200" htmlFor="skill-ai-ask">
                  <Wand2 size={13} className="text-t2" /> {draft.id ? 'Improve with AI' : 'Write it with AI'}
                </label>
                <div className="flex items-end gap-2">
                  <textarea
                    id="skill-ai-ask"
                    className="cz-field h-auto min-h-[44px] flex-1 resize-none py-2 text-[13px] placeholder:text-ink-500"
                    rows={2}
                    placeholder={draft.id ? 'What should change? e.g. be stricter about SQL joins, and answer in bullet points' : 'What is it for? e.g. review my pull requests for security issues and explain each finding'}
                    value={ask}
                    onChange={(e) => setAsk(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void writeWithAi(); } }}
                    disabled={thinking}
                  />
                  {thinking ? (
                    <button type="button" onClick={() => socket && cancelSkillAi(socket)} className="cz-btn cz-btn-quiet cz-btn-sm shrink-0">
                      <Square size={12} /> Stop
                    </button>
                  ) : (
                    <button type="button" onClick={() => void writeWithAi()} disabled={ask.trim().length < 3} className="cz-btn cz-btn-sm shrink-0">
                      {draft.id ? <Wand2 size={13} /> : <Sparkles size={13} />} {draft.id ? 'Improve' : draft.systemPrompt ? 'Rewrite' : 'Write it'}
                    </button>
                  )}
                </div>
                {thinking && <p className="flex items-center gap-1.5 text-[11.5px] text-ink-400"><Loader2 size={12} className="animate-spin" /> Your model is writing it…</p>}
                {aiError && <p role="alert" className="text-[11.5px] text-danger-400">{aiError}</p>}
                {proposal && (
                  <div className="flex flex-col gap-2 rounded-md border border-elev/15 bg-ink-950/30 p-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <section aria-label="Now" className="flex min-w-0 flex-col gap-1">
                        <p className="text-[11px] font-medium text-ink-500">Now</p>
                        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] text-ink-400 line-through decoration-ink-500/40">{proposal.before.instructions}</p>
                      </section>
                      <section aria-label="Proposed" className="flex min-w-0 flex-col gap-1">
                        <p className="text-[11px] font-medium text-t2">Proposed{proposal.after.name !== proposal.before.name ? ` · renamed “${proposal.after.name}”` : ''}</p>
                        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] text-ink-100">{proposal.after.instructions}</p>
                      </section>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setProposal(null)} className="cz-btn cz-btn-quiet cz-btn-sm">Discard</button>
                      <button
                        type="button"
                        onClick={() => {
                          const after = proposal.after;
                          setDraft((d) => (d ? { ...d, name: after.name, description: after.description, systemPrompt: after.instructions } : d));
                          setProposal(null);
                        }}
                        className="cz-btn cz-btn-sm"
                      >
                        <Check size={13} /> Use this
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <input
              className="cz-field text-[14px] placeholder:text-ink-500"
              placeholder="Name (e.g. SQL Tutor)"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus={!canAi}
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
                onClick={() => {
                  formToken.current += 1;
                  if (thinking && socket) cancelSkillAi(socket);
                  aiRunning.current = false;
                  setThinking(false);
                  setDraft(null);
                  setError(null);
                  setProposal(null);
                  // Opened from a suggestion: back to the others.
                  if (fromSuggestion !== null) { setFromSuggestion(null); setView('suggest'); }
                }}
                className="cz-btn cz-btn-quiet cz-btn-sm"
              >
                <X size={13} /> Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || thinking || !!proposal || !draft.name.trim() || !draft.systemPrompt.trim()}
                className="cz-btn cz-btn-sm"
              >
                <Check size={13} /> {draft.id ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openDraft({ ...EMPTY_DRAFT })}
              className="cz-btn cz-btn-ghost cz-btn-sm"
            >
              <Plus size={14} /> New skill
            </button>
            {canAi && (
              <button type="button" onClick={() => setView('suggest')} className="cz-btn cz-btn-ghost cz-btn-sm">
                <MessagesSquare size={14} /> Suggest from my chats
              </button>
            )}
          </div>
        )}

        {view === 'list' && custom.length > 0 && (
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
                    onClick={() => openDraft({ id: s.id, name: s.name, description: s.description, systemPrompt: s.systemPrompt ?? '' })}
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

        {view === 'list' && (
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
        )}
      </div>
    </Modal>
  );
}
