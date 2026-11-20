import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Loader2, Quote, Sparkles, Square } from 'lucide-react';
import { acceptMemories, fetchMemoryBuildChats } from '../lib/api.js';
import { MEMORY_CATEGORIES, groupOf } from '../lib/memory-categories.js';
import type { MemoryBuildChat, MemoryBuildEstimate, MemoryCandidate, ProviderConfig } from '../lib/types.js';

/** What the builder needs of the socket: emit with an ack, and progress events. */
export interface BuildSocket {
  emit(event: string, payload?: unknown, ack?: (reply: any) => void): unknown;
  on(event: string, fn: (p: any) => void): unknown;
  off(event: string, fn: (p: any) => void): unknown;
}

type Step = 'pick' | 'running' | 'review' | 'saved';

interface Draft extends MemoryCandidate { keep: boolean }

function formatCost(usd: number | null): string {
  if (usd === null) return 'an unknown amount (this model has no published price)';
  if (usd < 0.01) return 'under $0.01';
  return `about $${usd.toFixed(2)}`;
}

/** Memories saved per request (the server's limit), and evidence a memory keeps. */
const ACCEPT_BATCH = 200;
const MAX_EVIDENCE = 12;

function statusLine(d: Draft, rivals: number): string | null {
  if (d.status === 'known') return `You already have this: “${d.matches?.content}”. Keeping it adds where you said it.`;
  if (d.status === 'revision') {
    const also = rivals > 0 ? ` ${rivals === 1 ? 'Another suggestion updates' : `${rivals} other suggestions update`} it too: keep one.` : '';
    return `Updates “${d.matches?.content}”. The old wording is kept in its history.${also}`;
  }
  return null;
}

/**
 * What starts ticked: new memories, and the first update to each kept one. A
 * memory you already have starts unticked (keeping it only adds evidence), and
 * so does a second update to the same memory: two can't both be its wording.
 */
function initialDrafts(candidates: MemoryCandidate[]): Draft[] {
  const updated = new Set<string>();
  return candidates.map((c) => {
    if (c.status === 'known') return { ...c, keep: false };
    if (c.status === 'revision' && c.matches) {
      const first = !updated.has(c.matches.id);
      updated.add(c.matches.id);
      return { ...c, keep: first };
    }
    return { ...c, keep: true };
  });
}

/**
 * Build memories from the person's own chats: pick the chats, see the cost,
 * run it (stoppable), then keep, edit or drop each one before anything is saved.
 */
export default function MemoryBuilder({ socket, providers, onDone, onBack }: {
  socket: BuildSocket | null;
  providers: ProviderConfig[];
  onDone: () => void;
  onBack: () => void;
}) {
  const [step, setStep] = useState<Step>('pick');
  const [chats, setChats] = useState<MemoryBuildChat[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [estimate, setEstimate] = useState<MemoryBuildEstimate | null>(null);
  const [progress, setProgress] = useState({ read: 0, total: 0, found: 0 });
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const estimateSeq = useRef(0);
  // A build still running when the panel closes is stopped: nobody is left to
  // review what it finds, and every chat it reads after that costs money.
  const running = useRef(false);
  useEffect(() => () => { if (running.current) socket?.emit('memories:cancel'); }, [socket]);

  useEffect(() => {
    fetchMemoryBuildChats()
      .then((r) => { setChats(r.chats); setChosen(new Set(r.chats.filter((c) => c.worth).map((c) => c.id))); })
      .catch(() => { setChats([]); setError('Could not load your chats.'); });
  }, []);

  // The estimate follows the selection, a moment after it settles.
  useEffect(() => {
    if (!socket || !providers.length || chosen.size === 0) { setEstimate(null); return; }
    const seq = ++estimateSeq.current;
    const t = setTimeout(() => {
      socket.emit('memories:estimate', { providers, conversationIds: [...chosen] }, (r: MemoryBuildEstimate | { error: string }) => {
        if (seq === estimateSeq.current) setEstimate('error' in r ? null : r);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [socket, providers, chosen]);

  useEffect(() => {
    if (!socket) return;
    const onProgress = (p: { read: number; total: number; found: number }) => setProgress(p);
    socket.on('memories:progress', onProgress);
    return () => { socket.off('memories:progress', onProgress); };
  }, [socket]);

  const worthChosen = useMemo(() => (chats ?? []).filter((c) => c.worth && chosen.has(c.id)).length, [chats, chosen]);

  function toggle(id: string) {
    setChosen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function start() {
    if (!socket || chosen.size === 0) return;
    setError(null);
    setStopped(false);
    setProgress({ read: 0, total: worthChosen, found: 0 });
    setStep('running');
    running.current = true;
    socket.emit('memories:build', { providers, conversationIds: [...chosen] }, (r: { candidates: MemoryCandidate[]; cancelled: boolean } | { error: string }) => {
      running.current = false;
      if ('error' in r) { setError(r.error); setStep('pick'); return; }
      setStopped(r.cancelled);
      setDrafts(initialDrafts(r.candidates));
      setStep('review');
    });
  }

  function stop() { socket?.emit('memories:cancel'); }

  function patch(i: number, change: Partial<Draft>) {
    setDrafts((prev) => {
      const target = prev[i];
      // One update per kept memory: ticking one unticks any other update to it.
      const exclusive = change.keep === true && target?.status === 'revision' && target.matches;
      return prev.map((d, j) => {
        if (j === i) return { ...d, ...change };
        if (exclusive && d.status === 'revision' && d.matches?.id === target.matches!.id) return { ...d, keep: false };
        return d;
      });
    });
  }

  async function save() {
    const items = drafts.filter((d) => d.keep && d.content.trim()).map((d) => ({
      category: d.category, content: d.content.trim(), durability: d.durability, evidence: d.evidence.slice(0, MAX_EVIDENCE),
      ...(d.matches && d.status !== 'new' ? { revises: d.matches.id } : {}),
    }));
    if (!items.length) { onDone(); return; }
    setSaving(true);
    setError(null);
    try {
      let count = 0;
      for (let at = 0; at < items.length; at += ACCEPT_BATCH) {
        count += (await acceptMemories(items.slice(at, at + ACCEPT_BATCH))).saved.length;
      }
      setSavedCount(count);
      setStep('saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  const back = (
    <button type="button" onClick={onBack} className="flex items-center gap-1 text-xs text-ink-400 hover:text-ink-100">
      <ArrowLeft size={13} /> Back to your memories
    </button>
  );

  if (!providers.length) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="rounded-md border border-dashed border-elev/10 px-3 py-4 text-center text-xs text-ink-400">
          Add a provider key in Settings first. Building memories reads your chats with your own model.
        </p>
      </div>
    );
  }

  if (step === 'pick') {
    const list = chats ?? [];
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p className="text-xs text-ink-300">
          Cascade reads the chats you choose and suggests things worth remembering about you. Each suggestion comes
          with your own words from the chat, and nothing is saved until you review it.
        </p>
        {chats === null ? (
          <p className="flex items-center gap-2 text-xs text-ink-400"><Loader2 size={13} className="animate-spin" /> Loading your chats…</p>
        ) : list.length === 0 ? (
          <p className="rounded-md border border-dashed border-elev/10 px-3 py-4 text-center text-xs text-ink-400">You have no chats yet.</p>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs text-ink-400">
              <span>{chosen.size} of {list.length} chats chosen</span>
              <span className="flex gap-3">
                <button type="button" className="hover:text-ink-100" onClick={() => setChosen(new Set(list.filter((c) => c.worth).map((c) => c.id)))}>All</button>
                <button type="button" className="hover:text-ink-100" onClick={() => setChosen(new Set())}>None</button>
              </span>
            </div>
            <ul className="flex max-h-[38dvh] flex-col gap-1 overflow-y-auto" aria-label="Chats to read">
              {list.map((c) => (
                <li key={c.id}>
                  <label className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-elev/[0.05] ${c.worth ? '' : 'opacity-50'}`}>
                    <input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} disabled={!c.worth} />
                    <span className="flex-1 truncate">{c.title || 'Untitled chat'}</span>
                    <span className="shrink-0 text-[11px] text-ink-400">
                      {c.worth ? `${c.turns} ${c.turns === 1 ? 'message' : 'messages'}` : 'too short'}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <p role="alert" className="text-xs text-danger-500">{error}</p>}
        <div className="flex items-center justify-between gap-3 border-t border-elev/10 pt-3">
          <p className="text-xs text-ink-400" aria-live="polite">
            {worthChosen === 0
              ? 'Choose at least one chat.'
              : estimate
                ? `Reads ${estimate.chats} ${estimate.chats === 1 ? 'chat' : 'chats'} with ${estimate.model ?? 'your model'}, for ${formatCost(estimate.costUsd)}.`
                : `Reads ${worthChosen} ${worthChosen === 1 ? 'chat' : 'chats'}.`}
          </p>
          <button
            type="button"
            onClick={start}
            disabled={!socket || worthChosen === 0}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent-500 px-3 text-xs font-semibold text-white hover:bg-accent-400 disabled:opacity-40"
          >
            <Sparkles size={14} /> Build memories
          </button>
        </div>
      </div>
    );
  }

  if (step === 'running') {
    const pct = progress.total ? Math.round((progress.read / progress.total) * 100) : 0;
    return (
      <div className="flex flex-col gap-3 py-2">
        <p className="flex items-center gap-2 text-sm"><Loader2 size={15} className="animate-spin text-accent-300" /> Reading your chats…</p>
        <div className="h-1.5 overflow-hidden rounded bg-elev/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="h-full bg-accent-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-ink-400">
          {progress.read} of {progress.total} chats read · {progress.found} {progress.found === 1 ? 'suggestion' : 'suggestions'} so far
        </p>
        <button type="button" onClick={stop} className="flex w-fit items-center gap-1.5 rounded-md border border-elev/15 px-3 py-1.5 text-xs hover:bg-elev/[0.06]">
          <Square size={12} /> Stop and review what was found
        </button>
      </div>
    );
  }

  if (step === 'saved') {
    return (
      <div className="flex flex-col items-start gap-3 py-2">
        <p className="flex items-center gap-2 text-sm"><Check size={15} className="text-success-500" /> Saved {savedCount} {savedCount === 1 ? 'memory' : 'memories'}.</p>
        <button type="button" onClick={onDone} className="rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-400">See your memories</button>
      </div>
    );
  }

  // Review: grouped by category, each one kept, edited or dropped.
  const groups = MEMORY_CATEGORIES.map((c) => ({ ...c, items: drafts.map((d, i) => ({ d, i })).filter(({ d }) => groupOf(d.category) === c.id) }))
    .filter((g) => g.items.length);
  const keeping = drafts.filter((d) => d.keep).length;
  return (
    <div className="flex flex-col gap-3">
      {back}
      <p className="text-xs text-ink-300">
        {drafts.length === 0
          ? 'Nothing in these chats looked worth remembering.'
          : `${drafts.length} ${drafts.length === 1 ? 'suggestion' : 'suggestions'}${stopped ? ' (stopped early)' : ''}. Untick what is wrong, and edit anything before saving.`}
      </p>
      <div className="flex max-h-[45dvh] flex-col gap-4 overflow-y-auto">
        {groups.map((g) => (
          <section key={g.id} aria-label={g.label} className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{g.label}</h3>
            {g.items.map(({ d, i }) => (
              <div key={i} className={`flex flex-col gap-1.5 rounded-md border px-3 py-2 ${d.keep ? 'border-accent-500/30 bg-elev/[0.05]' : 'border-elev/10 opacity-60'}`}>
                <div className="flex items-start gap-2">
                  <input type="checkbox" aria-label={`Keep: ${d.content}`} checked={d.keep} onChange={(e) => patch(i, { keep: e.target.checked })} className="mt-1.5" />
                  <textarea
                    aria-label="Memory"
                    className="flex-1 resize-none rounded border border-elev/10 bg-transparent px-2 py-1 text-sm outline-none"
                    rows={2}
                    value={d.content}
                    onChange={(e) => patch(i, { content: e.target.value })}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-6">
                  <select
                    aria-label="Category"
                    className="rounded border border-elev/10 bg-elev/[0.04] px-1.5 py-0.5 text-xs outline-none"
                    value={d.category}
                    onChange={(e) => patch(i, { category: e.target.value })}
                  >
                    {MEMORY_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                  <select
                    aria-label="How long it holds"
                    className="rounded border border-elev/10 bg-elev/[0.04] px-1.5 py-0.5 text-xs outline-none"
                    value={d.durability}
                    onChange={(e) => patch(i, { durability: e.target.value === 'volatile' ? 'volatile' : 'permanent' })}
                  >
                    <option value="permanent">Always true</option>
                    <option value="volatile">True for now</option>
                  </select>
                  {d.status !== 'new' && (
                    <span className="rounded bg-elev/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-300">
                      {d.status === 'known' ? 'Already kept' : 'Update'}
                    </span>
                  )}
                </div>
                {(() => {
                  const rivals = d.status === 'revision' ? drafts.filter((x, k) => k !== i && x.status === 'revision' && x.matches?.id === d.matches?.id).length : 0;
                  const line = statusLine(d, rivals);
                  return line && <p className="pl-6 text-[11px] text-ink-400">{line}</p>;
                })()}
                <ul className="flex flex-col gap-0.5 pl-6">
                  {d.evidence.slice(0, 3).map((e, k) => (
                    <li key={k} className="flex items-start gap-1 text-[11px] italic text-ink-400">
                      <Quote size={10} className="mt-0.5 shrink-0" /> <span>{e.quote}</span>
                    </li>
                  ))}
                  {d.evidence.length > 3 && <li className="text-[11px] text-ink-400">and in {d.evidence.length - 3} more</li>}
                </ul>
              </div>
            ))}
          </section>
        ))}
      </div>
      {error && <p role="alert" className="text-xs text-danger-500">{error}</p>}
      <div className="flex items-center justify-end gap-2 border-t border-elev/10 pt-3">
        <button type="button" onClick={onBack} className="rounded-md px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100">Discard all</button>
        <button
          type="button"
          onClick={save}
          disabled={saving || keeping === 0}
          className="flex h-9 items-center gap-1.5 rounded-md bg-accent-500 px-3 text-xs font-semibold text-white hover:bg-accent-400 disabled:opacity-40"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save {keeping} {keeping === 1 ? 'memory' : 'memories'}
        </button>
      </div>
    </div>
  );
}

