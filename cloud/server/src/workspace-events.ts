// What the web app is told about a workspace run's calls, and nothing else.
//
// The ordinary tool events stay on the server. For a run working in a folder on the
// user's own computer, the web app shows which files the run changed and clears its
// "waiting for your approval" notice, so it gets two small events built from those
// calls: `workspace:call` for the three tools that change a file, and `workspace:result`
// for every tool the workspace serves. Outputs are never forwarded, except the one line
// the machine adds when files changed since the run read them. Nothing here is logged.

export const CHANGE_TOOLS = ['file_write', 'file_edit', 'file_delete'] as const;
type ChangeTool = (typeof CHANGE_TOOLS)[number];

/** Each text field is cut here. A cut field is marked, not silently shortened. */
export const MAX_CHANGE_TEXT = 20_000;
const MAX_PATH = 1024;
const NOTE = /\[Files in the workspace changed since you read them: [^\]\n]{1,1500}\]/;

export interface WorkspaceChange {
  kind: 'write' | 'edit' | 'delete';
  path: string;
  content?: string;
  oldString?: string;
  newString?: string;
  truncated?: true;
}

function cut(s: unknown): { text: string; cut: boolean } | null {
  if (typeof s !== 'string') return null;
  return s.length > MAX_CHANGE_TEXT ? { text: s.slice(0, MAX_CHANGE_TEXT), cut: true } : { text: s, cut: false };
}

/** The `workspace:call` payload for a call, or null when it is not one that changes a file. */
export function workspaceCallEvent(e: { id?: unknown; toolName?: unknown; input?: unknown }, served: ReadonlySet<string>): { id: string; tool: string; change: WorkspaceChange } | null {
  const tool = e.toolName;
  if (typeof tool !== 'string' || typeof e.id !== 'string' || !served.has(tool) || !(CHANGE_TOOLS as readonly string[]).includes(tool)) return null;
  const input = (e.input ?? {}) as Record<string, unknown>;
  const p = input['path'];
  if (typeof p !== 'string' || !p || p.length > MAX_PATH) return null;
  const kind = ({ file_write: 'write', file_edit: 'edit', file_delete: 'delete' } satisfies Record<ChangeTool, WorkspaceChange['kind']>)[tool as ChangeTool];
  const change: WorkspaceChange = { kind, path: p };
  let truncated = false;
  const put = (key: 'content' | 'oldString' | 'newString', raw: unknown): void => {
    const c = cut(raw);
    if (!c) return;
    change[key] = c.text;
    truncated ||= c.cut;
  };
  if (kind === 'write') put('content', input['content']);
  if (kind === 'edit') { put('oldString', input['old_string']); put('newString', input['new_string']); }
  if (truncated) change.truncated = true;
  return { id: e.id, tool, change };
}

/** The `workspace:result` payload for a finished call to a tool the workspace serves. */
export function workspaceResultEvent(e: { id?: unknown; toolName?: unknown; output?: unknown; error?: unknown }, served: ReadonlySet<string>): { id: string; tool: string; ok: boolean; note?: string } | null {
  if (typeof e.toolName !== 'string' || typeof e.id !== 'string' || !served.has(e.toolName)) return null;
  const note = typeof e.output === 'string' ? NOTE.exec(e.output)?.[0] : undefined;
  return { id: e.id, tool: e.toolName, ok: e.error === undefined || e.error === null, ...(note ? { note } : {}) };
}
