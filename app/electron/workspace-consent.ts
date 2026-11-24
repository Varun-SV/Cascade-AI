// ─────────────────────────────────────────────
//  Cascade Desktop — workspace consent: the pure rules
// ─────────────────────────────────────────────
//
// What a cloud run may be given on this computer, and how it is described to it:
// which folders are refused, which tools each preset allows, the label the run
// sees (never the folder's path), and how a call is shown in the approval window.
// No Electron and no SDK here: desktop-workspace.ts and its tests use these as they are.

import * as path from 'node:path';

/** The workspace tools (src/workspace/protocol.ts); a test keeps this list equal to the SDK's. */
export const READ_TOOLS = ['file_list', 'file_read', 'glob', 'grep'] as const;
export const EDIT_TOOLS = [...READ_TOOLS, 'file_delete', 'file_edit', 'file_write'] as const;
export const WORKSPACE_TOOLS = [...EDIT_TOOLS, 'git', 'run_code', 'shell'] as const;

export type ToolPreset = 'read' | 'edit' | 'all';
export const PRESETS: Record<ToolPreset, { title: string; tools: readonly string[] }> = {
  read: { title: 'Read only', tools: READ_TOOLS },
  edit: { title: 'Read and edit files', tools: EDIT_TOOLS },
  all: { title: 'Everything (adds shell, git and running code)', tools: WORKSPACE_TOOLS },
};

/** Only workspace tools, each once, in the SDK's order. Anything else is dropped. */
export function sanitizeTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const want = new Set(tools.filter((t): t is string => typeof t === 'string'));
  return WORKSPACE_TOOLS.filter((t) => want.has(t));
}

/** The preset a tool list is exactly, if it is one. */
export function presetOf(tools: readonly string[]): ToolPreset | null {
  const set = new Set(sanitizeTools(tools));
  for (const key of ['read', 'edit', 'all'] as const) {
    const p = PRESETS[key].tools;
    if (p.length === set.size && p.every((t) => set.has(t))) return key;
  }
  return null;
}

export interface FolderFs {
  home(): string;
  /** The folder's real path, or null when it isn't there. */
  realpath(p: string): string | null;
  isDirectory(p: string): boolean;
}

const same = (a: string, b: string): boolean => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * A folder a run may be given: a real directory that is not a filesystem root, not
 * the home folder, and not a folder the home folder is inside (/Users, C:\Users).
 */
export function validateFolder(folder: unknown, fs: FolderFs): { ok: true; folder: string } | { error: string } {
  if (typeof folder !== 'string' || !folder.trim() || folder.length > 4096 || folder.includes('\0')) return { error: 'Choose a folder.' };
  if (!path.isAbsolute(folder)) return { error: 'Choose a folder from the picker.' };
  const real = fs.realpath(folder);
  if (!real || !fs.isDirectory(real)) return { error: 'That folder is not there.' };
  const resolved = path.resolve(real);
  if (same(path.parse(resolved).root, resolved)) return { error: 'A whole drive can\'t be given to a run. Choose a project folder.' };
  const homes = [fs.home(), fs.realpath(fs.home())].filter((h): h is string => !!h).map((h) => path.resolve(h));
  for (const h of homes) {
    if (same(h, resolved)) return { error: 'Your home folder can\'t be given to a run. Choose a project folder inside it.' };
    const rel = path.relative(resolved, h);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { error: 'That folder holds your home folder. Choose a project folder.' };
  }
  return { ok: true, folder: resolved };
}

export type LabelMode = 'device' | 'folder';

/** Printable, one line, no path separators: a label is a name, never a place. */
const plain = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * What the run is shown for this workspace: "Workspace on <device>" by default, or
 * the folder's own name. Never the path.
 */
export function buildLabel(mode: LabelMode, deviceName: string, folder: string): string {
  const device = `Workspace on ${plain(deviceName) || 'this computer'}`.slice(0, 80);
  if (mode !== 'folder') return device;
  const name = plain(path.basename(folder));
  if (!name || name === '.' || name === '..') return device;
  return name.slice(0, 80);
}

/** Whether text carries the folder's path (either separator style). */
export function leaksPath(text: string, folder: string): boolean {
  const forms = [folder, folder.split(path.sep).join('/'), folder.split('/').join('\\')].filter((f) => f.length > 3);
  return forms.some((f) => text.includes(f));
}

/** The call as the person is shown it: the command, or the path, short. */
export function summarizeCall(tool: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  let text: string | null;
  if (tool === 'shell') text = str(input['command']);
  else if (tool === 'run_code') text = [str(input['language']), str(input['code'])].filter(Boolean).join('\n') || null;
  else if (tool === 'git') text = ['git', ...(Array.isArray(input['args']) ? input['args'].map(String) : []), str(input['command']) ?? ''].join(' ').trim();
  else text = str(input['path']) ?? str(input['pattern']);
  const out = text ?? JSON.stringify(input);
  return out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
}

/** How long a question about one call waits for the person before it is refused. */
export const CALL_ASK_TIMEOUT_MS = 120_000;
/** The longest a consent question stays open, whatever the offer allows. */
export const CONSENT_MAX_MS = 10 * 60_000;

/** The time a consent question may stay open from `now`, given the offer's expiry. */
export function consentWindowMs(expiresAt: number, now: number): number {
  return Math.max(0, Math.min(expiresAt - now, CONSENT_MAX_MS));
}
