// ─────────────────────────────────────────────
//  Cascade Cloud — asking before a dangerous tool runs
// ─────────────────────────────────────────────
//
//  The half that was missing. The server has been parking dangerous tool calls
//  on an `approvalCallback` and emitting `permission:user-required`, and
//  nothing on this side listened — so every request sat until the SDK's
//  ten-minute timeout and was denied. That is worse than an ungated capability:
//  it looks like a feature and behaves like a fault, and it silently changed
//  every other dangerous cloud tool from "denied at once" to "denied later".
//
//  Rendered as a queue rather than one prompt. A run can have several workers
//  asking at once, and answering the newest while the rest time out is the
//  failure this replaces.
//
//  Built on the design tokens rather than inline styles, which it used to
//  carry alone: a hardcoded `#f5c96b` on `#4a3410` went on looking like a
//  warning in the dark theme and like nothing in particular in the light one,
//  and could not follow a palette change the rest of the app made. This is the
//  most consequential thing the UI ever asks — the moment a person authorises
//  an agent to act on a real page — so it is the last surface that should look
//  like it belongs to a different product.

import { ShieldAlert } from 'lucide-react';
import type { ToolApproval } from './useChatSession.js';

interface Props {
  approvals: ToolApproval[];
  onDecide: (requestId: string, approved: boolean, always?: boolean) => void;
}

/** Shared button shape; the colour is what separates the three answers. */
const ACTION = 'rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors '
  + 'focus-visible:outline-none focus-visible:ring-1';

export function ToolApprovalPrompt({ approvals, onDecide }: Props) {
  if (approvals.length === 0) return null;
  const [current, ...rest] = approvals;
  if (!current) return null;

  return (
    <section
      aria-label="Tool approval"
      className="my-2 overflow-hidden rounded-xl border border-warning-500/30 bg-warning-500/[0.06]"
    >
      <div className="flex items-center gap-1.5 border-b border-warning-500/20 px-3 py-1.5 text-[11px] text-warning-300">
        <ShieldAlert size={13} className="shrink-0" />
        <span className="flex-1 truncate">
          Cascade wants to run <code className="font-mono text-warning-300">{current.toolName}</code>
        </span>
        {/* Said out loud: a queue nobody can see looks like a stuck run, and
            the person answering should know how many more are behind it. */}
        {rest.length > 0 && (
          <span className="shrink-0 tabular-nums text-warning-300/70">{rest.length} more waiting</span>
        )}
      </div>

      <div className="px-3 py-2.5">
        {current.description && (
          <p className="mb-2 text-xs text-ink-200">{current.description}</p>
        )}

        {/* The arguments, because "approve this tool" without them is not
            consent — the selector is the difference between clicking Search
            and clicking Delete. Truncated: a model can pass a very large input
            and an unbounded dump would push the buttons off screen. */}
        <pre className="mb-2.5 max-h-40 overflow-auto rounded-lg border border-elev/10 bg-ink-950/40 p-2 font-mono text-[11px] leading-relaxed text-ink-300 whitespace-pre-wrap">
          {JSON.stringify(current.input, null, 2).slice(0, 2_000)}
        </pre>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onDecide(current.requestId, true)}
            className={`${ACTION} border-accent-500/30 bg-accent-500/10 text-accent-300 hover:bg-accent-500/20 focus-visible:ring-accent-500`}
          >
            Allow once
          </button>
          {/* What makes a ten-step form fill one prompt instead of ten. Scoped
              to the run by the escalator's own task-wide cache, not forever —
              so it reads as the lesser commitment it is, not the louder one. */}
          <button
            type="button"
            onClick={() => onDecide(current.requestId, true, true)}
            className={`${ACTION} border-elev/10 bg-elev/[0.04] text-ink-300 hover:text-ink-100 focus-visible:ring-ink-500`}
          >
            Allow for this run
          </button>
          <button
            type="button"
            onClick={() => onDecide(current.requestId, false)}
            className={`${ACTION} ml-auto border-danger-500/30 bg-danger-500/10 text-danger-300 hover:bg-danger-500/20 focus-visible:ring-danger-500`}
          >
            Deny
          </button>
        </div>
      </div>
    </section>
  );
}
