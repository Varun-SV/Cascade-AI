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

import type { ToolApproval } from './useChatSession.js';

interface Props {
  approvals: ToolApproval[];
  onDecide: (requestId: string, approved: boolean, always?: boolean) => void;
}

export function ToolApprovalPrompt({ approvals, onDecide }: Props) {
  if (approvals.length === 0) return null;
  const [current, ...rest] = approvals;
  if (!current) return null;

  return (
    <section
      aria-label="Tool approval"
      style={{
        border: '1px solid var(--warn-fg, #f5c96b)', borderRadius: 8,
        margin: '8px 0', padding: '10px 12px', background: 'var(--warn-bg, #4a3410)',
        color: 'var(--warn-fg, #f5c96b)', fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <strong style={{ flex: 1 }}>
          Cascade wants to run <code>{current.toolName}</code>
        </strong>
        {/* Said out loud: a queue nobody can see looks like a stuck run, and
            the person answering should know how many more are behind it. */}
        {rest.length > 0 && <span style={{ opacity: 0.85 }}>{rest.length} more waiting</span>}
      </div>

      {current.description && (
        <p style={{ margin: '0 0 8px', opacity: 0.9 }}>{current.description}</p>
      )}

      {/* The arguments, because "approve this tool" without them is not consent.
          Truncated: a model can pass a very large input and an unbounded dump
          would push the buttons off screen. */}
      <pre
        style={{
          margin: '0 0 8px', padding: 8, maxHeight: 160, overflow: 'auto',
          background: 'rgba(0,0,0,0.25)', borderRadius: 4, fontSize: 12, whiteSpace: 'pre-wrap',
        }}
      >
        {JSON.stringify(current.input, null, 2).slice(0, 2_000)}
      </pre>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => onDecide(current.requestId, true)} style={btn}>
          Allow once
        </button>
        {/* What makes a ten-step form fill one prompt instead of ten. Scoped to
            the run by the escalator's own task-wide cache, not forever. */}
        <button type="button" onClick={() => onDecide(current.requestId, true, true)} style={btn}>
          Allow for this run
        </button>
        <button type="button" onClick={() => onDecide(current.requestId, false)} style={btn}>
          Deny
        </button>
      </div>
    </section>
  );
}

const btn: React.CSSProperties = {
  padding: '4px 10px', background: 'transparent', color: 'inherit',
  border: '1px solid currentColor', borderRadius: 4, fontSize: 12.5, cursor: 'pointer',
};
