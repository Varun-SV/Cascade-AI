import { useCallback, useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { GitCompareArrows, X, Undo2, FileX2, RefreshCcw } from 'lucide-react';
import { useAppDispatch, useAppSelector, setChangesSessionId } from '../store/index.js';
import { defineThemes } from './MonacoEditor.js';

interface FileChange {
  filePath: string;
  before: string;
  after: string;
  missing: boolean;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
  css: 'css', scss: 'scss', html: 'html', xml: 'xml', yml: 'yaml', yaml: 'yaml', sh: 'shell', sql: 'sql',
};

function langFor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXT[ext] ?? 'plaintext';
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * Diff review for one session: every file its runs touched, as before/after
 * Monaco diffs (before = the pre-run snapshot /rollback uses; after = the file
 * on disk now), with per-file revert — finer-grained than the session-wide
 * rollback button. Opened from a session row or the command palette; data from
 * GET /api/sessions/:id/changes, reverts via POST .../revert-file.
 */
export function ChangesModal() {
  const dispatch = useAppDispatch();
  const sessionId = useAppSelector((s) => s.app.changesSessionId);
  const { backendPort, authToken } = useAppSelector((s) => s.app);
  const dark = useAppSelector((s) => s.app.themeDark);
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId || !backendPort) return;
    setError(null);
    try {
      const res = await fetch(`http://localhost:${backendPort}/api/sessions/${sessionId}/changes`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { changes: FileChange[] };
      setChanges(data.changes);
      setSelected(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setChanges([]);
    }
  }, [sessionId, backendPort, authToken]);

  useEffect(() => { setChanges(null); void load(); }, [load]);

  const close = useCallback(() => dispatch(setChangesSessionId(null)), [dispatch]);

  useEffect(() => {
    if (!sessionId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId, close]);

  if (!sessionId) return null;

  const revert = async (filePath: string) => {
    setReverting(filePath);
    try {
      const res = await fetch(`http://localhost:${backendPort}/api/sessions/${sessionId}/revert-file`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      await load(); // reverted file drops out of the changed list
    } catch (err) {
      setError(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReverting(null);
    }
  };

  const current = changes?.[selected];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 350, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        width: '90vw', height: '84vh', maxWidth: 1200, background: 'var(--bg-surface)',
        border: '1px solid var(--border-strong)', borderRadius: 12, boxShadow: 'var(--shadow-3)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ height: 42, padding: '0 14px', display: 'flex', alignItems: 'center', gap: 9, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <GitCompareArrows size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 700, fontSize: 13.5 }}>File changes — this session</span>
          {changes && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{changes.length} changed file{changes.length !== 1 ? 's' : ''}</span>}
          <div style={{ flex: 1 }} />
          <button onClick={() => void load()} title="Refresh" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 3, display: 'flex' }}>
            <RefreshCcw size={13} />
          </button>
          <button onClick={close} title="Close (Esc)" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 3, display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        {error && (
          <div style={{ padding: '6px 14px', fontSize: 11.5, color: 'var(--danger)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>{error}</div>
        )}

        {!changes ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>Loading changes…</div>
        ) : changes.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: 'var(--text-muted)', fontSize: 12.5, padding: 24, textAlign: 'center' }}>
            <GitCompareArrows size={26} style={{ opacity: 0.4 }} />
            <div>
              No file changes recorded for this session in the current app run.<br />
              <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>Snapshots are kept while the app is open — runs from before a restart can't be diffed.</span>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {/* File list */}
            <div style={{ width: 260, borderRight: '1px solid var(--border)', overflowY: 'auto', flexShrink: 0, padding: '6px 0' }}>
              {changes.map((c, i) => (
                <div
                  key={c.filePath}
                  onClick={() => setSelected(i)}
                  title={c.filePath}
                  style={{
                    padding: '6px 12px', cursor: 'pointer', fontSize: 11.5,
                    borderLeft: `2px solid ${i === selected ? 'var(--accent)' : 'transparent'}`,
                    background: i === selected ? 'var(--accent-soft)' : 'transparent',
                    display: 'flex', alignItems: 'center', gap: 7,
                  }}
                >
                  {c.missing
                    ? <FileX2 size={12} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                    : <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--warn)', flexShrink: 0 }} />}
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', color: 'var(--text)', fontWeight: i === selected ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{baseName(c.filePath)}</span>
                    <span style={{ display: 'block', color: 'var(--text-dim)', fontSize: 9.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>{c.filePath}</span>
                  </span>
                </div>
              ))}
            </div>

            {/* Diff */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {current && (
                <>
                  <div style={{ height: 34, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                    <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {current.filePath}{current.missing && <span style={{ color: 'var(--danger)' }}> — deleted since the run</span>}
                    </span>
                    <button
                      onClick={() => void revert(current.filePath)}
                      disabled={reverting === current.filePath}
                      title="Restore this file to its pre-run content"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
                        background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6,
                        color: 'var(--warn)', padding: '4px 10px', fontSize: 11, fontWeight: 600,
                        cursor: reverting === current.filePath ? 'wait' : 'pointer',
                      }}
                    >
                      <Undo2 size={12} /> {reverting === current.filePath ? 'Reverting…' : 'Revert this file'}
                    </button>
                  </div>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <DiffEditor
                      original={current.before}
                      modified={current.missing ? '' : current.after}
                      language={langFor(current.filePath)}
                      theme={dark ? 'cascade-dark' : 'cascade-light'}
                      beforeMount={defineThemes}
                      options={{
                        readOnly: true,
                        renderSideBySide: true,
                        fontSize: 12,
                        fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
