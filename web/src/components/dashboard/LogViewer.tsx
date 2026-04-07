import React, { memo, useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppSelector } from '../../store';
import { selectActiveLogs } from '../../store/slices/runtimeSlice';
import type { RuntimeNodeLog } from '../../hooks/useWebSocket';

// ── Filter types ───────────────────────────────

type RoleFilter = 'ALL' | 'T1' | 'T2' | 'T3';
type StatusFilter = 'ALL' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';

// ── FilterPill ─────────────────────────────────

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`
        px-2.5 py-1 rounded-[3px] text-[9px] font-mono font-bold
        uppercase tracking-wider transition-all duration-100 border
        ${active
          ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
          : 'bg-transparent text-[var(--text-muted)] border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
        }
      `}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ── LogRow ─────────────────────────────────────

const ROW_HEIGHT = 38;

const LogRow = memo(function LogRow({
  log,
  style,
}: {
  log: RuntimeNodeLog;
  style: React.CSSProperties;
}) {
  return (
    <div
      style={style}
      className="
        flex items-center gap-3 px-5
        border-b border-[var(--border-subtle)]
        hover:bg-[var(--bg-elevated)] transition-colors
      "
    >
      {/* Time */}
      <span className="text-[9px] font-mono text-[var(--text-faint)] flex-shrink-0 w-[64px] tabular-nums">
        {new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false })}
      </span>

      {/* Tier badge */}
      <span className={`badge badge-${log.role} flex-shrink-0`}>{log.role}</span>

      {/* Status badge */}
      <span className={`badge badge-${log.status} flex-shrink-0`}>{log.status}</span>

      {/* Agent name */}
      <span className="text-[10px] font-medium text-[var(--text-primary)] truncate flex-shrink-0 max-w-[120px]">
        {log.label}
      </span>

      {/* Action */}
      {log.currentAction && (
        <span className="text-[9px] text-[var(--text-muted)] font-mono truncate flex-1 min-w-0">
          {log.currentAction}
        </span>
      )}
    </div>
  );
});

// ── Main ───────────────────────────────────────

export const LogViewer = memo(function LogViewer() {
  const logs = useAppSelector(selectActiveLogs);

  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [autoScroll, setAutoScroll] = useState(true);

  const parentRef = useRef<HTMLDivElement>(null);

  // Memoised filter — previously recomputed on every render
  const filteredLogs = useMemo(
    () => logs.filter((log) => {
      if (roleFilter !== 'ALL' && log.role !== roleFilter) return false;
      if (statusFilter !== 'ALL' && log.status !== statusFilter) return false;
      return true;
    }),
    [logs, roleFilter, statusFilter],
  );

  const virtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Auto-scroll to bottom.
  // `virtualizer` is excluded from deps intentionally: the virtualizer object
  // reference changes on every render (TanStack creates a new object) and
  // including it caused an infinite scroll loop. scrollToIndex is stable.
  const scrollToBottom = useCallback(() => {
    if (filteredLogs.length > 0) {
      virtualizer.scrollToIndex(filteredLogs.length - 1, { behavior: 'smooth' });
    }
  }, [filteredLogs.length, virtualizer]);

  useEffect(() => {
    if (autoScroll) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredLogs.length, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop <= el.clientHeight + 60);
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[var(--bg-base)]">
      {/* Filter bar */}
      <div className="
        flex items-center gap-2 px-5 py-2.5
        border-b border-[var(--border-subtle)] flex-shrink-0 flex-wrap
        bg-[var(--bg-surface)]
      ">
        <span className="section-label mr-1">Role</span>
        {(['ALL', 'T1', 'T2', 'T3'] as RoleFilter[]).map((r) => (
          <FilterPill key={r} label={r} active={roleFilter === r} onClick={() => setRoleFilter(r)} />
        ))}

        <div className="divider-v h-4 mx-1" />

        <span className="section-label mr-1">Status</span>
        {(['ALL', 'ACTIVE', 'COMPLETED', 'FAILED', 'ESCALATED'] as StatusFilter[]).map((s) => (
          <FilterPill key={s} label={s} active={statusFilter === s} onClick={() => setStatusFilter(s)} />
        ))}

        <div className="ml-auto flex items-center gap-3">
          <span className="text-[9px] font-mono text-[var(--text-faint)] tabular-nums">
            {filteredLogs.length.toLocaleString()} entries
          </span>
          {!autoScroll && (
            <button
              className="btn btn-ghost py-0.5 px-2"
              onClick={() => { setAutoScroll(true); scrollToBottom(); }}
            >
              ↓ Jump to latest
            </button>
          )}
        </div>
      </div>

      {/* Column headers */}
      <div className="
        flex items-center gap-3 px-5 py-1.5
        border-b border-[var(--border-subtle)]
        bg-[var(--bg-surface)] flex-shrink-0
      ">
        <span className="section-label w-[64px]">Time</span>
        <span className="section-label w-[28px]">Tier</span>
        <span className="section-label w-[72px]">Status</span>
        <span className="section-label w-[120px]">Agent</span>
        <span className="section-label">Action</span>
      </div>

      {/* Virtual rows */}
      {filteredLogs.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-[var(--text-faint)] text-[11px] font-mono">
          {logs.length === 0 ? '// no log entries' : '// no entries match filter'}
        </div>
      ) : (
        <div
          ref={parentRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto"
          role="log"
          aria-label="Activity log"
          aria-live="polite"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vRow) => {
              const log = filteredLogs[vRow.index]!;
              return (
                <LogRow
                  key={log.id}
                  log={log}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vRow.start}px)`,
                    height: `${vRow.size}px`,
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