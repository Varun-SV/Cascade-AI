import { useState } from 'react';
import { Code2, FileCode } from 'lucide-react';
import { FileTree } from '../components/FileTree.js';
import { MonacoEditor } from '../components/MonacoEditor.js';
import { HelpButton } from '../help/HelpButton.js';
import { useAppSelector } from '../store/index.js';

interface OpenFile { path: string; content: string; language: string }

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go',
    html: 'html', css: 'css', sh: 'shell', yaml: 'yaml', yml: 'yaml',
  };
  return map[ext] ?? 'plaintext';
}

export function CodeView() {
  const workspacePath = useAppSelector((s) => s.app.workspacePath);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);

  const handleFileOpen = async (filePath: string) => {
    if (!window.cascade) return;
    try {
      const content = await window.cascade.fs.readFile(filePath);
      const filename = filePath.split(/[/\\]/).pop() ?? filePath;
      setOpenFile({ path: filePath, content, language: detectLanguage(filename) });
    } catch {
      // File unreadable — ignore
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '11px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <Code2 size={15} style={{ color: 'var(--accent)' }} />
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '-0.2px' }}>Code</span>
        {openFile && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', padding: '2px 8px', background: 'var(--bg-raised)', borderRadius: 5, border: '1px solid var(--border)' }}>
            {openFile.path.replace(workspacePath, '').replace(/^[/\\]/, '')}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <HelpButton context="code" />
      </div>

      {/* Split: file tree + editor */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ width: 230, borderRight: '1px solid var(--border)', overflow: 'auto', flexShrink: 0, background: 'var(--bg-surface)' }}>
          <div style={{ padding: '8px 12px', fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)' }}>Explorer</div>
          {workspacePath ? (
            <FileTree root={workspacePath} onFileClick={handleFileOpen} />
          ) : (
            <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
              No workspace open. Run Cascade with a project to browse files.
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {openFile ? (
            <MonacoEditor
              path={openFile.path}
              value={openFile.content}
              language={openFile.language}
              onChange={(v) => setOpenFile((f) => f ? { ...f, content: v ?? '' } : f)}
            />
          ) : (
            <div style={{
              height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-muted)', flexDirection: 'column', gap: 14,
              animation: 'fadeIn 0.3s var(--ease)',
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: 'var(--radius-lg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--bg-raised)', border: '1px solid var(--border)', color: 'var(--text-dim)',
              }}>
                <FileCode size={26} />
              </div>
              <span style={{ fontSize: 13 }}>Select a file from the explorer to open it.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
