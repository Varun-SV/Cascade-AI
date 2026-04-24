import React, { memo, useEffect, useRef, useState } from 'react';
import { X, Cpu, Activity, Clock, ChevronRight, MessageSquare } from 'lucide-react';
import type { RuntimeNode } from '../../types/protocol';
import type { PeerMessageRecord } from '../../store/slices/runtimeSlice';

interface InspectorPanelProps {
  node: RuntimeNode | null;
  streamLog: string;
  peerMessages?: PeerMessageRecord[];
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
  peerMessages = [],
  onClose,
}: InspectorPanelProps) {
  const streamRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<'output' | 'comms'>('output');

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

          {/* Tabs: Output / Communications */}
          <div className="flex gap-0 px-3 pt-2 flex-shrink-0 border-b border-[var(--border-subtle)]">
            {(['output', 'comms'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`
                  flex items-center gap-1 px-2.5 py-1.5 text-[9.5px] font-medium rounded-t-sm
                  transition-colors border-b-2 -mb-px
                  ${activeTab === tab
                    ? 'text-[var(--accent)] border-[var(--accent)]'
                    : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text-primary)]'}
                `}
              >
                {tab === 'output' ? <Cpu size={9} /> : <MessageSquare size={9} />}
                {tab === 'output' ? 'Output' : `Comms${peerMessages.length ? ` (${peerMessages.length})` : ''}`}
              </button>
            ))}
          </div>

          {activeTab === 'output' && (
            <div className="flex flex-col flex-1 min-h-0 px-3 py-3">
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
                {node.output ? (
                  <span>{node.output}</span>
                ) : streamLog && node.status === 'ACTIVE' ? (
                  <span>
                    {streamLog.slice(-4000)}
                    <span className="animate-blink text-[var(--t3-color)]">█</span>
                  </span>
                ) : (
                  <span className="text-[var(--text-faint)] italic">
                    {node.status === 'COMPLETED' ? 'No output recorded.' : 'Waiting for output…'}
                  </span>
                )}
              </div>
            </div>
          )}

          {activeTab === 'comms' && (
            <div className="flex flex-col flex-1 min-h-0 px-3 py-3">
              <div className="flex-1 overflow-y-auto scrollbar-thin space-y-1.5">
                {peerMessages.length === 0 ? (
                  <p className="text-[10px] text-[var(--text-faint)] italic text-center py-6">
                    No peer communications yet
                  </p>
                ) : [...peerMessages].reverse().map((msg, i) => (
                  <div
                    key={i}
                    className="text-[9.5px] rounded-[var(--radius-xs)] bg-[var(--bg-base)] border border-[var(--border-subtle)] px-2.5 py-2"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-[var(--warning)] font-medium">{msg.syncType}</span>
                      <span className="text-[var(--text-faint)]">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-[var(--text-muted)] font-mono">
                      <span className="text-[var(--text-primary)]">{msg.fromId.slice(0, 12)}</span>
                      {' → '}
                      <span className="text-[var(--text-primary)]">{msg.toId ? msg.toId.slice(0, 12) : 'all'}</span>
                    </div>
                    {msg.payload && (
                      <p className="mt-1 text-[var(--text-faint)] truncate">{msg.payload.slice(0, 80)}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
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
