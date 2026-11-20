import { useEffect, useRef, useState } from 'react';
import { ChevronRight, MessageSquareText, RotateCcw, SkipForward, ChevronDown } from 'lucide-react';
import Modal from '../components/Modal.js';
import { escalationKey, type EscalationRequest } from './useChatSession.js';
import { CHOICES, clock, draftPreview, readIssues, wordCount, type EscalationChoice } from './escalation-view.js';

/**
 * Every section that has stopped and asked a question.
 *
 * This modal is the whole point of the escalation work: the status "Section
 * escalated — needs a decision" was previously terminal, because nothing ever
 * asked for the decision. The run is parked while this is open.
 *
 * ALL of the parked sections, not just the first. A Complex wave dispatches
 * sections concurrently, `pendingEscalations` is a map because several can be
 * waiting at once, and each one starts its own five-minute timer the moment it
 * parks — so showing one and counting the rest did not defer them, it expired
 * them. Somebody working through the first decision could have a second section
 * failed behind it without its question ever appearing.
 *
 * Rendered as ONE overlay rather than a stack. The modal sits above everything
 * else because the run is blocked until it is answered, and two or three
 * competing overlays at that level would leave only the topmost usable — which
 * is the failure this is fixing, wearing a different hat. One window, every
 * parked section in it, each with its own deadline and its own controls.
 */
export default function EscalationModal({
  requests,
  onResolve,
  onDismiss,
  onExpire,
}: {
  requests: EscalationRequest[];
  onResolve: (action: 'retry' | 'skip' | 'guidance', note: string | undefined, key: string) => void;
  /** The user deliberately closed the window — that IS an answer ('skip'), for
   *  every section in it. */
  onDismiss: () => void;
  /** The local deadline passed. NOT an answer: the server has already failed
   *  the section, so this only clears the stale prompt. */
  onExpire: (key: string) => void;
}) {
  if (requests.length === 0) return null;

  const many = requests.length > 1;
  return (
    // Strictly above every other overlay (ordinary modals share z-40;
    // ContextApprovalDialog sits at z-50) — the run is parked until this is
    // answered, so it must win no matter what else happens to be open, not
    // just whichever one happened to mount last.
    <Modal
      title={many ? `${requests.length} sections paused for your decision` : 'Section paused for your decision'}
      onClose={onDismiss}
      zIndexClassName="z-[60]"
    >
      {/* Bounded and scrollable for the same reason the questionnaire list is:
          several full prompts are taller than a short viewport, and controls
          clipped below the fold are unreachable — which expires the section
          exactly as surely as never rendering it. */}
      <div className="max-h-[70vh] overflow-y-auto">
        {requests.map((request) => (
          <ParkedSection
            key={escalationKey(request)}
            request={request}
            separated={many}
            onResolve={onResolve}
            onExpire={onExpire}
          />
        ))}
      </div>
    </Modal>
  );
}

/**
 * One parked section, as a card on the cascade: where in the run it stopped,
 * what failed, what it has so far, and the three ways on, each one choice away.
 *
 * A component per request, keyed on it, so each section owns its own draft note
 * and countdown: one section's instructions never reach another.
 */
function ParkedSection({
  request,
  separated,
  onResolve,
  onExpire,
}: {
  request: EscalationRequest;
  separated: boolean;
  onResolve: (action: 'retry' | 'skip' | 'guidance', note: string | undefined, key: string) => void;
  onExpire: (key: string) => void;
}) {
  const [choice, setChoice] = useState<EscalationChoice | null>(null);
  const [note, setNote] = useState('');
  const [showDraft, setShowDraft] = useState(false);
  const [showGoal, setShowGoal] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const key = escalationKey(request);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Anchored to when the request ARRIVED: an unrelated re-render must not
  // restart the countdown while the server's timer keeps running.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [request.receivedAt]);

  const remainingMs = request.timeoutMs - (now - request.receivedAt);
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const left = Math.max(0, Math.min(1, remainingMs / request.timeoutMs));
  const urgent = seconds <= 60;

  // The server has already given up: clear, so a late answer can't land on a
  // section that has moved on. Not an answer, so not onResolve.
  useEffect(() => {
    if (remainingMs <= 0) onExpire(key);
  }, [remainingMs <= 0, key, onExpire]); // eslint-disable-line react-hooks/exhaustive-deps

  const { checks, notes } = readIssues(request.issues);
  const draft = draftPreview(request.summary ?? '');
  const ready = choice !== null && (choice !== 'guidance' || note.trim().length > 0);
  const chosen = CHOICES.find((c) => c.id === choice);

  const pick = (id: EscalationChoice) => setChoice(id);
  const confirm = () => {
    if (!ready || !choice) return;
    onResolve(choice, choice === 'guidance' ? note.trim() : undefined, key);
  };

  // G / R / S pick, Enter confirms. Only when this is the one section asking,
  // and never while typing: a letter in the notes is a letter.
  useEffect(() => {
    if (separated) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = CHOICES.find((c) => c.key.toLowerCase() === e.key.toLowerCase());
      if (hit) { e.preventDefault(); pick(hit.id); }
      // Enter on a focused button or link is that control's own (View, a card, the goal):
      // it confirms only when nothing interactive has the focus.
      else if (e.key === 'Enter' && ready && !(e.target instanceof Element && e.target.closest('button, a, [role="button"], [role="radio"], summary'))) { e.preventDefault(); confirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const icon = (id: EscalationChoice) => (id === 'guidance' ? <MessageSquareText size={15} /> : id === 'retry' ? <RotateCcw size={15} /> : <SkipForward size={15} />);

  return (
    <section
      aria-label={request.sectionTitle}
      className={`flex flex-col text-sm text-ink-100 ${separated ? 'border-b border-elev/10 last:border-b-0' : ''}`}
    >
      {/* The time it has left, as a bar draining along the top. */}
      <div className="flex items-center gap-3 px-4 pt-3">
        <div
          className="h-1 flex-1 overflow-hidden rounded-full bg-elev/10"
          role="progressbar"
          aria-label={`Time left for ${request.sectionTitle}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(left * 100)}
        >
          <div className={`h-full rounded-full transition-[width] duration-1000 ease-linear ${urgent ? 'bg-danger-500' : 'bg-t2'}`} style={{ width: `${left * 100}%` }} />
        </div>
        <span className={`shrink-0 font-mono text-[11px] tabular-nums ${urgent ? 'text-danger-300' : 'text-ink-400'}`}>
          {seconds > 0 ? `auto-fails in ${clock(seconds)}` : 'timed out'}
        </span>
      </div>

      {/* Where in the cascade it stopped. */}
      <div className="flex flex-col gap-1.5 px-4 pb-3 pt-2.5">
        <nav aria-label="Where in the run" className="flex flex-wrap items-center gap-1 text-[11px] text-ink-400">
          <Crumb dot="bg-t1">Plan</Crumb>
          <ChevronRight size={11} className="text-ink-500" />
          <Crumb dot="bg-t2">{request.position ? `Section ${request.position.index} of ${request.position.of}` : 'Section'}</Crumb>
          <ChevronRight size={11} className="text-ink-500" />
          <Crumb dot="bg-t3">Review</Crumb>
        </nav>
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[15px] font-semibold leading-snug text-ink-50">{request.sectionTitle}</h3>
          <span className="mt-0.5 shrink-0 rounded-full border border-warning-500/40 bg-warning-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning-300">
            Paused
          </span>
        </div>
        {request.goal && (
          <button
            type="button"
            onClick={() => setShowGoal((v) => !v)}
            aria-expanded={showGoal}
            className={`text-left text-xs leading-relaxed text-ink-300 hover:text-ink-200 ${showGoal ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}
            title={showGoal ? 'Show less' : 'Show the whole goal'}
          >
            {request.goal}
          </button>
        )}
      </div>

      {/* What failed, and what it has so far. */}
      <dl className="mx-4 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2.5 rounded-lg border border-elev/10 bg-elev/[0.04] px-3 py-2.5 text-xs">
        {(checks.length > 0 || notes.length > 0) && (
          <>
            <dt className="pt-0.5 font-medium text-ink-400">Checks</dt>
            <dd className="flex flex-col gap-1.5">
              {checks.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Failed checks">
                  {checks.map((c) => (
                    <li key={c} className="inline-flex items-center gap-1 rounded-md bg-danger-500/10 px-1.5 py-0.5 text-[11px] font-medium text-danger-300">
                      <span aria-hidden>✕</span> {c}
                    </li>
                  ))}
                </ul>
              )}
              {notes.slice(0, 4).map((n, i) => <p key={i} className="leading-relaxed text-ink-300">{n}</p>)}
            </dd>
          </>
        )}
        {draft.words > 0 && (
          <>
            <dt className="pt-0.5 font-medium text-ink-400">Draft</dt>
            <dd className="flex min-w-0 flex-col gap-1">
              <div className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 min-w-0 text-ink-200">{draft.line}</span>
                <button
                  type="button"
                  onClick={() => setShowDraft((v) => !v)}
                  aria-expanded={showDraft}
                  aria-label={showDraft ? 'Hide' : 'View'}
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-medium text-t2 hover:underline"
                >
                  <span className="font-normal text-ink-500">{wordCount(draft.words)} ·</span>
                  {showDraft ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {showDraft ? 'Hide' : 'View'}
                </button>
              </div>
              {showDraft && (
                <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-ink-950/40 p-2 leading-relaxed text-ink-200">
                  {request.summary.trim()}
                </div>
              )}
            </dd>
          </>
        )}
      </dl>

      {/* The three ways on. */}
      <div className="flex flex-col gap-3 p-4">
        <div role="radiogroup" aria-label={`What to do with ${request.sectionTitle}`} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {CHOICES.map((c) => {
            const on = choice === c.id;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => pick(c.id)}
                className={`group flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  on ? 'border-t2/70 bg-t2/10 ring-1 ring-t2/40' : 'border-elev/15 bg-elev/[0.04] hover:border-elev/30 hover:bg-elev/[0.08]'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={`flex items-center gap-1.5 text-[13px] font-semibold ${on ? 'text-ink-50' : 'text-ink-100'}`}>
                    <span className={on ? 'text-t2' : 'text-ink-400'}>{icon(c.id)}</span>
                    {c.label}
                  </span>
                  {!separated && (
                    <kbd className="rounded border border-elev/20 px-1 font-mono text-[10px] text-ink-400">{c.key}</kbd>
                  )}
                </span>
                <span className="text-[11px] leading-snug text-ink-400">{c.detail}</span>
              </button>
            );
          })}
        </div>

        {choice === 'guidance' && (
          <textarea
            ref={noteRef}
            // Focused as it appears: the next keys typed are the notes, never a shortcut.
            autoFocus
            className="resize-none rounded-lg border border-elev/15 bg-elev/[0.04] px-3 py-2 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:border-t2/60"
            rows={3}
            placeholder="What should it do differently? e.g. finish the stylesheet and keep it under one file"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirm(); }
            }}
            aria-label={`Notes for ${request.sectionTitle}`}
          />
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-ink-500">
            {seconds > 0
              ? 'No answer in time fails this section; the rest of the run carries on.'
              : 'Timed out: this section has been failed.'}
          </p>
          <button
            type="button"
            onClick={confirm}
            disabled={!ready}
            className="shrink-0 rounded-md bg-accent-500 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {chosen ? chosen.confirm : 'Choose how to continue'}
          </button>
        </div>
      </div>
    </section>
  );
}

/** One step of the cascade path, with its tier's colour. */
function Crumb({ dot, children }: { dot: string; children: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-elev/[0.06] px-2 py-0.5 font-medium text-ink-300">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {children}
    </span>
  );
}
