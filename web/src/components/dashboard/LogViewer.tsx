import React, { memo, useRef, useEffect, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppSelector } from '../../store';
import { selectActiveLogs } from '../../store/slices/runtimeSlice';
import type { RuntimeNodeLog } from '../../hooks/useWebSocket';

// ── Filters ────────────────────────────────────

type RoleFilter = 'ALL' | 'T1' | 'T2' | 'T3';
type StatusFilter = 'ALL' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';

function FilterPill({
  label,
  active,
  onClick,
  colorClass = '',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  colorClass?: string;
}) {
  return (
    <button
      className={`px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider
                  transition-all duration-150 border
                  ${active
                    ? `bg-[var(--accent)] text-white border-[var(--accent)]`
                    : `bg-transparent text-[var(--text-muted)] border-[var(--border-subtle)] hover:border-[var(--border-strong)]`
                  } ${colorClass}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ── Log Row ─────────────────────────────────────

const LogRow = memo(function LogRow({ log, style }: { log: RuntimeNodeLog; style: React.CSSProperties }) {
  return (
    <div
      style={style}
      className="flex items-center gap-3 px-5 border-b border-[var(--border-subtle)]
                 hover:bg-[var(--bg-elevated)] transition-colors"
    >
      <span className="text-[10px] font-mono text-[var(--text-faint)] flex-shrink-0 w-[72px]">
        {new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false })}
      </span>
      <span className={`badge flex-shrink-0 badge-${log.role}`}>{log.role}</span>
      <span className={`badge flex-shrink-0 badge-${log.status}`}>{log.status}</span>
      <span className="text-[11px] font-medium text-[var(--text-primary)] truncate flex-shrink-0 max-w-[120px]">
        {log.label}
      </span>
      {log.currentAction && (
        <span className="text-[10px] text-[var(--text-muted)] truncate flex-1 min-w-0">
          {log.currentAction}
        </span>
      )}
    </div>
  );
});

// ── Main Component ─────────────────────────────

export const LogViewer = memo(function LogViewer() {
  const logs = useAppSelector(selectActiveLogs);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [autoScroll, setAutoScroll] = useState(true);
  const parentRef = useRef<HTMLDivElement>(null);

  const filteredLogs = logs.filter((log) => {
    if (roleFilter !== 'ALL' && log.role !== roleFilter) return false;
    if (statusFilter !== 'ALL' && log.status !== statusFilter) return false;
    return true;
  });

  const virtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && filteredLogs.length > 0) {
      virtualizer.scrollToIndex(filteredLogs.length - 1, { behavior: 'smooth' });
    }
  }, [filteredLogs.length, autoScroll, virtualizer]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
    setAutoScroll(atBottom);
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--border-subtle)] flex-shrink-0 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mr-1">Role</span>
        {(['ALL', 'T1', 'T2', 'T3'] as RoleFilter[]).map((r) => (
          <FilterPill key={r} label={r} active={roleFilter === r} onClick={() => setRoleFilter(r)} />
        ))}

        <div className="w-px h-4 bg-[var(--border-subtle)] mx-1" />

        <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mr-1">Status</span>
        {(['ALL', 'ACTIVE', 'COMPLETED', 'FAILED', 'ESCALATED'] as StatusFilter[]).map((s) => (
          <FilterPill key={s} label={s} active={statusFilter === s} onClick={() => setStatusFilter(s)} />
        ))}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] text-[var(--text-faint)]">
            {filteredLogs.length} entries
          </span>
          {!autoScroll && (
            <button
              className="btn btn-ghost py-0.5 px-2 text-[10px]"
              onClick={() => {
                setAutoScroll(true);
                virtualizer.scrollToIndex(filteredLogs.length - 1);
              }}
            >
              ↓ Jump to latest
            </button>
          )}
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center gap-3 px-5 py-2 border-b border-[var(--border-subtle)]
                      bg-[var(--bg-surface)] flex-shrink-0">
        <span className="text-[9px] uppercase tracking-widest text-[var(--text-faint)] w-[72px]">Time</span>
        <span className="text-[9px] uppercase tracking-widest text-[var(--text-faint)] w-[32px]">Role</span>
        <span className="text-[9px] uppercase tracking-widest text-[var(--text-faint)] w-[72px]">Status</span>
        <span className="text-[9px] uppercase tracking-widest text-[var(--text-faint)] w-[120px]">Agent</span>
        <span className="text-[9px] uppercase tracking-widest text-[var(--text-faint)]">Action</span>
      </div>

      {/* Virtual log rows */}
      {filteredLogs.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-[var(--text-faint)] text-[12px]">
          {logs.length === 0 ? 'No log entries' : 'No entries match the current filter'}
        </div>
      ) : (
        <div
          ref={parentRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto"
          aria-label="Activity log"
          role="log"
          aria-live="polite"
        >
          <div
            style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const log = filteredLogs[virtualRow.index]!;
              return (
                <LogRow
                  key={log.id}
                  log={log}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                    height: `${virtualRow.size}px`,
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
