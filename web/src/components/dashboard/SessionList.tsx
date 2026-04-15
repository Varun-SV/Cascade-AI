import React, { memo, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import {
  setActiveSession,
  selectSessions,
  selectActiveSession,
} from '../../store/slices/runtimeSlice';
import { Clock, Folder, Activity } from 'lucide-react';
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

  const handleSelect = useCallback((id: string) => {
    dispatch(setActiveSession(id));
  }, [dispatch]);

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex-shrink-0 bg-[var(--bg-surface)]">
        <h2 className="section-label">Sessions</h2>
        <p className="text-[10px] font-mono text-[var(--text-faint)] mt-1">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {sessions.map((session: RuntimeSession, idx: number) => {
          const isActive = session.sessionId === activeSession?.sessionId;

          return (
            <button
              key={session.sessionId}
              aria-selected={isActive}
              aria-label={`Session: ${session.title}, status: ${session.status}`}
              onClick={() => handleSelect(session.sessionId)}
              // Fix: previously animationDelay was set in style but no animation
              // class was applied, so the delay had no effect. Now we apply both.
              className="
                w-full text-left px-5 py-3.5
                border-b border-[var(--border-subtle)]
                transition-all duration-150 relative
                animate-slide-up
              "
              style={{
                animationDelay: `${idx * 25}ms`,
                background: isActive ? 'rgba(124,106,247,0.05)' : undefined,
                borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                paddingLeft: isActive ? '18px' : '20px',
              }}
            >
              {/* Title + status */}
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[12px] font-semibold text-[var(--text-primary)] truncate">
                  {session.title || 'Untitled Session'}
                </span>
                <span className={`badge badge-${session.status} flex-shrink-0`}>
                  {session.status}
                </span>
              </div>

              {/* Workspace path */}
              {session.workspacePath && (
                <div className="flex items-center gap-1.5 mb-1">
                  <Folder size={9} className="text-[var(--text-faint)] flex-shrink-0" />
                  <span className="text-[9px] font-mono text-[var(--text-faint)] truncate">
                    {session.workspacePath.split('/').pop()}
                  </span>
                </div>
              )}

              {/* Latest prompt preview */}
              {session.latestPrompt && (
                <p className="text-[10px] text-[var(--text-muted)] truncate mb-1.5 italic">
                  "{session.latestPrompt}"
                </p>
              )}

              {/* Timestamps */}
              <div className="flex items-center gap-3">
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
    </div>
  );
});