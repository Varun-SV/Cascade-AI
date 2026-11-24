import { useEffect, useState } from 'react';
import type { WorkspaceAsk, WorkspaceCallAsk } from '../App.js';
import { ALL_TOOLS, PRESETS, TOOL_NOTES, folderName, minutesLeft, presetOfSelection, toggleTool } from '../lib/workspace-tools.js';

const btn = (primary: boolean, danger = false): React.CSSProperties => ({
  padding: '7px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
  background: primary ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'var(--bg-raised)',
  color: primary ? '#fff' : danger ? 'var(--danger, #e5484d)' : 'var(--text)', border: primary ? 'none' : '1px solid var(--border)',
});
const card: React.CSSProperties = {
  width: 'min(520px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)', overflow: 'auto', background: 'var(--bg-panel, var(--bg))', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 10, padding: 18, fontSize: 13, lineHeight: 1.5,
};
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'grid', placeItems: 'center', zIndex: 1000 };

/**
 * A cloud run asking for a folder on this computer (app/electron/desktop-workspace.ts):
 * which folder, which tools, what the run is told it is called. Closing it is a no.
 * Then, while it runs, each risky call it makes asks here too.
 */
export function WorkspaceConsentModal() {
  const [asks, setAsks] = useState<WorkspaceAsk[]>([]);
  const [calls, setCalls] = useState<WorkspaceCallAsk[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [labelMode, setLabelMode] = useState<'device' | 'folder'>('device');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const w = window.cascade?.workspace;
    if (!w) return;
    w.onAsk((a) => setAsks((q) => [...q, a]));
    w.onAskClosed(({ id }) => setAsks((q) => q.filter((a) => a.id !== id)));
    w.onCallAsk((a) => setCalls((q) => [...q, a]));
    w.onCallAskClosed(({ id }) => setCalls((q) => q.filter((a) => a.id !== id)));
    // Asked before this window loaded (it was closed, or the app was starting): shown now.
    const add = <T extends { id: number }>(q: T[], more: T[]) => [...q, ...more.filter((m) => !q.some((x) => x.id === m.id))];
    void w.pending?.().then((p) => { setAsks((q) => add(q, p.asks)); setCalls((q) => add(q, p.calls)); }).catch(() => {});
  }, []);
  const ask = asks[0];
  useEffect(() => {
    setFolder(ask?.defaults.folder ?? null); setTools(ask?.defaults.tools ?? []); setLabelMode(ask?.defaults.labelMode ?? 'device'); setError(null);
  }, [ask?.id]);
  const ws = window.cascade?.workspace;
  if (!ws) return null;

  // A question about one call comes before anything else: a run is waiting on it.
  const call = calls[0];
  if (call) {
    const replyCall = async (a: 'allow' | 'deny' | 'all') => { await ws.answerCall(call.id, a); setCalls((q) => q.filter((c) => c.id !== call.id)); };
    return (
      <div role="alertdialog" aria-modal="true" aria-labelledby="ws-call-title" style={overlay}>
        <div style={card}>
          <h2 id="ws-call-title" style={{ margin: '0 0 4px', fontSize: 16 }}>{call.label ?? 'A cloud run'} wants to do something risky</h2>
          <p style={{ margin: '0 0 10px', color: 'var(--text-muted)' }}>{call.reason}. It is refused if you don&apos;t answer in about {minutesLeft(call.expiresAt, Date.now())} min.</p>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{TOOL_NOTES[call.tool] ?? call.tool} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>({call.tool})</span></div>
          <pre style={{ margin: '0 0 12px', padding: 8, maxHeight: 200, overflow: 'auto', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{call.summary}</pre>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" style={btn(false)} onClick={() => void replyCall('all')} title="Every other risky call in this run is allowed too, until it ends">Allow everything for this run</button>
            <button type="button" style={btn(false, true)} onClick={() => void replyCall('deny')}>Deny</button>
            <button type="button" style={btn(true)} onClick={() => void replyCall('allow')}>Allow</button>
          </div>
        </div>
      </div>
    );
  }
  if (!ask) return null;

  const pick = async () => {
    const r = await ws.pickFolder();
    if ('canceled' in r) return;
    if ('error' in r) { setError(r.error); return; }
    setError(null); setFolder(r.folder);
  };
  const reply = async (yes: boolean) => {
    if (yes && !folder) { setError('Choose a folder first.'); return; }
    if (yes && !tools.length) { setError('Choose at least one tool, or say no.'); return; }
    const r = await ws.answer(ask.id, yes ? { folder: folder!, tools, labelMode } : null);
    if ('error' in r) { setError(r.error); return; }
    setAsks((q) => q.filter((a) => a.id !== ask.id));
  };
  const preset = presetOfSelection(tools);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="ws-ask-title" style={overlay}>
      <form onSubmit={(e) => { e.preventDefault(); void reply(true); }} style={card}>
        <h2 id="ws-ask-title" style={{ margin: '0 0 4px', fontSize: 16 }}>A cloud run wants to work in a folder on this computer</h2>
        <p style={{ margin: '0 0 12px', color: 'var(--text-muted)' }}>
          {ask.chat ? `Asked by “${ask.chat}”. ` : ''}This question lapses in about {minutesLeft(ask.expiresAt, Date.now())} min.
        </p>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Folder</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" style={btn(false)} onClick={() => void pick()}>Choose a folder…</button>
          <span title={folder ?? ''} style={{ color: folder ? 'var(--text)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder ? folderName(folder) : 'None chosen'}</span>
        </div>
        <div style={{ fontWeight: 600, margin: '12px 0 4px' }}>What it may do</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {PRESETS.map((p) => (
            <button key={p.id} type="button" onClick={() => setTools([...p.tools])} style={{ ...btn(false), padding: '4px 10px', fontSize: 12, ...(preset === p.id ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}>{p.title}</button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 2 }}>
          {ALL_TOOLS.map((t) => (
            <label key={t} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <input type="checkbox" checked={tools.includes(t)} onChange={(e) => setTools((cur) => toggleTool(cur, t, e.target.checked))} />
              <span>{TOOL_NOTES[t]}</span>
            </label>
          ))}
        </div>
        <div style={{ fontWeight: 600, margin: '12px 0 4px' }}>What the run is told it is called</div>
        <label style={{ display: 'flex', gap: 6 }}><input type="radio" name="ws-label" checked={labelMode === 'device'} onChange={() => setLabelMode('device')} /><span>“Workspace on {ask.device}”</span></label>
        <label style={{ display: 'flex', gap: 6 }}><input type="radio" name="ws-label" checked={labelMode === 'folder'} onChange={() => setLabelMode('folder')} /><span>The folder&apos;s name{folder ? `: “${folderName(folder)}”` : ''}</span></label>
        {error && <p role="alert" style={{ color: 'var(--danger, #e5484d)', margin: '8px 0 0' }}>{error}</p>}
        <ul style={{ margin: '12px 0', paddingLeft: 18, color: 'var(--text-muted)' }}>
          <li>The folder&apos;s location stays on this computer: the run is told only the name above.</li>
          <li>Risky actions (deleting, installing, leaving the folder, sending things out) ask here again. Files marked local-only in the folder&apos;s Cascade settings are never read for it.</li>
          <li>A checkpoint is taken before its first change, so you can undo the run afterwards. Stop ends its access at once.</li>
        </ul>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btn(false)} onClick={() => void reply(false)}>Say no</button>
          <button type="submit" style={btn(true)}>Allow this folder</button>
        </div>
      </form>
    </div>
  );
}
