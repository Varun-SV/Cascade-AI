// ─────────────────────────────────────────────
//  Cascade Cloud — the model asking instead of assuming
// ─────────────────────────────────────────────
//
//  A form rather than a message, deliberately. The same questions typed into
//  the transcript would be answered in prose, and prose has to be parsed back
//  into a decision by the thing that asked — which is the guessing this exists
//  to remove. Controls give an answer that needs no interpretation.
//
//  Rendered in `info` rather than the approval prompt's `warning`: this is not
//  a gate on something dangerous, it is somebody asking a question, and
//  colouring it like a hazard would train people to dismiss it.
//
//  Skip is not decoration. Without it, somebody who does not want to answer has
//  only one way to say so — wait out a two-minute gate — and the run is blocked
//  the whole time. The server reads an empty answer set as a deliberate skip
//  and tells the model exactly that, distinct from never having replied.

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { MessagesSquare } from 'lucide-react';
import type { ClarificationAnswer, ClarificationQuestion, ClarificationRequest } from './useChatSession.js';

interface Props {
  clarifications: ClarificationRequest[];
  onAnswer: (requestId: string, answers: ClarificationAnswer[]) => void;
}

const PILL = 'rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors '
  + 'focus-visible:outline-none focus-visible:ring-1';
const CHOSEN = 'border-accent-500/40 bg-accent-500/15 text-accent-300 focus-visible:ring-accent-500';
const UNCHOSEN = 'border-elev/10 bg-elev/[0.04] text-ink-400 hover:text-ink-100 focus-visible:ring-ink-500';

export function ClarificationPrompt({ clarifications, onAnswer }: Props) {
  // ALL of them, oldest first — not one at a time, which is what this did.
  //
  // I copied that rule from the approval queue, where it is right: approvals
  // are raised one at a time by a run that is waiting, so there is no second
  // one to hide. Questions are not. Parallel workers each call `ask_user`, and
  // `pendingClarifications` is a map precisely because several can be open at
  // once — and EVERY one of them started its two-minute timer the moment it was
  // asked, whether or not anybody could see it.
  //
  // So the queue was not deferring the later questions, it was expiring them.
  // Somebody answering the first form carefully could watch two more time out
  // behind it and never know they had been asked, while the workers that asked
  // proceeded on assumptions with a person sitting right there.
  //
  // "A page of questions is a thing people close" was my argument for hiding
  // them, and it does not survive the deadline: a question nobody is shown is
  // not a tidier interface, it is a question answered by default.
  //
  // KEYED on the request id, so React discards a draft when a form goes and
  // never carries it into another. The ids are positional (`q1`, `q2`), so an
  // inherited answer does not look stale — it looks like a reply to whatever
  // now sits in that slot.
  // BOUNDED and scrollable, because rendering them all is not the same as
  // making them reachable. The chat panel is fixed-height with `overflow-hidden`
  // above it, so on a short or mobile viewport the later forms — and their Send
  // and Skip buttons — are simply clipped off the bottom, and a form nobody can
  // scroll to expires exactly like a form nobody was shown. That is the failure
  // this component was just fixed for, reintroduced by the fix.
  //
  // `40vh` leaves the transcript visible so the questions stay in the context
  // of what is being asked about, and `overflow-y-auto` adds no scrollbar at
  // all in the ordinary case of one form.
  // Nothing at all when nothing is being asked — the wrapper must not become a
  // permanent empty box in the transcript, which is what it was when the scroll
  // region was added without this guard.
  if (clarifications.length === 0) return null;

  return (
    <div className="max-h-[40vh] overflow-y-auto">
      {clarifications.map((request) => (
        <Questionnaire key={request.requestId} request={request} onAnswer={onAnswer} />
      ))}
    </div>
  );
}

/**
 * Seconds left on the gate, or `undefined` when the run did not state one.
 *
 * Anchored to `receivedAt`, never to when this effect last ran: the interval
 * is re-armed on any re-render whose deps changed, and anchoring to that would
 * quietly restart the countdown while the server's timer kept going — the
 * exact bug the escalation modal carries a comment about.
 *
 * `undefined` rather than a guessed default when either value is missing. A
 * deadline is a promise about what happens when it runs out, and inventing one
 * the server never made is worse than showing nothing.
 */
function useRemaining(timeoutMs?: number, receivedAt?: number): number | undefined {
  const known = typeof timeoutMs === 'number' && typeof receivedAt === 'number';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!known) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [known, receivedAt]);

  if (!known) return undefined;
  return Math.max(0, Math.ceil((timeoutMs - (now - receivedAt)) / 1000));
}

function Questionnaire(
  { request: current, onAnswer }:
  { request: ClarificationRequest; onAnswer: Props['onAnswer'] },
) {
  const [draft, setDraft] = useState<Record<string, string | string[]>>({});

  const set = (id: string, value: string | string[]) => setDraft((d) => ({ ...d, [id]: value }));

  const left = useRemaining(current.timeoutMs, current.receivedAt);

  const toggle = (q: ClarificationQuestion, option: string) => {
    const held = draft[q.id];
    const picked = Array.isArray(held) ? held : [];
    set(q.id, picked.includes(option) ? picked.filter((v) => v !== option) : [...picked, option]);
  };

  const submit = () => {
    // Only what was actually answered. An untouched question is left out
    // rather than sent as an empty string, so the model is told it went
    // unanswered instead of being handed a blank that reads as a reply.
    const answers: ClarificationAnswer[] = Object.entries(draft)
      .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v.trim() !== ''))
      .map(([id, value]) => ({ id, value }));
    onAnswer(current.requestId, answers);
  };

  return (
    <section
      aria-label="Question from Cascade"
      className="my-2 overflow-hidden rounded-xl border border-info-500/30 bg-info-500/[0.06]"
    >
      <div className="flex items-center gap-1.5 border-b border-info-500/20 px-3 py-1.5 text-[11px] text-info-300">
        <MessagesSquare size={13} className="shrink-0" />
        <span className="flex-1 truncate">Cascade needs to know before it carries on</span>
        {/* The gate is two minutes and the form said nothing about it, so a
            considered answer could be typed into a questionnaire that was
            already gone — the draft discarded with no warning it was running
            out. The escalation modal has always shown its deadline; this is
            the same courtesy, quieter, because a question is not a hazard. */}
        {left !== undefined && (
          <span
            className={clsx('shrink-0 tabular-nums', left <= 30 ? 'text-warning-300' : 'text-info-300/70')}
            title="Cascade proceeds on its own reading when this runs out"
          >
            {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 px-3 py-2.5">
        {current.questions.map((q) => (
          <div key={q.id}>
            <p className="mb-1.5 text-xs text-ink-100">{q.prompt}</p>

            {q.kind === 'text' ? (
              <input
                type="text"
                aria-label={q.prompt}
                value={typeof draft[q.id] === 'string' ? (draft[q.id] as string) : ''}
                onChange={(e) => set(q.id, e.target.value)}
                className="w-full rounded-lg border border-elev/10 bg-elev/[0.04] px-2.5 py-1.5 text-xs text-ink-100 outline-none placeholder:text-ink-500 focus-visible:border-accent-500/40"
                placeholder="Your answer"
              />
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(q.options ?? []).map((option) => {
                  const held = draft[q.id];
                  const chosen = q.kind === 'multi'
                    ? Array.isArray(held) && held.includes(option)
                    : held === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={chosen}
                      onClick={() => (q.kind === 'multi' ? toggle(q, option) : set(q.id, option))}
                      className={clsx(PILL, chosen ? CHOSEN : UNCHOSEN)}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={submit}
            className={clsx(PILL, 'border-accent-500/30 bg-accent-500/10 text-accent-300 hover:bg-accent-500/20 focus-visible:ring-accent-500')}
          >
            Send answers
          </button>
          {/* An explicit "I would rather not", so the alternative is not
              blocking the run for two minutes to say the same thing. */}
          <button
            type="button"
            onClick={() => onAnswer(current.requestId, [])}
            className={clsx(PILL, 'ml-auto', UNCHOSEN)}
          >
            Skip, decide for me
          </button>
        </div>
      </div>
    </section>
  );
}
