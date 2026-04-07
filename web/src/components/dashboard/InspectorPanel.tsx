import React, { memo, useEffect, useRef } from 'react';
import { X, Cpu, Activity, Clock, ChevronRight } from 'lucide-react';
import type { RuntimeNode } from '../../hooks/useWebSocket';

interface InspectorPanelProps {
  node: RuntimeNode | null;
  streamLog: string;
  onClose: () => void;
}

function StatusBar({ pct }: { pct: number }) {
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

export const InspectorPanel = memo(function InspectorPanel({
  node,
  streamLog,
  onClose,
}: InspectorPanelProps) {
  const streamRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new stream tokens
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamLog]);

  // Keyboard: Escape to close
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
        flex flex-col w-[320px] flex-shrink-0 h-full
        border-l border-[var(--border-subtle)] bg-[var(--bg-surface)]
        animate-slide-in overflow-hidden
      "
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="text-[var(--accent)]" />
          <span className="text-[12px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
            Inspector
          </span>
        </div>
        <button
          aria-label="Close inspector"
          onClick={onClose}
          className="w-6 h-6 rounded-[var(--radius-sm)] flex items-center justify-center
                     text-[var(--text-faint)] hover:text-[var(--text-primary)]
                     hover:bg-[var(--bg-elevated)] transition-all"
        >
          <X size={14} />
        </button>
      </div>

      {node ? (
        <div className="flex-1 overflow-y-auto flex flex-col gap-0">
          {/* Agent Summary */}
          <div className="px-4 py-4 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2 mb-3">
              <span className={`badge badge-${node.role}`}>{node.role}</span>
              <span className={`badge badge-${node.status}`}>{node.status}</span>
            </div>
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] leading-snug">
              {node.label}
            </h2>
            <p className="text-[11px] text-[var(--text-muted)] font-mono mt-1 break-all">
              {node.tierId}
            </p>
          </div>

          {/* Progress */}
          {node.progressPct !== undefined && (
            <div className="px-4 py-3 border-b border-[var(--border-subtle)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1">
                  <Activity size={10} /> Progress
                </span>
                <span className="text-[11px] font-mono text-[var(--text-primary)]">
                  {node.progressPct}%
                </span>
              </div>
              <StatusBar pct={node.progressPct} />
            </div>
          )}

          {/* Current Action */}
          {node.currentAction && (
            <div className="px-4 py-3 border-b border-[var(--border-subtle)]">
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1 flex items-center gap-1">
                <ChevronRight size={10} /> Current action
              </p>
              <p className="text-[11px] text-[var(--text-primary)] leading-snug">
                {node.currentAction}
              </p>
            </div>
          )}

          {/* Timestamps */}
          <div className="px-4 py-3 border-b border-[var(--border-subtle)]">
            <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1 flex items-center gap-1">
              <Clock size={10} /> Last update
            </p>
            <p className="text-[10px] font-mono text-[var(--text-muted)]">
              {new Date(node.updatedAt).toLocaleTimeString()}
            </p>
          </div>

          {/* Live Token Stream */}
          <div className="flex flex-col flex-1 min-h-0 px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2 flex-shrink-0">
              Live output
            </p>
            <div
              ref={streamRef}
              className="flex-1 overflow-y-auto font-mono text-[10px] text-[var(--text-muted)]
                         leading-relaxed whitespace-pre-wrap break-words
                         bg-[var(--bg-base)] rounded-[var(--radius-md)] p-3
                         border border-[var(--border-subtle)]"
              aria-live="polite"
              aria-label="Live token stream"
            >
              {streamLog
                ? streamLog.slice(-4000)
                : <span className="text-[var(--text-faint)] italic">Waiting for output…</span>
              }
            </div>
          </div>
        </div>
      ) : (
        /* No node selected */
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center p-6">
          <div className="w-10 h-10 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center">
            <Cpu size={18} className="text-[var(--text-faint)]" />
          </div>
          <p className="text-[12px] text-[var(--text-muted)]">Select an agent node to inspect it</p>
        </div>
      )}
    </aside>
  );
});
