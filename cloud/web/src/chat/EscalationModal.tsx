import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, SkipForward, Send } from 'lucide-react';
import Modal from '../components/Modal.js';
import { escalationKey, type EscalationRequest } from './useChatSession.js';

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
      title={many ? `${requests.length} sections need your decision` : 'A section needs your decision'}
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
 * One parked section, owning its own note and its own countdown.
 *
 * A component per request rather than one with a `note` and a reset effect.
 * The effect version was correct while exactly one was visible; with several on
 * screen a single draft would be shared between them, and since the guidance
 * box is free text meant for specific work, applying one section's instructions
 * to another is worse than applying none. Keyed on the request, so React
 * discards the draft with the section rather than carrying it anywhere.
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
  const [note, setNote] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const key = escalationKey(request);

  // Anchored to when the request ARRIVED, not to when this effect last ran.
  // `onDismiss` is a fresh inline closure on every parent render, so with it in
  // the dependency list any unrelated re-render (a status event from another
  // section, say) used to restart the interval AND reset its start time — the
  // countdown jumped back to five minutes while the server's timer kept
  // running, so the modal could read "4:58 remaining" a second before the
  // section was failed for not answering.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [request.receivedAt]);

  const remainingMs = request.timeoutMs - (now - request.receivedAt);
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));

  // The server has already given up; clear so a late answer can't land on a
  // section that has moved on. `onExpire`, not `onDismiss` — reporting "Skipping
  // section…" for a decision nobody made would be a lie about what happened.
  // In an effect, not in the tick, because clearing during render would set
  // parent state mid-render.
  useEffect(() => {
    if (remainingMs <= 0) onExpire(key);
  }, [remainingMs <= 0, key, onExpire]); // eslint-disable-line react-hooks/exhaustive-deps
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  const urgent = seconds <= 60;

  return (
    <div className={`flex flex-col gap-3 p-4 text-sm text-ink-100 ${separated ? 'border-b border-elev/10 last:border-b-0' : ''}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn-400" />
        <div>
          <p className="font-semibold">{request.sectionTitle}</p>
          <p className="text-xs text-ink-300">
            A worker in this section couldn&apos;t decide something on its own.
          </p>
        </div>
      </div>

      {request.issues.length > 0 && (
        <div className="rounded-md bg-elev/[0.05] px-3 py-2">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-300">What it hit</p>
          <ul className="flex flex-col gap-1 text-xs text-ink-200">
            {request.issues.slice(0, 6).map((issue, i) => (
              <li key={i}>· {issue}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-300">
          Optional: tell it what to do differently, then choose “Retry with guidance”.
        </span>
        <textarea
          className="resize-none rounded-md border border-elev/10 bg-elev/[0.04] px-2 py-1.5 text-sm text-ink-100 outline-none placeholder:text-ink-400"
          rows={3}
          placeholder="e.g. skip the private repos and only summarise the public ones"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          // Focused only when it is the only one. With several open, stealing
          // focus into whichever rendered last would move the cursor out from
          // under somebody already typing.
          autoFocus={!separated}
          aria-label={`Guidance for ${request.sectionTitle}`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onResolve('guidance', note.trim(), key)}
          disabled={!note.trim()}
          className="flex items-center gap-1.5 rounded-md bg-accent-500/20 px-3 py-1.5 text-sm font-semibold text-accent-200 hover:bg-accent-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send size={14} /> Retry with guidance
        </button>
        <button
          type="button"
          onClick={() => onResolve('retry', undefined, key)}
          className="flex items-center gap-1.5 rounded-md bg-elev/10 px-3 py-1.5 text-sm text-ink-100 hover:bg-elev/20"
        >
          <RefreshCw size={14} /> Retry as-is
        </button>
        <button
          type="button"
          onClick={() => onResolve('skip', undefined, key)}
          className="flex items-center gap-1.5 rounded-md bg-elev/10 px-3 py-1.5 text-sm text-ink-100 hover:bg-elev/20"
        >
          <SkipForward size={14} /> Skip this section
        </button>
      </div>

      <p className={`text-xs ${urgent ? 'text-danger-300' : 'text-ink-400'}`}>
        {seconds > 0
          ? `Waiting ${mm}:${ss} — if nobody answers, this section fails and the rest of the run continues.`
          : 'Timed out — this section has been failed.'}
      </p>
    </div>
  );
}
