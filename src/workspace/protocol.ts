// ─────────────────────────────────────────────
//  Cascade AI — A workspace on the user's machine, for a cloud run
// ─────────────────────────────────────────────
//
//  A run on Cascade Cloud has no shell and no files. The user's machine has both:
//  the desktop app serves a folder the user chose, and the run's coding tools run
//  there (docs/design/workspace-env.md). The device, the keys, the grants and the
//  hub are the browser relay's (src/browser/relay/); what this file adds is what a
//  workspace approval says, and what its run connection carries.
//
//  Once claimed, the run connection carries JSON frames, one tool call at a time
//  per id:
//
//    device → server  ready    the tools the user allowed, with their schemas
//    server → device  call     run this tool with this input (and which worker asks)
//    device → server  status   the call waits for the user's answer on the machine
//    device → server  result   what the call returned, or why it failed, and which
//                              files the worker read before have changed since
//    server → device  cancel   the run no longer wants that call's answer
//
//  The folder's path never crosses: only a label the user is shown.

import type { CapabilityFamily } from '../browser/relay/capability.js';
import type { ToolDefinition } from '../types.js';

export const WORKSPACE_PROTOCOL = 1;

/** What a workspace approval scopes a run to: the tools the user allowed. */
export interface WorkspaceScope { tools: string[] }

/**
 * Signed under domains of its own: a browser approval can't be passed off as a
 * workspace one, nor the reverse (src/browser/relay/capability.ts).
 */
export const WORKSPACE_FAMILY: CapabilityFamily<WorkspaceScope> = Object.freeze({
  grantDomain: 'cascade.workspace.grant.v1',
  approvalDomain: 'cascade.workspace.approval.v1',
  policyVersion: 1,
  scopeFields: ['tools'],
  freeze: (scope: WorkspaceScope): WorkspaceScope => Object.freeze({
    tools: Object.freeze([...new Set(scope.tools)].sort()) as string[],
  }),
});

/** Tools that only read the folder. */
export const READ_TOOLS = ['file_list', 'file_read', 'glob', 'grep'] as const;
/** Every tool a run may be given on the machine: the reads, and what changes or runs things. */
export const WORKSPACE_TOOLS = [...READ_TOOLS, 'file_delete', 'file_edit', 'file_write', 'git', 'run_code', 'shell'] as const;
export type WorkspaceTool = typeof WORKSPACE_TOOLS[number];
export const isWorkspaceTool = (name: string): name is WorkspaceTool => (WORKSPACE_TOOLS as readonly string[]).includes(name);

/** The most a call's input may be, as JSON: a file write carries the file. */
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
/** The most of a result sent back. Past it the rest is cut, and the cut is said. */
export const MAX_RESULT_CHARS = 256 * 1024;
/** Calls in flight on one run at once. Workers run side by side; a few at a time is plenty. */
export const MAX_IN_FLIGHT = 8;
/** The longest a frame on the run connection may be. */
export const MAX_FRAME_BYTES = MAX_INPUT_BYTES + 64 * 1024;
/** The most tools a ready frame may list. */
const MAX_TOOLS = WORKSPACE_TOOLS.length;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The most paths one result may name as changed, and the longest each may be. */
export const MAX_CHANGED = 50;
export const MAX_CHANGED_PATH_CHARS = 512;

export type ServerRunFrame =
  | { v: 1; t: 'call'; id: string; tool: string; input: Record<string, unknown>; worker?: string }
  | { v: 1; t: 'cancel'; id: string };

export type DeviceRunFrame =
  | { v: 1; t: 'ready'; tools: ToolDefinition[]; label: string }
  | { v: 1; t: 'status'; id: string; waiting: 'approval' }
  | { v: 1; t: 'result'; id: string; ok: true; output: string; changed?: string[] }
  | { v: 1; t: 'result'; id: string; ok: false; error: string };

const parse = (raw: string): Record<string, unknown> | null => {
  if (raw.length > MAX_FRAME_BYTES) return null;
  try {
    const f = JSON.parse(raw) as unknown;
    return f && typeof f === 'object' && !Array.isArray(f) && (f as { v?: unknown }).v === WORKSPACE_PROTOCOL ? f as Record<string, unknown> : null;
  } catch { return null; }
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A frame from the server, if it is one of this protocol's, well formed. */
export function readServerFrame(raw: string): ServerRunFrame | null {
  const f = parse(raw);
  if (!f || typeof f.id !== 'string' || !ID.test(f.id)) return null;
  if (f.t === 'cancel') return { v: 1, t: 'cancel', id: f.id };
  if (f.t !== 'call' || typeof f.tool !== 'string' || !isPlainObject(f.input)) return null;
  if (f.worker !== undefined && (typeof f.worker !== 'string' || !ID.test(f.worker))) return null;
  return { v: 1, t: 'call', id: f.id, tool: f.tool, input: f.input, ...(typeof f.worker === 'string' ? { worker: f.worker } : {}) };
}

/** A frame from the device, if it is one of this protocol's, well formed. */
export function readDeviceFrame(raw: string): DeviceRunFrame | null {
  const f = parse(raw);
  if (!f) return null;
  if (f.t === 'ready') {
    if (!Array.isArray(f.tools) || f.tools.length > MAX_TOOLS || typeof f.label !== 'string') return null;
    const tools: ToolDefinition[] = [];
    for (const t of f.tools) {
      // Only tools a workspace may serve, each once: the device can't add others to the run.
      if (!isPlainObject(t) || typeof t.name !== 'string' || !isWorkspaceTool(t.name) || tools.some((x) => x.name === t.name)) return null;
      if (typeof t.description !== 'string' || !isPlainObject(t.inputSchema)) return null;
      tools.push({ name: t.name, description: t.description.slice(0, 4000), inputSchema: t.inputSchema });
    }
    return { v: 1, t: 'ready', tools, label: oneLine(f.label, 80) || 'Workspace' };
  }
  if (typeof f.id !== 'string' || !ID.test(f.id)) return null;
  if (f.t === 'status') return f.waiting === 'approval' ? { v: 1, t: 'status', id: f.id, waiting: 'approval' } : null;
  if (f.t !== 'result') return null;
  if (f.ok === true && typeof f.output === 'string') {
    const changed = readChanged(f.changed);
    return { v: 1, t: 'result', id: f.id, ok: true, output: capResult(f.output), ...(changed.length ? { changed } : {}) };
  }
  if (f.ok === false && typeof f.error === 'string') return { v: 1, t: 'result', id: f.id, ok: false, error: oneLine(f.error, 2000) };
  return null;
}

/**
 * The changed-file list a result carries: workspace-relative paths only, capped.
 * Whatever is not a short relative path is dropped, not trusted: it is shown to the
 * run's model.
 */
export function readChanged(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const p of value) {
    if (out.length >= MAX_CHANGED) break;
    if (typeof p !== 'string' || !p || p.length > MAX_CHANGED_PATH_CHARS || /[\u0000-\u001f\u007f]/.test(p)) continue;
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) continue;
    out.push(p);
  }
  return out;
}

/** A result cut to MAX_RESULT_CHARS, saying it was. */
export function capResult(output: string): string {
  if (output.length <= MAX_RESULT_CHARS) return output;
  return `${output.slice(0, MAX_RESULT_CHARS)}\n\n[output cut: ${output.length - MAX_RESULT_CHARS} more characters were not sent from the workspace]`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
