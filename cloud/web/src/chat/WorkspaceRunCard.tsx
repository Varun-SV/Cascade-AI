import { useState } from 'react';
import { FolderOpen, FileText, ChevronRight, Loader2, Info, ShieldQuestion } from 'lucide-react';
import {
  changedSinceReadFiles, collectChangedFiles, editDiff,
  type ChangeOp, type ChangedFile, type WorkspaceRunView,
} from '../lib/workspaceRun.js';

interface Props {
  view: WorkspaceRunView | undefined;
  /** The computer has been asked to allow this run and has not answered yet. */
  awaitingConsent: boolean;
  awaitingDeviceName: string;
}

const note = 'flex items-center gap-2 text-[12.5px] text-ink-300';

/**
 * A run that works in a folder on the user's own computer: where it works, what it is waiting
 * for, and which files it changed. Shows the label the user gave the folder and the computer's
 * name, never a path.
 */
export default function WorkspaceRunCard({ view, awaitingConsent, awaitingDeviceName }: Props) {
  const changed = collectChangedFiles(view);
  if (!view && !awaitingConsent) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="workspace-run">
      {awaitingConsent && (
        <div role="status" className={note}>
          <Loader2 size={14} className="shrink-0 animate-spin text-ink-500" />
          <span>Waiting for {awaitingDeviceName} to allow this run…</span>
        </div>
      )}
      {view && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="cz-chip min-w-0 max-w-full" aria-pressed={view.status === 'attached'} title={view.status === 'ended' ? (view.endedReason ?? 'Ended') : undefined}>
              <FolderOpen size={14} className="shrink-0" />
              <span className="min-w-0 truncate">
                {view.status === 'attached' ? 'Working in' : 'Worked in'} <b className="font-medium">{view.label}</b> on {view.device.name}
              </span>
              {view.status === 'ended' && <span className="shrink-0 text-ink-500">· ended</span>}
            </span>
          </div>
          {view.waitingTool !== undefined && (
            <div role="status" className={note}>
              <ShieldQuestion size={14} className="shrink-0 text-warning-500" />
              <span>Waiting for your approval on {view.device.name} ({view.waitingTool})</span>
            </div>
          )}
          {view.notes.length > 0 && (
            <div className={note}>
              <Info size={14} className="shrink-0 text-ink-500" />
              <span className="min-w-0 break-words">
                {(() => {
                  const names = [...new Set(view.notes.flatMap(changedSinceReadFiles))];
                  return names.length > 0
                    ? `Files changed on your computer since the run read them: ${names.join(', ')}`
                    : 'Files in the workspace changed since the run read them.';
                })()}
              </span>
            </div>
          )}
        </>
      )}
      {changed.length > 0 && <ChangedFiles files={changed} />}
    </div>
  );
}

function ChangedFiles({ files }: { files: ChangedFile[] }) {
  return (
    <section aria-label="Files changed in your workspace" className="rounded-xl bg-sunk/60 p-2.5" style={{ boxShadow: 'inset 0 0 0 1px rgb(var(--c-elev) / 0.1)' }}>
      <h3 className="m-0 mb-1.5 text-[12.5px] font-medium text-ink-300">Files changed in your workspace</h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {files.map((f) => <FileRow key={f.path} file={f} />)}
      </ul>
    </section>
  );
}

function summary(ops: ChangeOp[]): string {
  const last = ops[ops.length - 1]!;
  if (last.kind === 'delete') return 'deleted';
  if (ops.some((o) => o.kind === 'write') && !ops.some((o) => o.kind === 'edit')) return ops.length > 1 ? `written ${ops.length} times` : 'written';
  return ops.length > 1 ? `edited ${ops.length} times` : 'edited';
}

function FileRow({ file }: { file: ChangedFile }) {
  const [open, setOpen] = useState(false);
  const detail = file.ops.some((o) => o.kind !== 'delete');
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => detail && setOpen((o) => !o)}
        aria-expanded={detail ? open : undefined}
        disabled={!detail}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[13px] text-ink-100 enabled:hover:bg-elev/[0.05] disabled:cursor-default"
      >
        {detail ? <ChevronRight size={13} className={`shrink-0 text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`} /> : <FileText size={13} className="shrink-0 text-ink-500" />}
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={file.path}>{file.path}</span>
        <span className="shrink-0 text-[12px] text-ink-500">{summary(file.ops)}</span>
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1.5 pl-5">
          {file.ops.map((o) => <OpView key={o.id} op={o} />)}
        </div>
      )}
    </li>
  );
}

function OpView({ op }: { op: ChangeOp }) {
  if (op.kind === 'delete') return <p className="m-0 text-[12.5px] text-ink-500">deleted</p>;
  if (op.kind === 'edit') {
    if (op.oldString === undefined || op.newString === undefined) return <p className="m-0 text-[12.5px] text-ink-500">edited</p>;
    return (
      <>
        <pre aria-label="Changes" className="m-0 max-h-[260px] overflow-auto rounded-lg bg-card p-2 font-mono text-[12px] leading-[1.5]">
          {editDiff(op.oldString, op.newString).map((l, i) => (
            <div
              key={i}
              data-diff={l.kind}
              className={l.kind === 'del' ? 'bg-danger-500/15 text-danger-500' : l.kind === 'add' ? 'bg-success-500/15 text-success-500' : 'text-ink-500'}
            >
              <span aria-hidden="true" className="select-none">{l.kind === 'del' ? '- ' : l.kind === 'add' ? '+ ' : '  '}</span>
              {l.text || ' '}
            </div>
          ))}
        </pre>
        {op.truncated && <p className="m-0 text-[12px] text-ink-500">Long change, shown cut short.</p>}
      </>
    );
  }
  return (
    <details className="group">
      <summary className="cursor-pointer text-[12.5px] text-ink-500 hover:text-ink-300">New content</summary>
      <pre className="m-0 mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-card p-2 font-mono text-[12px] leading-[1.5] text-ink-100">{op.content ?? ''}</pre>
      {op.truncated && <p className="m-0 text-[12px] text-ink-500">Long file, shown cut short.</p>}
    </details>
  );
}
