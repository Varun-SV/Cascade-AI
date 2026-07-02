import { useState, useEffect, type MouseEvent } from 'react';
import {
  ChevronRight, ChevronDown, File, Folder, FolderOpen,
  FilePlus, FolderPlus, Pencil, Trash2, Terminal,
} from 'lucide-react';
import { PromptDialog } from './PromptDialog.js';
import { useAppDispatch, openTerminalAt } from '../store/index.js';

interface FsEntry { name: string; fullPath: string; isDirectory: boolean }
interface Props {
  root: string;
  onFileClick: (path: string) => void;
  reloadToken: number;
  onChanged: () => void;
}
// entry === null means the menu targets the workspace root (right-click on
// empty explorer space — previously that showed nothing at all).
interface MenuState { x: number; y: number; entry: FsEntry | null }
interface DialogState {
  title: string;
  defaultValue?: string;
  confirmOnly?: boolean;
  confirmLabel?: string;
  action: (value: string) => Promise<void>;
}

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
  const dispatch = useAppDispatch();
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

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

  const openContext = (e: MouseEvent, entry: FsEntry | null) => {
    e.preventDefault(); e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // Directory an action applies to: the entry's own folder for directories,
  // the containing folder for files, the workspace root for empty space.
  const targetDir = (entry: FsEntry | null) =>
    entry === null ? root : entry.isDirectory ? entry.fullPath : dirnameOf(entry.fullPath);

  // window.prompt()/confirm() are not supported in Electron (prompt silently
  // no-ops), so all inputs go through the in-app PromptDialog instead.
  const act = {
    newFile: (entry: FsEntry | null) => setDialog({
      title: 'New file name',
      action: async (name) => { await window.cascade!.fs.createFile(joinPath(targetDir(entry), name)); onChanged(); },
    }),
    newFolder: (entry: FsEntry | null) => setDialog({
      title: 'New folder name',
      action: async (name) => { await window.cascade!.fs.mkdir(joinPath(targetDir(entry), name)); onChanged(); },
    }),
    rename: (entry: FsEntry) => setDialog({
      title: `Rename "${entry.name}"`, defaultValue: entry.name,
      action: async (name) => {
        if (name === entry.name) return;
        await window.cascade!.fs.rename(entry.fullPath, joinPath(dirnameOf(entry.fullPath), name));
        onChanged();
      },
    }),
    del: (entry: FsEntry) => setDialog({
      title: `Move "${entry.name}" to trash?`, confirmOnly: true, confirmLabel: 'Delete',
      action: async () => { await window.cascade!.fs.delete(entry.fullPath); onChanged(); },
    }),
    terminalHere: (entry: FsEntry | null) => { dispatch(openTerminalAt(targetDir(entry))); },
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
    <div
      style={{ paddingTop: 4, minHeight: '100%' }}
      onContextMenu={(e) => openContext(e, null)}
    >
      {entries.map((entry) => (
        <TreeNode key={entry.fullPath} entry={entry} onFileClick={onFileClick}
          onContext={openContext} depth={0} reloadToken={reloadToken} />
      ))}

      {menu && (
        <div style={{
          position: 'fixed', top: menu.y, left: menu.x, zIndex: 1000,
          background: 'var(--bg-overlay)', border: '1px solid var(--border-strong)',
          borderRadius: 8, boxShadow: 'var(--shadow-2)', padding: '4px 0', minWidth: 170,
        }}>
          {menuItem(FilePlus, menu.entry && !menu.entry.isDirectory ? 'New File here' : 'New File', () => act.newFile(menu.entry))}
          {menuItem(FolderPlus, 'New Folder', () => act.newFolder(menu.entry))}
          {menuItem(Terminal, 'Open Terminal Here', () => act.terminalHere(menu.entry))}
          {menu.entry && menuItem(Pencil, 'Rename', () => act.rename(menu.entry!))}
          {menu.entry && menuItem(Trash2, 'Delete', () => act.del(menu.entry!))}
        </div>
      )}

      {dialog && (
        <PromptDialog
          title={dialog.title}
          defaultValue={dialog.defaultValue}
          confirmOnly={dialog.confirmOnly}
          confirmLabel={dialog.confirmLabel}
          onSubmit={async (value) => { setDialog(null); try { await dialog.action(value); } catch { /* fs op failed — tree unchanged */ } }}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
