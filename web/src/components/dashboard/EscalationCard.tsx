import React, { memo, useEffect, useCallback } from 'react';
import { ShieldAlert, ArrowRight, HelpCircle } from 'lucide-react';

// Inline type matching src/types.ts PermissionRequest
interface PermissionRequest {
  id: string;
  requestedBy: string;
  parentT2Id: string;
  toolName: string;
  input: Record<string, unknown>;
  isDangerous: boolean;
  subtaskContext: string;
  sectionContext: string;
  taskContext?: string;
}


interface EscalationCardProps {
  request: PermissionRequest;
  onDecide: (approved: boolean, always: boolean) => void;
}

const TIER_STEP = ({ icon, tier, label, result }: {
  icon: string;
  tier: string;
  label: string;
  result: 'uncertain';
}) => (
  <div className="flex items-start gap-3 py-2.5">
    <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--bg-overlay)] border border-[var(--border-subtle)]
                    flex items-center justify-center text-sm">{icon}</div>
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className={`badge badge-${tier}`}>{tier}</span>
        <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
      </div>
      <p className="text-[10px] text-[var(--warning)] mt-0.5">⚠ Uncertain — escalated upward</p>
    </div>
    <ArrowRight size={12} className="text-[var(--text-faint)] mt-2 flex-shrink-0" />
  </div>
);

export const EscalationCard = memo(function EscalationCard({ request, onDecide }: EscalationCardProps) {
  // Keyboard shortcuts: y = approve, n = deny
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'y') onDecide(true, false);
      if (e.key === 'n') onDecide(false, false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onDecide]);

  const handleApprove = useCallback((always: boolean) => onDecide(true, always), [onDecide]);
  const handleDeny = useCallback((always: boolean) => onDecide(false, always), [onDecide]);

  const pathDisplay = (request.input['path'] as string | undefined)
    ?? (request.input['command'] as string | undefined)
    ?? JSON.stringify(request.input).slice(0, 60);

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="escalation-title"
    >
      <div
        className="w-full max-w-lg glass-elevated rounded-[var(--radius-xl)] shadow-dialog animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-[var(--border-subtle)]">
          <div className="w-10 h-10 rounded-[var(--radius-lg)] bg-[rgba(245,158,11,0.12)]
                          border border-[rgba(245,158,11,0.25)] flex items-center justify-center flex-shrink-0">
            <ShieldAlert size={20} className="text-[var(--warning)]" />
          </div>
          <div>
            <h2 id="escalation-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
              Permission required
            </h2>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Neither T2 nor T1 could determine if this action is safe
            </p>
          </div>
        </div>

        {/* Tool being requested */}
        <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2">Requested action</p>
          <div className="flex items-center gap-2 bg-[var(--bg-base)] rounded-[var(--radius-md)]
                          border border-[var(--border-subtle)] px-3 py-2">
            <code className="text-[var(--accent)] font-mono font-semibold text-[12px]">
              {request.toolName}
            </code>
            {pathDisplay && (
              <>
                <span className="text-[var(--text-faint)]">→</span>
                <code className="text-[var(--text-muted)] font-mono text-[11px] truncate">
                  {pathDisplay}
                </code>
              </>
            )}
            {request.isDangerous && (
              <span className="ml-auto badge bg-[rgba(239,68,68,0.12)] text-[var(--error)] border-[rgba(239,68,68,0.25)]">
                Dangerous
              </span>
            )}
          </div>
        </div>

        {/* Escalation audit trail */}
        <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Escalation trail</p>
          <div className="divide-y divide-[var(--border-subtle)]">
            <TIER_STEP icon="🔹" tier="T3" label={`"${request.subtaskContext}" requested this action`} result="uncertain" />
            <TIER_STEP icon="🟣" tier="T2" label={`Section "${request.sectionContext}" evaluated — uncertain`} result="uncertain" />
            <TIER_STEP icon="🟡" tier="T1" label="Administrator evaluated with full task context — uncertain" result="uncertain" />
            <div className="flex items-center gap-3 py-2.5">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--accent)] flex items-center justify-center">
                <HelpCircle size={14} className="text-white" />
              </div>
              <div>
                <span className="text-[12px] font-semibold text-[var(--text-primary)]">
                  Your decision is required
                </span>
                <p className="text-[10px] text-[var(--text-muted)]">Press <kbd className="px-1 py-0.5 rounded bg-[var(--bg-overlay)] border border-[var(--border-strong)] font-mono text-[9px]">Y</kbd> to approve, <kbd className="px-1 py-0.5 rounded bg-[var(--bg-overlay)] border border-[var(--border-strong)] font-mono text-[9px]">N</kbd> to deny</p>
              </div>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="px-6 py-4">
          <div className="grid grid-cols-2 gap-3 mb-2">
            <button className="btn btn-danger" onClick={() => handleDeny(false)}>
              Deny once
            </button>
            <button className="btn btn-success" onClick={() => handleApprove(false)}>
              Approve once
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button className="btn btn-ghost text-[10px]" onClick={() => handleDeny(true)}>
              Always deny <code className="font-mono ml-1">{request.toolName}</code>
            </button>
            <button className="btn btn-ghost text-[10px]" onClick={() => handleApprove(true)}>
              Always approve <code className="font-mono ml-1">{request.toolName}</code>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
