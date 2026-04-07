import React, { memo, useEffect, useCallback } from 'react';
import { ShieldAlert, ArrowRight } from 'lucide-react';
import type { PermissionRequest } from '../../hooks/useWebSocket';

interface EscalationCardProps {
  request: PermissionRequest;
  onDecide: (approved: boolean, always: boolean) => void;
}

// ── Escalation trail step ──────────────────────

interface TierStepProps {
  icon: string;
  tier: 'T1' | 'T2' | 'T3';
  label: string;
  isLast?: boolean;
}

function TierStep({ icon, tier, label, isLast = false }: TierStepProps) {
  return (
    <div className={`flex items-start gap-3 py-2.5 ${!isLast ? 'border-b border-[var(--border-subtle)]' : ''}`}>
      <div className="
        flex-shrink-0 w-6 h-6 rounded-full
        bg-[var(--bg-overlay)] border border-[var(--border-subtle)]
        flex items-center justify-center text-[11px] mt-0.5
      ">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`badge badge-${tier}`}>{tier}</span>
          <span className="text-[10px] text-[var(--text-muted)] truncate">{label}</span>
        </div>
        <p className="text-[9px] font-mono text-[var(--warning)]">⚠ Uncertain — escalated upward</p>
      </div>
      <ArrowRight size={10} className="text-[var(--text-faint)] mt-1.5 flex-shrink-0" />
    </div>
  );
}

// ── Main component ─────────────────────────────

export const EscalationCard = memo(function EscalationCard({ request, onDecide }: EscalationCardProps) {
  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'y') onDecide(true, false);
      if (e.key === 'n') onDecide(false, false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onDecide]);

  const approve = useCallback((always: boolean) => onDecide(true, always), [onDecide]);
  const deny = useCallback((always: boolean) => onDecide(false, always), [onDecide]);

  // Best-effort single display value for the tool's target
  const targetDisplay =
    (request.input['path'] as string | undefined) ??
    (request.input['command'] as string | undefined) ??
    JSON.stringify(request.input).slice(0, 60);

  return (
    <div
      className="fixed inset-0 bg-black/65 backdrop-blur-[6px] z-50 flex items-center justify-center p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="escalation-title"
    >
      <div
        className="w-full max-w-[460px] glass-elevated rounded-[var(--radius-lg)] shadow-dialog animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-[var(--border-subtle)]">
          <div className="
            w-9 h-9 rounded-[var(--radius-sm)] flex-shrink-0
            bg-[rgba(245,166,35,0.1)] border border-[rgba(245,166,35,0.22)]
            flex items-center justify-center
          ">
            <ShieldAlert size={18} className="text-[var(--warning)]" />
          </div>
          <div>
            <h2
              id="escalation-title"
              className="text-[13px] font-bold text-[var(--text-primary)]"
            >
              Permission required
            </h2>
            <p className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5">
              No tier could determine if this action is safe
            </p>
          </div>
        </div>

        {/* Requested tool */}
        <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
          <p className="section-label mb-2">Requested action</p>
          <div className="
            flex items-center gap-2
            bg-[var(--bg-base)] rounded-[var(--radius-xs)]
            border border-[var(--border-subtle)] px-3 py-2
          ">
            <code className="text-[var(--accent)] font-mono font-bold text-[11px] flex-shrink-0">
              {request.toolName}
            </code>
            {targetDisplay && (
              <>
                <span className="text-[var(--text-faint)] text-[11px]">→</span>
                <code className="text-[var(--text-muted)] font-mono text-[10px] truncate flex-1 min-w-0">
                  {targetDisplay}
                </code>
              </>
            )}
            {request.isDangerous && (
              <span className="ml-auto badge badge-FAILED flex-shrink-0">Dangerous</span>
            )}
          </div>
        </div>

        {/* Escalation trail */}
        <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
          <p className="section-label mb-2">Escalation trail</p>
          <TierStep
            icon="🔹"
            tier="T3"
            label={`"${request.subtaskContext}" requested this`}
          />
          <TierStep
            icon="🟣"
            tier="T2"
            label={`Section "${request.sectionContext}" evaluated — uncertain`}
          />
          <TierStep
            icon="🟡"
            tier="T1"
            label="Full task context evaluated — uncertain"
            isLast
          />

          <div className="flex items-center gap-3 pt-3">
            <div className="w-6 h-6 rounded-full bg-[var(--accent)] flex items-center justify-center flex-shrink-0">
              <span className="text-white text-[10px] font-bold">?</span>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-[var(--text-primary)]">Your decision required</p>
              <p className="text-[9px] font-mono text-[var(--text-muted)] mt-0.5">
                Press{' '}
                <kbd className="px-1 py-0.5 rounded-[3px] bg-[var(--bg-overlay)] border border-[var(--border-strong)] font-mono text-[8px]">Y</kbd>
                {' '}to approve,{' '}
                <kbd className="px-1 py-0.5 rounded-[3px] bg-[var(--bg-overlay)] border border-[var(--border-strong)] font-mono text-[8px]">N</kbd>
                {' '}to deny
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 py-4">
          <div className="grid grid-cols-2 gap-2 mb-2">
            <button className="btn btn-danger justify-center" onClick={() => deny(false)}>
              Deny once
            </button>
            <button className="btn btn-success justify-center" onClick={() => approve(false)}>
              Approve once
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button className="btn btn-ghost justify-center" onClick={() => deny(true)}>
              Always deny
            </button>
            <button className="btn btn-ghost justify-center" onClick={() => approve(true)}>
              Always approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});