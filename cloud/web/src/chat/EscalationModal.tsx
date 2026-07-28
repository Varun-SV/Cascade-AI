import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, SkipForward, Send } from 'lucide-react';
import Modal from '../components/Modal.js';
import type { EscalationRequest } from './useChatSession.js';

/**
 * A section stopped and asked a question.
 *
 * This modal is the whole point of the escalation work: the status "Section
 * escalated — needs a decision" was previously terminal, because nothing ever
 * asked for the decision. The run is parked while this is open.
 *
 * It shows a live countdown because the wait is bounded — an unanswered
 * escalation FAILS the section rather than hanging, since a hosted run holds
 * server resources. Hiding that deadline would make the failure look arbitrary
 * when it arrives.
 */
export default function EscalationModal({
  request,
  onResolve,
  onDismiss,
}: {
  request: EscalationRequest;
  onResolve: (action: 'retry' | 'skip' | 'guidance', note?: string) => void;
  onDismiss: () => void;
}) {
  const [note, setNote] = useState('');
  const [remainingMs, setRemainingMs] = useState(request.timeoutMs);

  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => {
      const left = request.timeoutMs - (Date.now() - startedAt);
      setRemainingMs(left);
      // The server has already given up by now; closing avoids an answer that
      // would land on a run which has moved on.
      if (left <= 0) onDismiss();
    }, 1000);
    return () => clearInterval(id);
  }, [request.timeoutMs, request.sectionId, onDismiss]);

  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  const urgent = seconds <= 60;

  return (
    <Modal title="A section needs your decision" onClose={onDismiss}>
      <div className="flex flex-col gap-3 p-4 text-sm text-ink-100">
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
            autoFocus
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onResolve('guidance', note.trim())}
            disabled={!note.trim()}
            className="flex items-center gap-1.5 rounded-md bg-accent-500/20 px-3 py-1.5 text-sm font-semibold text-accent-200 hover:bg-accent-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={14} /> Retry with guidance
          </button>
          <button
            type="button"
            onClick={() => onResolve('retry')}
            className="flex items-center gap-1.5 rounded-md bg-elev/10 px-3 py-1.5 text-sm text-ink-100 hover:bg-elev/20"
          >
            <RefreshCw size={14} /> Retry as-is
          </button>
          <button
            type="button"
            onClick={() => onResolve('skip')}
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
    </Modal>
  );
}
