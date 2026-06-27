import { useState, useEffect, useRef, type MouseEvent } from 'react';
import { type OnMount } from '@monaco-editor/react';
import { Code2, FileCode, FolderOpen, Search, X } from 'lucide-react';
import { FileTree } from '../components/FileTree.js';
import { MonacoEditor } from '../components/MonacoEditor.js';
import { HelpButton } from '../help/HelpButton.js';
import { useAppSelector, useAppDispatch, setWorkspacePath } from '../store/index.js';

interface OpenFile { path: string; content: string; saved: string; language: string }
interface SearchHit { file: string; line: number; text: string }

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go',
    html: 'html', css: 'css', scss: 'scss', sh: 'shell', yaml: 'yaml', yml: 'yaml',
    java: 'java', c: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', rb: 'ruby',
    sql: 'sql', xml: 'xml', toml: 'ini', ini: 'ini',
  };
  return map[ext] ?? 'plaintext';
}
const baseName = (p: string) => p.split(/[/\\]/).pop() ?? p;

export function CodeView() {
  const workspacePath = useAppSelector((s) => s.app.workspacePath);
  const dispatch = useAppDispatch();
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [reloadToken, setReloadToken] = useState(0);
  const [mode, setMode] = useState<'files' | 'search'>('files');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const active = activeIdx >= 0 ? openFiles[activeIdx] : null;

  const openFile = async (filePath: string): Promise<void> => {
    if (!window.cascade) return;
    const existing = openFiles.findIndex((f) => f.path === filePath);
    if (existing >= 0) { setActiveIdx(existing); return; }
    try {
      const content = await window.cascade.fs.readFile(filePath);
      const file: OpenFile = { path: filePath, content, saved: content, language: detectLanguage(baseName(filePath)) };
      setOpenFiles((prev) => { setActiveIdx(prev.length); return [...prev, file]; });
    } catch { /* unreadable — ignore */ }
  };

  const closeTab = (idx: number, e?: MouseEvent) => {
    e?.stopPropagation();
    setOpenFiles((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      setActiveIdx((cur) => (next.length === 0 ? -1 : Math.min(cur > idx ? cur - 1 : cur, next.length - 1)));
      return next;
    });
  };

  const onChange = (v: string | undefined) => {
    setOpenFiles((prev) => prev.map((f, i) => (i === activeIdx ? { ...f, content: v ?? '' } : f)));
  };

  const saveActive = async () => {
    const f = openFiles[activeIdx];
    if (!f || !window.cascade || f.content === f.saved) return;
    await window.cascade.fs.writeFile(f.path, f.content);
    setOpenFiles((prev) => prev.map((x, i) => (i === activeIdx ? { ...x, saved: x.content } : x)));
  };

  // Ctrl/Cmd+S saves the active file. Rebinds so the closure sees latest state.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveActive(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFiles, activeIdx]);

  const openFolder = async () => {
    const dir = await window.cascade?.selectDirectory();
    if (dir) { dispatch(setWorkspacePath(dir)); setReloadToken((t) => t + 1); setMode('files'); }
  };

  const runSearch = async () => {
    if (!window.cascade || !workspacePath || !query.trim()) { setResults([]); return; }
    setSearching(true);
    try { setResults(await window.cascade.fs.search(workspacePath, query.trim())); }
    finally { setSearching(false); }
  };

  const openHit = async (hit: SearchHit) => {
    await openFile(hit.file);
    setTimeout(() => {
      const ed = editorRef.current;
      if (ed) { ed.revealLineInCenter(hit.line); ed.setPosition({ lineNumber: hit.line, column: 1 }); ed.focus(); }
    }, 140);
  };

  const iconBtn = (Icon: typeof Search, title: string, onClick: () => void, on = false) => (
    <button title={title} onClick={onClick} style={{
      width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: on ? 'var(--accent-soft)' : 'transparent', color: on ? 'var(--accent)' : 'var(--text-muted)',
      border: '1px solid ' + (on ? 'var(--accent)' : 'transparent'), borderRadius: 5, cursor: 'pointer',
    }}>
      <Icon size={14} />
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Code2 size={15} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '-0.2px' }}>Code</span>
        {active && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', padding: '2px 8px', background: 'var(--bg-raised)', borderRadius: 5, border: '1px solid var(--border)' }}>
            {active.path.replace(workspacePath, '').replace(/^[/\\]/, '')}{active.content !== active.saved ? ' •' : ''}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <HelpButton context="code" />
      </div>

      {/* Split: explorer/search + editor */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ width: 240, borderRight: '1px solid var(--border)', overflow: 'hidden', flexShrink: 0, background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '6px 8px 6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', flex: 1 }}>
              {mode === 'search' ? 'Search' : 'Explorer'}
            </span>
            {iconBtn(Search, 'Search across files', () => setMode((m) => (m === 'search' ? 'files' : 'search')), mode === 'search')}
            {iconBtn(FolderOpen, 'Open folder', openFolder)}
          </div>

          {mode === 'search' ? (
            <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 1 }}>
              <div style={{ padding: '4px 10px 8px' }}>
                <input
                  value={query} autoFocus
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                  placeholder={workspacePath ? 'Search…  (Enter)' : 'Open a folder first'}
                  disabled={!workspacePath}
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 9px', fontSize: 12, outline: 'none' }}
                />
              </div>
              <div style={{ overflow: 'auto', flex: 1 }}>
                {searching && <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>Searching…</div>}
                {!searching && results.length === 0 && query && <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>No matches.</div>}
                {results.map((hit, i) => (
                  <div key={i} onClick={() => openHit(hit)}
                    style={{ padding: '5px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                    <div style={{ fontSize: 11, color: 'var(--accent)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{baseName(hit.file)}</span>
                      <span style={{ color: 'var(--text-dim)', flexShrink: 0 }}>:{hit.line}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hit.text}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : workspacePath ? (
            <div style={{ overflow: 'auto', flex: 1 }}>
              <FileTree root={workspacePath} onFileClick={openFile} reloadToken={reloadToken} onChanged={() => setReloadToken((t) => t + 1)} />
            </div>
          ) : (
            <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
              No folder open. Click the <FolderOpen size={12} style={{ verticalAlign: 'middle' }} /> icon to open one, or run Cascade with a project.
            </div>
          )}
        </div>

        {/* Editor side */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {openFiles.length > 0 && (
            <div style={{ display: 'flex', height: 34, borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)', overflowX: 'auto', flexShrink: 0 }}>
              {openFiles.map((f, i) => {
                const on = i === activeIdx;
                return (
                  <div key={f.path} onClick={() => setActiveIdx(i)}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
                      background: on ? 'var(--bg-base)' : 'transparent', color: on ? 'var(--text)' : 'var(--text-muted)',
                      borderRight: '1px solid var(--border)', borderTop: on ? '2px solid var(--accent)' : '2px solid transparent' }}>
                    <FileCode size={12} style={{ color: on ? 'var(--accent)' : 'var(--text-dim)' }} />
                    {baseName(f.path)}
                    {f.content !== f.saved && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--warn)' }} />}
                    <span onClick={(e) => closeTab(i, e)} style={{ display: 'flex', borderRadius: 3, padding: 1 }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-active)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                      <X size={12} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            {active ? (
              <MonacoEditor
                path={active.path}
                value={active.content}
                language={active.language}
                onMount={(editor) => { editorRef.current = editor; }}
                onChange={onChange}
              />
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', flexDirection: 'column', gap: 14, animation: 'fadeIn 0.3s var(--ease)' }}>
                <div style={{ width: 56, height: 56, borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-raised)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}>
                  <FileCode size={26} />
                </div>
                <span style={{ fontSize: 13 }}>Select a file from the explorer to open it.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
