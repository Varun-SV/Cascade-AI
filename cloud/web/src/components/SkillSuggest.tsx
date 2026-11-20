import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Loader2, MessagesSquare, Plus, Sparkles, Square, X } from 'lucide-react';
import { fetchMemoryBuildChats } from '../lib/api.js';
import { cancelSkillAi, costLine, estimateSuggest, suggestSkills, type SkillAiSocket, type SkillDraft, type SkillSuggestion, type SuggestEstimate } from '../lib/skill-ai.js';
import type { MemoryBuildChat, ProviderConfig } from '../lib/types.js';

/** Most recent chats chosen at the start; the person can change it. */
const DEFAULT_CHATS = 40;

/**
 * Skills for tasks the person keeps coming back to, read from their chats.
 * Pick chats, see the cost, suggest, then add (to edit before saving) or dismiss each.
 */
export default function SkillSuggest({ socket, providers, onBack, onAdd, results, onResults }: {
  socket: SkillAiSocket | null;
  providers: ProviderConfig[];
  onBack: () => void;
  /** Opens the suggestion in the skill form, to edit before it is saved. */
  onAdd: (draft: SkillDraft, index: number) => void;
  /** The last pass's suggestions, kept by the parent so adding one doesn't lose the rest. */
  results: SkillSuggestion[] | null;
  onResults: (s: SkillSuggestion[] | null) => void;
}) {
  const [chats, setChats] = useState<MemoryBuildChat[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [estimate, setEstimate] = useState<SuggestEstimate | null>(null);
  const [running_, setRunning] = useState(false);
  const step: 'pick' | 'running' | 'done' = running_ ? 'running' : results ? 'done' : 'pick';
  const suggestions = results ?? [];
  const setSuggestions = (f: (prev: SkillSuggestion[]) => SkillSuggestion[]) => onResults(f(suggestions));
  /** Bumped on each reconnect: an estimate lost with the old connection is asked again. */
  const [connection, setConnection] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const running = useRef(false);

  useEffect(() => {
    fetchMemoryBuildChats()
      .then((r) => {
        const usable = r.chats.filter((c) => c.turns > 0);
        setChats(usable);
        setChosen(new Set(usable.slice(0, DEFAULT_CHATS).map((c) => c.id)));
      })
      .catch(() => { setChats([]); setError('Could not load your chats.'); });
  }, []);

  // The cost follows the selection; Build waits for this selection's.
  useEffect(() => {
    const n = ++seq.current;
    setEstimate(null);
    if (!socket || !providers.length || chosen.size < 2) return;
    const t = setTimeout(() => {
      void estimateSuggest(socket, providers, [...chosen]).then((r) => { if (n === seq.current && r.ok) setEstimate(r.value); });
    }, 300);
    return () => clearTimeout(t);
  }, [socket, providers, chosen, connection]);

  useEffect(() => {
    if (!socket?.on) return;
    const onConnect = () => setConnection((c) => c + 1);
    socket.on('connect', onConnect);
    return () => { socket.off?.('connect', onConnect); };
  }, [socket]);

  // Leaving while it runs stops it: nobody is left to read what it finds.
  useEffect(() => () => { if (running.current && socket) cancelSkillAi(socket); }, [socket]);

  async function run() {
    if (!socket || chosen.size < 2) return;
    setError(null);
    setRunning(true);
    running.current = true;
    const r = await suggestSkills(socket, providers, [...chosen]);
    running.current = false;
    setRunning(false);
    if (r.ok) { onResults(r.value.suggestions); return; }
    if ('error' in r) setError(r.error);
  }

  const toggle = (id: string) => setChosen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const back = (
    <button type="button" onClick={onBack} className="flex items-center gap-1 self-start text-xs text-ink-400 hover:text-ink-100">
      <ArrowLeft size={13} /> Back to skills
    </button>
  );

  if (!providers.length) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="rounded-md border border-dashed border-elev/10 px-3 py-4 text-center text-xs text-ink-400">Add a provider key in Settings first. Suggestions are written by your own model.</p>
      </div>
    );
  }

  if (step === 'running') {
    return (
      <div className="flex flex-col gap-3 py-2">
        <p className="flex items-center gap-2 text-sm"><Loader2 size={15} className="animate-spin text-accent-300" /> Reading {chosen.size} chats for tasks you repeat…</p>
        <button type="button" onClick={() => socket && cancelSkillAi(socket)} className="cz-btn cz-btn-quiet cz-btn-sm self-start">
          <Square size={12} /> Stop
        </button>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="flex flex-col gap-3">
        {back}
        {suggestions.length === 0 ? (
          <p className="rounded-md border border-dashed border-elev/10 px-3 py-4 text-center text-xs text-ink-400">
            Nothing came up in two or more of these chats. Try choosing more of them.
          </p>
        ) : (
          <>
            <p className="text-xs text-ink-300">
              {suggestions.length} {suggestions.length === 1 ? 'skill' : 'skills'} for tasks you come back to. Add one to edit it before it is saved.
            </p>
            <ul className="flex max-h-[50dvh] flex-col gap-2 overflow-y-auto" aria-label="Suggested skills">
              {suggestions.map((s, i) => (
                <li key={`${s.name}-${i}`} className="flex flex-col gap-1.5 rounded-lg border border-elev/15 bg-elev/[0.04] px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-ink-50">{s.name}</p>
                      {s.description && <p className="text-xs text-ink-300">{s.description}</p>}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button type="button" onClick={() => onAdd({ name: s.name, description: s.description, instructions: s.instructions }, i)} className="cz-btn cz-btn-sm" aria-label={`Add ${s.name}`}>
                        <Plus size={13} /> Add
                      </button>
                      <button type="button" aria-label={`Dismiss ${s.name}`} onClick={() => setSuggestions((prev) => prev.filter((_, j) => j !== i))} className="cz-ib cz-ib-sm">
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                  {s.why && <p className="text-[12px] text-ink-400">{s.why}</p>}
                  <p className="flex flex-wrap items-center gap-1 text-[11px] text-ink-500">
                    <MessagesSquare size={11} /> From {s.chats.length} chats:
                    {s.chats.slice(0, 3).map((c) => <span key={c.id} className="rounded bg-elev/10 px-1.5 py-px text-ink-300">{c.title || 'Untitled chat'}</span>)}
                    {s.chats.length > 3 && <span>and {s.chats.length - 3} more</span>}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  const list = chats ?? [];
  return (
    <div className="flex flex-col gap-3">
      {back}
      <p className="text-xs text-ink-300">
        Your model reads what you asked in the chats you choose, and suggests skills for tasks that come up in two or more of them. Only your own words are read, and nothing is saved until you add it.
      </p>
      {chats === null ? (
        <p className="flex items-center gap-2 text-xs text-ink-400"><Loader2 size={13} className="animate-spin" /> Loading your chats…</p>
      ) : list.length < 2 ? (
        <p className="rounded-md border border-dashed border-elev/10 px-3 py-4 text-center text-xs text-ink-400">You need at least two chats for this.</p>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-ink-400">
            <span>{chosen.size} of {list.length} chats chosen</span>
            <span className="flex gap-3">
              <button type="button" className="hover:text-ink-100" onClick={() => setChosen(new Set(list.slice(0, 80).map((c) => c.id)))}>All</button>
              <button type="button" className="hover:text-ink-100" onClick={() => setChosen(new Set())}>None</button>
            </span>
          </div>
          <ul className="flex max-h-[34dvh] flex-col gap-1 overflow-y-auto" aria-label="Chats to read">
            {list.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-elev/[0.05]">
                  <input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="flex-1 truncate">{c.title || 'Untitled chat'}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p role="alert" className="text-xs text-danger-400">{error}</p>}
      <div className="flex items-center justify-between gap-3 border-t border-elev/10 pt-3">
        <p className="text-xs text-ink-400" aria-live="polite">
          {chosen.size < 2
            ? 'Choose at least two chats.'
            : chosen.size > 80
              ? 'At most 80 chats are read at once.'
              : estimate
                ? `Reads ${estimate.chats} chats with ${estimate.model ?? 'your model'}, for ${costLine(estimate.costUsd)}.`
                : 'Working out the cost…'}
        </p>
        <button type="button" onClick={run} disabled={!socket || chosen.size < 2 || chosen.size > 80 || !estimate} className="cz-btn cz-btn-sm shrink-0">
          <Sparkles size={13} /> Suggest skills
        </button>
      </div>
    </div>
  );
}
