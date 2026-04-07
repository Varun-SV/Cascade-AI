import React, { memo, useEffect, useRef } from 'react';
import { X, Cpu, Activity, Clock, ChevronRight } from 'lucide-react';
import type { RuntimeNode } from '../../hooks/useWebSocket';

interface InspectorPanelProps {
  node: RuntimeNode | null;
  streamLog: string;
  onClose: () => void;
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
    </div>
  );
}

function InfoRow({ icon: Icon, label, children }: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3 border-b border-[var(--border-subtle)]">
      <p className="section-label flex items-center gap-1.5 mb-1.5">
        <Icon size={9} />
        {label}
      </p>
      {children}
    </div>
  );
}

export const InspectorPanel = memo(function InspectorPanel({
  node,
  streamLog,
  onClose,
}: InspectorPanelProps) {
  const streamRef = useRef<HTMLDivElement>(null);

  // Auto-scroll stream to bottom on new tokens
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamLog]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <aside
      role="complementary"
      aria-label="Agent inspector"
      className="
        flex flex-col w-[300px] flex-shrink-0 h-full
        border-l border-[var(--border-subtle)]
        bg-[var(--bg-surface)] animate-slide-in overflow-hidden
      "
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-subtle)] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Cpu size={13} className="text-[var(--accent)]" />
          <span className="section-label">Inspector</span>
        </div>
        <button
          aria-label="Close inspector"
          onClick={onClose}
          className="
            w-6 h-6 rounded-[var(--radius-xs)] flex items-center justify-center
            text-[var(--text-faint)] hover:text-[var(--text-primary)]
            hover:bg-[var(--bg-elevated)] transition-all
          "
        >
          <X size={13} />
        </button>
      </div>

      {node ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Identity */}
          <div className="px-4 py-4 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2 mb-2">
              <span className={`badge badge-${node.role}`}>{node.role}</span>
              <span className={`badge badge-${node.status}`}>{node.status}</span>
            </div>
            <h2 className="text-[12px] font-semibold text-[var(--text-primary)] leading-snug">
              {node.label}
            </h2>
            <p className="text-[9px] text-[var(--text-muted)] font-mono mt-1 break-all opacity-60">
              {node.tierId}
            </p>
          </div>

          {/* Progress */}
          {node.progressPct !== undefined && (
            <InfoRow icon={Activity} label="Progress">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-mono text-[var(--text-primary)]">
                  {node.progressPct}%
                </span>
              </div>
              <ProgressBar pct={node.progressPct} />
            </InfoRow>
          )}

          {/* Current action */}
          {node.currentAction && (
            <InfoRow icon={ChevronRight} label="Current action">
              <p className="text-[11px] text-[var(--text-primary)] leading-snug">
                {node.currentAction}
              </p>
            </InfoRow>
          )}

          {/* Timestamp */}
          <InfoRow icon={Clock} label="Last update">
            <p className="text-[10px] font-mono text-[var(--text-muted)]">
              {new Date(node.updatedAt).toLocaleTimeString()}
            </p>
          </InfoRow>

          {/* Live stream — terminal style */}
          <div className="flex flex-col flex-1 min-h-0 px-3 py-3">
            <p className="section-label mb-2 flex-shrink-0">Live output</p>
            <div
              ref={streamRef}
              className="
                flex-1 overflow-y-auto font-mono text-[9.5px]
                text-[var(--t3-color)] leading-[1.7]
                whitespace-pre-wrap break-words
                bg-[var(--bg-base)] rounded-[var(--radius-xs)]
                p-2.5 border border-[var(--border-subtle)]
                scrollbar-thin
              "
              aria-live="polite"
              aria-label="Live token stream"
            >
              {streamLog ? (
                <span>
                  {streamLog.slice(-4000)}
                  <span className="animate-blink text-[var(--t3-color)]">█</span>
                </span>
              ) : (
                <span className="text-[var(--text-faint)] italic">
                  Waiting for output…
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center p-6">
          <div className="w-9 h-9 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center">
            <Cpu size={16} className="text-[var(--text-faint)]" />
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            Select an agent node to inspect it
          </p>
        </div>
      )}
    </aside>
  );
});