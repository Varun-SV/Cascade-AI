import { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from 'lucide-react';

interface FsEntry { name: string; fullPath: string; isDirectory: boolean }
interface Props { root: string; onFileClick: (path: string) => void }

function TreeNode({ entry, onFileClick, depth }: { entry: FsEntry; onFileClick: (p: string) => void; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[]>([]);

  const toggle = async () => {
    if (!entry.isDirectory) { onFileClick(entry.fullPath); return; }
    if (!expanded && children.length === 0 && window.cascade) {
      const entries = await window.cascade.fs.readDir(entry.fullPath);
      setChildren(entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      }));
    }
    setExpanded((v) => !v);
  };

  const Icon = entry.isDirectory ? (expanded ? FolderOpen : Folder) : File;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div>
      <div
        onClick={toggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: `2px 8px 2px ${8 + depth * 12}px`,
          cursor: 'pointer', fontSize: 12, color: 'var(--text)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        {entry.isDirectory
          ? <Chevron size={10} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          : <span style={{ width: 10, flexShrink: 0 }} />}
        <Icon size={12} style={{ flexShrink: 0, color: entry.isDirectory ? '#f5a623' : 'var(--text-muted)' }} />
        <span>{entry.name}</span>
      </div>
      {expanded && children.map((child) => (
        <TreeNode key={child.fullPath} entry={child} onFileClick={onFileClick} depth={depth + 1} />
      ))}
    </div>
  );
}

export function FileTree({ root, onFileClick }: Props) {
  const [entries, setEntries] = useState<FsEntry[]>([]);

  useEffect(() => {
    if (!window.cascade || !root) return;
    window.cascade.fs.readDir(root).then((e) => {
      setEntries(e.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      }));
    });
  }, [root]);

  return (
    <div style={{ paddingTop: 4 }}>
      {entries.map((entry) => (
        <TreeNode key={entry.fullPath} entry={entry} onFileClick={onFileClick} depth={0} />
      ))}
    </div>
  );
}
