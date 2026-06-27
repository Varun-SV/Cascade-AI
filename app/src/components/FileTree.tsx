import { useState, useEffect, type MouseEvent } from 'react';
import {
  ChevronRight, ChevronDown, File, Folder, FolderOpen,
  FilePlus, FolderPlus, Pencil, Trash2,
} from 'lucide-react';

interface FsEntry { name: string; fullPath: string; isDirectory: boolean }
interface Props {
  root: string;
  onFileClick: (path: string) => void;
  reloadToken: number;
  onChanged: () => void;
}
interface MenuState { x: number; y: number; entry: FsEntry }

const sepOf = (p: string) => (p.includes('\\') ? '\\' : '/');
const dirnameOf = (p: string) => p.replace(/[/\\][^/\\]*$/, '') || p;
const joinPath = (dir: string, name: string) => `${dir}${sepOf(dir)}${name}`;

function sortEntries(e: FsEntry[]): FsEntry[] {
  return [...e].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function TreeNode({ entry, onFileClick, onContext, depth, reloadToken }: {
  entry: FsEntry; onFileClick: (p: string) => void;
  onContext: (e: MouseEvent, entry: FsEntry) => void;
  depth: number; reloadToken: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadChildren = async () => {
    if (!window.cascade) return;
    const entries = await window.cascade.fs.readDir(entry.fullPath);
    setChildren(sortEntries(entries));
    setLoaded(true);
  };

  // Re-read an open directory when the tree is told something changed.
  useEffect(() => {
    if (entry.isDirectory && expanded) loadChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  const toggle = async () => {
    if (!entry.isDirectory) { onFileClick(entry.fullPath); return; }
    if (!expanded && !loaded) await loadChildren();
    setExpanded((v) => !v);
  };

  const Icon = entry.isDirectory ? (expanded ? FolderOpen : Folder) : File;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div>
      <div
        onClick={toggle}
        onContextMenu={(e) => onContext(e, entry)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: `3px 8px 3px ${8 + depth * 12}px`,
          cursor: 'pointer', fontSize: 12, color: 'var(--text)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          borderRadius: 4, transition: 'background var(--dur)',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        {entry.isDirectory
          ? <Chevron size={10} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          : <span style={{ width: 10, flexShrink: 0 }} />}
        <Icon size={12} style={{ flexShrink: 0, color: entry.isDirectory ? 'var(--warn)' : 'var(--text-muted)' }} />
        <span>{entry.name}</span>
      </div>
      {expanded && children.map((child) => (
        <TreeNode key={child.fullPath} entry={child} onFileClick={onFileClick}
          onContext={onContext} depth={depth + 1} reloadToken={reloadToken} />
      ))}
    </div>
  );
}

export function FileTree({ root, onFileClick, reloadToken, onChanged }: Props) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    if (!window.cascade || !root) return;
    window.cascade.fs.readDir(root).then((e) => setEntries(sortEntries(e)));
  }, [root, reloadToken]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const openContext = (e: MouseEvent, entry: FsEntry) => {
    e.preventDefault(); e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const targetDir = (entry: FsEntry) => (entry.isDirectory ? entry.fullPath : dirnameOf(entry.fullPath));

  const act = {
    newFile: async (entry: FsEntry) => {
      const name = window.prompt('New file name'); if (!name) return;
      await window.cascade!.fs.createFile(joinPath(targetDir(entry), name));
      onChanged();
    },
    newFolder: async (entry: FsEntry) => {
      const name = window.prompt('New folder name'); if (!name) return;
      await window.cascade!.fs.mkdir(joinPath(targetDir(entry), name));
      onChanged();
    },
    rename: async (entry: FsEntry) => {
      const name = window.prompt('Rename to', entry.name); if (!name || name === entry.name) return;
      await window.cascade!.fs.rename(entry.fullPath, joinPath(dirnameOf(entry.fullPath), name));
      onChanged();
    },
    del: async (entry: FsEntry) => {
      if (!window.confirm(`Move "${entry.name}" to trash?`)) return;
      await window.cascade!.fs.delete(entry.fullPath);
      onChanged();
    },
  };

  const menuItem = (Icon: typeof FilePlus, label: string, onClick: () => void) => (
    <div
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer', color: 'var(--text)', whiteSpace: 'nowrap' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <Icon size={13} style={{ color: 'var(--text-muted)' }} /> {label}
    </div>
  );

  return (
    <div style={{ paddingTop: 4 }}>
      {entries.map((entry) => (
        <TreeNode key={entry.fullPath} entry={entry} onFileClick={onFileClick}
          onContext={openContext} depth={0} reloadToken={reloadToken} />
      ))}

      {menu && (
        <div style={{
          position: 'fixed', top: menu.y, left: menu.x, zIndex: 1000,
          background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)',
          borderRadius: 8, boxShadow: 'var(--shadow-2)', padding: '4px 0', minWidth: 160,
        }}>
          {menu.entry.isDirectory && menuItem(FilePlus, 'New File', () => act.newFile(menu.entry))}
          {menu.entry.isDirectory && menuItem(FolderPlus, 'New Folder', () => act.newFolder(menu.entry))}
          {!menu.entry.isDirectory && menuItem(FilePlus, 'New File here', () => act.newFile(menu.entry))}
          {menuItem(Pencil, 'Rename', () => act.rename(menu.entry))}
          {menuItem(Trash2, 'Delete', () => act.del(menu.entry))}
        </div>
      )}
    </div>
  );
}
