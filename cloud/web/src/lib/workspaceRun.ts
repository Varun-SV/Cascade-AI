// A run that works in a folder on the user's own computer: what the web app keeps of it,
// and how the server's `workspace:*` events change that. Pure, so it is tested without a socket.
//
// Nothing here is logged, and no filesystem path ever appears: the server sends a label the
// user chose on their computer, the computer's name, and the paths the run itself used
// (relative to the folder).

export interface WorkspaceDevice { id: string; name: string; online: boolean }

/** The picker's one default: today's behaviour, no files. */
export const CLOUD_ENV = 'cloud';

export const OFFLINE_HINT = 'Open the Cascade desktop app on it and turn workspace serving on';
export const NO_DEVICES_HINT = 'Pair the Cascade desktop app (Settings → Cloud runs in the desktop app) to let runs work in a folder on your computer.';

export interface PickerOption {
  /** CLOUD_ENV, or a device id. */
  value: string;
  label: string;
  sub?: string;
  online?: boolean;
  disabled: boolean;
}

/** The environment picker's rows: Cloud first, then one per desktop, offline ones disabled. */
export function pickerOptions(devices: readonly WorkspaceDevice[], selected: string | undefined): PickerOption[] {
  return [
    { value: CLOUD_ENV, label: 'Cloud (no files)', sub: 'Runs here with no access to your files', disabled: false },
    ...devices.map<PickerOption>((d) => ({
      value: d.id, label: d.name, online: d.online,
      sub: d.online ? 'Work in a folder on this computer' : OFFLINE_HINT,
      // A device already chosen stays selectable so the user can see and undo the choice.
      disabled: !d.online && d.id !== selected,
    })),
  ];
}

/** The chosen device's name for a chip, or null for Cloud. An unknown id reads as a device that is gone. */
export function chosenDeviceName(devices: readonly WorkspaceDevice[], selected: string | undefined): string | null {
  if (!selected) return null;
  return devices.find((d) => d.id === selected)?.name ?? 'Unknown computer';
}

/** `workspaceDeviceId` for a run's payload: only a real choice is sent. */
export function workspaceDeviceForRun(selected: string | undefined): string | undefined {
  return selected && selected !== CLOUD_ENV ? selected : undefined;
}

// ── a run's view ────────────────────────────────────────────────────────

export type ChangeKind = 'write' | 'edit' | 'delete';

export interface ChangeOp {
  id: string;
  kind: ChangeKind;
  content?: string;
  oldString?: string;
  newString?: string;
  /** The server cut the text it sent. */
  truncated?: boolean;
  /** The computer refused or the tool failed, so nothing changed. */
  failed?: boolean;
}

export interface ChangedFile { path: string; ops: ChangeOp[] }

export interface WorkspaceRunView {
  runId: string;
  label: string;
  device: { id: string; name: string };
  status: 'attached' | 'ended';
  endedReason?: string;
  /** A tool call is waiting for the user's answer on their computer. */
  waitingTool?: string;
  changes: ChangedFile[];
  /** "[Files in the workspace changed since you read them: …]" lines, newest last. */
  notes: string[];
}

export type WorkspaceEvent =
  | { type: 'attached'; runId: string; label: string; device: { id: string; name: string } }
  | { type: 'waiting'; runId: string; tool: string }
  | { type: 'detached'; runId: string; reason?: string }
  | { type: 'call'; runId: string; id: string; tool: string; change: { kind: ChangeKind; path: string; content?: string; oldString?: string; newString?: string; truncated?: boolean } }
  | { type: 'result'; runId: string; id: string; tool: string; ok: boolean; note?: string };

const MAX_FILES = 200;
const MAX_OPS_PER_FILE = 20;
const MAX_NOTES = 5;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Reads a socket payload into an event, or null if it is not one. The server is trusted for
 * what it means, not for its shape: a malformed event is dropped.
 */
export function parseWorkspaceEvent(type: WorkspaceEvent['type'], raw: unknown): { conversationId?: string; event: WorkspaceEvent } | null {
  if (!isObj(raw)) return null;
  const runId = str(raw['runId'], 100);
  if (!runId) return null;
  const conversationId = str(raw['conversationId'], 100);
  const base = conversationId ? { conversationId } : {};
  if (type === 'attached') {
    const label = str(raw['label'], 120);
    const d = raw['device'];
    const id = isObj(d) ? str(d['id'], 100) : undefined;
    const name = isObj(d) ? str(d['name'], 120) : undefined;
    if (!label || !id || !name) return null;
    return { ...base, event: { type, runId, label, device: { id, name } } };
  }
  if (type === 'waiting') {
    const tool = str(raw['tool'], 60);
    return tool ? { ...base, event: { type, runId, tool } } : null;
  }
  if (type === 'detached') {
    const reason = str(raw['reason'], 300);
    return { ...base, event: { type, runId, ...(reason ? { reason } : {}) } };
  }
  if (type === 'call') {
    const id = str(raw['id'], 100);
    const tool = str(raw['tool'], 60);
    const c = raw['change'];
    if (!id || !tool || !isObj(c)) return null;
    const kind = c['kind'];
    const path = str(c['path'], 1024);
    if ((kind !== 'write' && kind !== 'edit' && kind !== 'delete') || !path) return null;
    const content = str(c['content'], 20_000);
    const oldString = str(c['oldString'], 20_000);
    const newString = str(c['newString'], 20_000);
    return {
      ...base,
      event: {
        type, runId, id, tool,
        change: {
          kind, path,
          ...(content !== undefined ? { content } : {}),
          ...(oldString !== undefined ? { oldString } : {}),
          ...(newString !== undefined ? { newString } : {}),
          ...(c['truncated'] === true ? { truncated: true } : {}),
        },
      },
    };
  }
  const id = str(raw['id'], 100);
  const tool = str(raw['tool'], 60);
  if (!id || !tool) return null;
  const note = str(raw['note'], 1600);
  return { ...base, event: { type: 'result', runId, id, tool, ok: raw['ok'] !== false, ...(note ? { note } : {}) } };
}

/**
 * One event applied to a conversation's workspace view. A new `attached` starts a new view
 * (a new run); anything else about another run than the one held is ignored.
 */
export function applyWorkspaceEvent(view: WorkspaceRunView | undefined, e: WorkspaceEvent): WorkspaceRunView | undefined {
  if (e.type === 'attached') {
    if (view?.runId === e.runId) return view;
    return { runId: e.runId, label: e.label, device: e.device, status: 'attached', changes: [], notes: [] };
  }
  if (!view || view.runId !== e.runId) return view;
  switch (e.type) {
    case 'waiting': return view.status === 'attached' ? { ...view, waitingTool: e.tool } : view;
    case 'detached': {
      const { waitingTool: _w, ...rest } = view;
      return { ...rest, status: 'ended', ...(e.reason ? { endedReason: e.reason } : {}) };
    }
    case 'call': {
      const op: ChangeOp = { id: e.id, kind: e.change.kind, ...(e.change.truncated ? { truncated: true } : {}) };
      if (e.change.content !== undefined) op.content = e.change.content;
      if (e.change.oldString !== undefined) op.oldString = e.change.oldString;
      if (e.change.newString !== undefined) op.newString = e.change.newString;
      const at = view.changes.findIndex((f) => f.path === e.change.path);
      if (at < 0) {
        if (view.changes.length >= MAX_FILES) return view;
        return { ...view, changes: [...view.changes, { path: e.change.path, ops: [op] }] };
      }
      const file = view.changes[at]!;
      if (file.ops.some((o) => o.id === e.id)) return view;
      const ops = [...file.ops, op].slice(-MAX_OPS_PER_FILE);
      const changes = [...view.changes];
      changes[at] = { path: file.path, ops };
      return { ...view, changes };
    }
    case 'result': {
      // Any finished call answers the "waiting" notice, whichever call it was.
      const { waitingTool: _w, ...rest } = view;
      let next: WorkspaceRunView = rest;
      if (!e.ok) {
        next = { ...next, changes: next.changes.map((f) => (f.ops.some((o) => o.id === e.id) ? { ...f, ops: f.ops.map((o) => (o.id === e.id ? { ...o, failed: true } : o)) } : f)) };
      }
      if (e.note && !next.notes.includes(e.note)) next = { ...next, notes: [...next.notes, e.note].slice(-MAX_NOTES) };
      return next;
    }
  }
}

/** The run is over for the web app: nothing is waiting any more, whether or not the server said so. */
export function clearWaiting(view: WorkspaceRunView | undefined): WorkspaceRunView | undefined {
  if (!view || view.waitingTool === undefined) return view;
  const { waitingTool: _w, ...rest } = view;
  return rest;
}

/** What the changed-files panel lists: files with at least one call that did not fail, in the order first touched. */
export function collectChangedFiles(view: WorkspaceRunView | undefined): ChangedFile[] {
  if (!view) return [];
  return view.changes
    .map((f) => ({ path: f.path, ops: f.ops.filter((o) => !o.failed) }))
    .filter((f) => f.ops.length > 0);
}

/** The "[Files in the workspace changed since you read them: a, b — …]" line, as the names it lists. */
export function changedSinceReadFiles(note: string): string[] {
  const m = /changed since you read them: (.*?) — read them again/.exec(note);
  return m ? m[1]!.split(', ').map((s) => s.trim()).filter(Boolean) : [];
}

// ── the small diff ──────────────────────────────────────────────────────

export interface DiffLine { kind: 'same' | 'del' | 'add'; text: string }

/**
 * A line diff of an edit's old and new strings: lines they share at the start and end are
 * context, and what is between is shown removed then added. Not a minimal diff, which is
 * the right size for a replaced block.
 */
export function editDiff(oldString: string, newString: string, context = 2): DiffLine[] {
  const a = oldString.split('\n');
  const b = newString.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: DiffLine[] = [];
  for (const t of a.slice(Math.max(0, head - context), head)) out.push({ kind: 'same', text: t });
  for (const t of a.slice(head, a.length - tail)) out.push({ kind: 'del', text: t });
  for (const t of b.slice(head, b.length - tail)) out.push({ kind: 'add', text: t });
  for (const t of a.slice(a.length - tail, Math.min(a.length, a.length - tail + context))) out.push({ kind: 'same', text: t });
  return out;
}
