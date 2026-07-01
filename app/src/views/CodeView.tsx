import { useState, useEffect, useRef, type MouseEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { type OnMount } from '@monaco-editor/react';
import { Code2, FileCode, FolderOpen, Search, X, MessageSquare } from 'lucide-react';
import { FileTree } from '../components/FileTree.js';
import { MonacoEditor } from '../components/MonacoEditor.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { HelpButton } from '../help/HelpButton.js';
import { useAppSelector, useAppDispatch, setWorkspacePath, toggleCodeChat } from '../store/index.js';

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

export function CodeView({ socket }: { socket: Socket | null }) {
  const workspacePath = useAppSelector((s) => s.app.workspacePath);
  const codeChatVisible = useAppSelector((s) => s.app.codeChatVisible);
  const dispatch = useAppDispatch();
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [reloadToken, setReloadToken] = useState(0);
  const [mode, setMode] = useState<'files' | 'search'>('files');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const [chatWidth, setChatWidth] = useState(320);
  const [resizingChat, setResizingChat] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('cascade.recentFolders') ?? '[]') as string[]; } catch { return []; }
  });

  // Drag-resize the docked chat panel from its left edge, clamped to a sane
  // width range. Measured against the split container's own rect (not the
  // window) so it's correct regardless of other chrome to its left.
  useEffect(() => {
    if (!resizingChat) return;
    const onMove = (e: globalThis.MouseEvent) => {
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect) return;
      setChatWidth(Math.min(560, Math.max(240, rect.right - e.clientX)));
    };
    const onUp = () => setResizingChat(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [resizingChat]);

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

  const pushRecent = (p: string) => setRecent((prev) => {
    const next = [p, ...prev.filter((x) => x !== p)].slice(0, 6);
    try { localStorage.setItem('cascade.recentFolders', JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  const openWorkspace = (dir: string) => {
    dispatch(setWorkspacePath(dir)); setReloadToken((t) => t + 1); setMode('files'); pushRecent(dir);
  };
  const openFolder = async () => {
    const dir = await window.cascade?.selectDirectory();
    if (dir) openWorkspace(dir);
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
        {iconBtn(MessageSquare, 'Toggle chat panel', () => dispatch(toggleCodeChat()), codeChatVisible)}
        <HelpButton context="code" />
      </div>

      {/* Split: explorer/search + editor + chat */}
      <div ref={splitRef} style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
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
            ) : !workspacePath ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', padding: 24, animation: 'fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)' }}>
                <div style={{ 
                  width: '100%', maxWidth: 420, padding: 32,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16,
                  background: 'linear-gradient(145deg, rgba(var(--accent-rgb), 0.03), rgba(var(--accent-rgb), 0.08))',
                  border: '2px dashed rgba(var(--accent-rgb), 0.3)', borderRadius: 'var(--radius-lg)',
                  boxShadow: '0 8px 32px rgba(var(--accent-rgb), 0.05), inset 0 0 0 1px rgba(255,255,255,0.05)',
                  backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
                  transition: 'all 0.3s ease', cursor: 'pointer'
                }} onClick={openFolder}
                onMouseEnter={(e) => { 
                  (e.currentTarget as HTMLElement).style.borderColor = 'rgba(var(--accent-rgb), 0.7)';
                  (e.currentTarget as HTMLElement).style.background = 'linear-gradient(145deg, rgba(var(--accent-rgb), 0.05), rgba(var(--accent-rgb), 0.12))';
                  (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => { 
                  (e.currentTarget as HTMLElement).style.borderColor = 'rgba(var(--accent-rgb), 0.3)';
                  (e.currentTarget as HTMLElement).style.background = 'linear-gradient(145deg, rgba(var(--accent-rgb), 0.03), rgba(var(--accent-rgb), 0.08))';
                  (e.currentTarget as HTMLElement).style.transform = 'none';
                }}>
                  <div style={{ width: 72, height: 72, borderRadius: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', color: '#fff', boxShadow: '0 12px 24px rgba(var(--accent-rgb), 0.3), inset 0 2px 4px rgba(255,255,255,0.2)', marginBottom: 8 }}>
                    <FolderOpen size={34} style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))' }} />
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 8, letterSpacing: '-0.3px' }}>Open a folder to start coding</div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 340, lineHeight: 1.5, margin: '0 auto' }}>Select a project directory to explore its contents, edit files, and run tasks in the workspace.</div>
                  </div>
                  <button style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: 'var(--bg-surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.04)', transition: 'all 0.2s ease' }}
                    onClick={(e) => { e.stopPropagation(); openFolder(); }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLElement).style.color = 'var(--accent)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}>
                    <FolderOpen size={15} /> Browse Files
                  </button>
                </div>
                {recent.length > 0 && (
                  <div style={{ marginTop: 8, width: '100%', maxWidth: 360 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 8, textAlign: 'center' }}>Recent</div>
                    {recent.map((p) => (
                      <div key={p} onClick={() => openWorkspace(p)} title={p}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', border: '1px solid var(--border)', marginBottom: 6, background: 'var(--bg-surface)' }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-surface)'; }}>
                        <FolderOpen size={13} style={{ color: 'var(--warn)', flexShrink: 0 }} />
                        <span style={{ flexShrink: 0 }}>{baseName(p)}</span>
                        <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{p}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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

        {codeChatVisible && (
          <>
            <div
              onMouseDown={() => setResizingChat(true)}
              title="Drag to resize"
              style={{ width: 4, flexShrink: 0, cursor: 'col-resize', background: resizingChat ? 'var(--accent)' : 'transparent' }}
            />
            <div style={{ width: chatWidth, flexShrink: 0, borderLeft: '1px solid var(--border)', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)' }}>
              <div style={{ padding: '6px 8px 6px 12px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', flex: 1 }}>Chat</span>
              </div>
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <ChatPanel socket={socket} compact />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
