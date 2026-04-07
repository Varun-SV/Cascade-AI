import React, { memo, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import { setActiveSession, selectSessions, selectActiveSession } from '../../store/slices/runtimeSlice';
import { Clock, Folder, Activity } from 'lucide-react';

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

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
        <div className="w-12 h-12 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center">
          <Activity size={20} className="text-[var(--text-faint)]" />
        </div>
        <p className="text-[12px] text-[var(--text-muted)]">No sessions yet</p>
        <p className="text-[11px] text-[var(--text-faint)]">Run a task to create your first session</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex-shrink-0">
        <h2 className="text-[11px] uppercase tracking-widest font-semibold text-[var(--text-muted)]">
          Sessions
        </h2>
        <p className="text-[10px] text-[var(--text-faint)] mt-0.5">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessions.map((session, idx) => {
          const isActive = session.sessionId === activeSession?.sessionId;
          return (
            <button
              key={session.sessionId}
              id={`session-${session.sessionId}`}
              aria-selected={isActive}
              aria-label={`Session: ${session.title}, status: ${session.status}`}
              onClick={() => handleSelect(session.sessionId)}
              className={`
                w-full text-left px-5 py-4 border-b border-[var(--border-subtle)]
                transition-all duration-150 group relative
                ${isActive
                  ? 'bg-[rgba(124,106,247,0.06)] border-l-2 border-l-[var(--accent)] pl-[18px]'
                  : 'hover:bg-[var(--bg-elevated)]'
                }
              `}
              style={{ animationDelay: `${idx * 30}ms` }}
            >
              {/* Title row */}
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">
                  {session.title || 'Untitled Session'}
                </span>
                <span className={`badge flex-shrink-0 badge-${session.status}`}>
                  {session.status}
                </span>
              </div>

              {/* Workspace path */}
              {session.workspacePath && (
                <div className="flex items-center gap-1.5 mb-1">
                  <Folder size={9} className="text-[var(--text-faint)] flex-shrink-0" />
                  <span className="text-[10px] text-[var(--text-faint)] font-mono truncate">
                    {session.workspacePath.split('/').pop()}
                  </span>
                </div>
              )}

              {/* Latent prompt preview */}
              {session.latestPrompt && (
                <p className="text-[10px] text-[var(--text-muted)] truncate mb-1.5">
                  "{session.latestPrompt}"
                </p>
              )}

              {/* Time row */}
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-[10px] text-[var(--text-faint)]">
                  <Clock size={9} />
                  {formatRelativeTime(session.updatedAt)}
                </span>
                <span className="text-[10px] text-[var(--text-faint)]">
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
