import React, { memo, useCallback, useState } from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import {
  setActiveSession,
  selectSessions,
  selectActiveSession,
  removeSessionsBulk,
} from '../../store/slices/runtimeSlice';
import { Clock, Folder, Activity, Trash2, CheckSquare, Square } from 'lucide-react';
import type { RuntimeSession } from '../../types/protocol';

// ── Helpers ────────────────────────────────────

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1_000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

// ── Component ──────────────────────────────────

export const SessionList = memo(function SessionList() {
  const dispatch = useAppDispatch();
  const sessions = useAppSelector(selectSessions);
  const activeSession = useAppSelector(selectActiveSession);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleSelect = useCallback((id: string) => {
    if (selectedIds.size === 0) {
      dispatch(setActiveSession(id));
    }
  }, [dispatch, selectedIds.size]);

  const toggleSelect = useCallback((id: string, idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (e.shiftKey && lastSelectedIdx !== null) {
        // Range select
        const [start, end] = [Math.min(lastSelectedIdx, idx), Math.max(lastSelectedIdx, idx)];
        for (let i = start; i <= end; i++) {
          const sid = sessions[i]?.sessionId;
          if (sid) next.add(sid);
        }
      } else {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    setLastSelectedIdx(idx);
  }, [lastSelectedIdx, sessions]);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === sessions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sessions.map(s => s.sessionId)));
    }
  }, [selectedIds.size, sessions]);

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0 || isDeleting) return;
    setIsDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await fetch('/api/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (res.ok) {
        dispatch(removeSessionsBulk(ids));
        setSelectedIds(new Set());
        setLastSelectedIdx(null);
      }
    } finally {
      setIsDeleting(false);
    }
  }, [selectedIds, isDeleting, dispatch]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setLastSelectedIdx(null);
  }, []);

  if (!sessions.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 animate-fade-in">
        <div className="w-11 h-11 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center">
          <Activity size={18} className="text-[var(--text-faint)]" />
        </div>
        <p className="text-[12px] text-[var(--text-muted)]">No sessions yet</p>
        <p className="text-[10px] font-mono text-[var(--text-faint)]">Run a task to create the first session</p>
      </div>
    );
  }

  const allSelected = selectedIds.size === sessions.length;
  const someSelected = selectedIds.size > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex-shrink-0 bg-[var(--bg-surface)]">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="section-label">Sessions</h2>
            <p className="text-[10px] font-mono text-[var(--text-faint)] mt-1">
              {sessions.length} session{sessions.length !== 1 ? 's' : ''}
              {someSelected && (
                <span className="text-[var(--accent)] ml-2">· {selectedIds.size} selected</span>
              )}
            </p>
          </div>
          <button
            onClick={handleSelectAll}
            title={allSelected ? 'Deselect all' : 'Select all'}
            className="p-1.5 rounded hover:bg-[var(--bg-elevated)] transition-colors"
          >
            {allSelected ? (
              <CheckSquare size={14} className="text-[var(--accent)]" />
            ) : (
              <Square size={14} className="text-[var(--text-faint)]" />
            )}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {sessions.map((session: RuntimeSession, idx: number) => {
          const isActive = session.sessionId === activeSession?.sessionId;
          const isSelected = selectedIds.has(session.sessionId);

          return (
            <button
              key={session.sessionId}
              aria-selected={isActive}
              aria-label={`Session: ${session.title}, status: ${session.status}`}
              onClick={() => handleSelect(session.sessionId)}
              className="
                w-full text-left px-5 py-3.5
                border-b border-[var(--border-subtle)]
                transition-all duration-150 relative
                animate-slide-up
              "
              style={{
                animationDelay: `${idx * 25}ms`,
                background: isSelected
                  ? 'rgba(124,106,247,0.08)'
                  : isActive
                    ? 'rgba(124,106,247,0.05)'
                    : undefined,
                borderLeft: isSelected
                  ? '2px solid var(--accent)'
                  : isActive
                    ? '2px solid var(--accent)'
                    : '2px solid transparent',
                paddingLeft: isActive || isSelected ? '18px' : '20px',
              }}
            >
              {/* Selection checkbox + Title row */}
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  {/* Checkbox — clicking it toggles selection without navigating */}
                  <span
                    role="checkbox"
                    aria-checked={isSelected}
                    onClick={(e) => toggleSelect(session.sessionId, idx, e)}
                    className="flex-shrink-0 cursor-pointer"
                  >
                    {isSelected ? (
                      <CheckSquare size={12} className="text-[var(--accent)]" />
                    ) : (
                      <Square size={12} className="text-[var(--text-faint)] opacity-40 hover:opacity-100 transition-opacity" />
                    )}
                  </span>
                  <span className="text-[12px] font-semibold text-[var(--text-primary)] truncate">
                    {session.title || 'Untitled Session'}
                  </span>
                </div>
                <span className={`badge badge-${session.status} flex-shrink-0`}>
                  {session.status}
                </span>
              </div>

              {/* Workspace path */}
              {session.workspacePath && (
                <div className="flex items-center gap-1.5 mb-1 pl-5">
                  <Folder size={9} className="text-[var(--text-faint)] flex-shrink-0" />
                  <span className="text-[9px] font-mono text-[var(--text-faint)] truncate">
                    {session.workspacePath.split('/').pop()}
                  </span>
                </div>
              )}

              {/* Latest prompt preview */}
              {session.latestPrompt && (
                <p className="text-[10px] text-[var(--text-muted)] truncate mb-1.5 italic pl-5">
                  "{session.latestPrompt}"
                </p>
              )}

              {/* Timestamps */}
              <div className="flex items-center gap-3 pl-5">
                <span className="flex items-center gap-1 text-[9px] font-mono text-[var(--text-faint)]">
                  <Clock size={8} />
                  {formatRelative(session.updatedAt)}
                </span>
                <span className="text-[9px] font-mono text-[var(--text-faint)]">
                  {formatDuration(session.startedAt, session.updatedAt)}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Floating bulk action bar */}
      {someSelected && (
        <div
          className="
            absolute bottom-4 left-1/2 -translate-x-1/2
            flex items-center gap-3 px-4 py-2.5 rounded-xl
            bg-[var(--bg-elevated)] border border-[var(--border-subtle)]
            shadow-lg z-10 animate-slide-up
          "
        >
          <span className="text-[11px] font-mono text-[var(--text-muted)]">
            {selectedIds.size} selected
          </span>
          <button
            onClick={handleBulkDelete}
            disabled={isDeleting}
            className="
              flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium
              bg-red-500/10 text-red-400 border border-red-500/20
              hover:bg-red-500/20 transition-colors disabled:opacity-50
            "
          >
            <Trash2 size={12} />
            {isDeleting ? 'Deleting...' : `Delete ${selectedIds.size}`}
          </button>
          <button
            onClick={clearSelection}
            className="text-[11px] text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
});
