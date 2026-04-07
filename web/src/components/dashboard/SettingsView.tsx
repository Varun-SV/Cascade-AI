import React, { useState } from 'react';
import { useAppDispatch } from '../../store';
import { clearFrontendGraphs } from '../../store/slices/runtimeSlice';

export function SettingsView({ token }: { token: string }) {
  const dispatch = useAppDispatch();
  const [clearing, setClearing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleClearSessions = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setClearing(true);
    try {
      await fetch('/api/sessions', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      setConfirmDelete(false);
    } catch (e) {
      console.error(e);
    } finally {
      setClearing(false);
    }
  };

  const handleClearGraphsBackend = async () => {
    setClearing(true);
    try {
      await fetch('/api/runtime', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      dispatch(clearFrontendGraphs());
    } catch (e) {
      console.error(e);
    } finally {
      setClearing(false);
    }
  };

  const handleClearGraphsFrontend = () => {
    dispatch(clearFrontendGraphs());
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto p-8 animate-fade-in">
      <div className="max-w-2xl mx-auto w-full">
        <h2 className="text-xl font-bold mb-6 text-[var(--text-primary)] tracking-tight">Settings</h2>

        {/* Danger Zone */}
        <div className="glass-elevated rounded-[var(--radius-lg)] p-6 mb-8 border border-[var(--error)]/30">
          <h3 className="section-label mb-4 text-[var(--error)]">Danger Zone</h3>
          
          <div className="flex items-center justify-between py-4 border-b border-[var(--border-base)]">
            <div>
              <p className="font-medium text-[var(--text-primary)]">Clear AI Sessions</p>
              <p className="text-sm text-[var(--text-muted)] mt-1">Permanently delete all session history and messages from the database.</p>
            </div>
            <button
              onClick={handleClearSessions}
              disabled={clearing}
              className={`btn ${confirmDelete ? 'btn-primary bg-[var(--error)] hover:bg-[var(--error)] border-transparent' : 'glass border border-[var(--error)]/50 hover:bg-[var(--error)]/10'} transition-all`}
            >
              {clearing ? 'Clearing...' : confirmDelete ? 'Click again to confirm' : 'Clear Sessions'}
            </button>
          </div>

          <div className="flex items-center justify-between py-4 border-b border-[var(--border-base)]">
            <div>
              <p className="font-medium text-[var(--text-primary)]">Clear Topology Graphs (Backend)</p>
              <p className="text-sm text-[var(--text-muted)] mt-1">Delete all active execution graphs and logs from the server.</p>
            </div>
            <button
              onClick={handleClearGraphsBackend}
              disabled={clearing}
              className="btn btn-primary bg-yellow-600/80 hover:bg-yellow-600 border-transparent transition-all"
            >
              Clear DB Graphs
            </button>
          </div>

          <div className="flex items-center justify-between py-4">
            <div>
              <p className="font-medium text-[var(--text-primary)]">Clear Topology Graphs (Frontend Only)</p>
              <p className="text-sm text-[var(--text-muted)] mt-1">Clear the graph view locally without affecting the server.</p>
            </div>
            <button
              onClick={handleClearGraphsFrontend}
              className="btn glass transition-all"
            >
              Clear View
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
