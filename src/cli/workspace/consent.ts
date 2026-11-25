// ─────────────────────────────────────────────
//  Cascade AI CLI — workspace consent: the pure rules
// ─────────────────────────────────────────────
//
// What a cloud run may be given on this computer by `cascade workspace serve`, and how it
// is described: which folders are refused, which tools each preset allows, the label the
// run sees (never the folder's path), and how a call is shown in the terminal. The same
// rules as the desktop app's (app/electron/workspace-consent.ts). No terminal and no
// SDK here: service.ts, the command and their tests use these as they are.

import * as path from 'node:path';
import { READ_TOOLS, WORKSPACE_TOOLS } from '../../workspace/protocol.js';

export { READ_TOOLS, WORKSPACE_TOOLS };
export const EDIT_TOOLS = [...READ_TOOLS, 'file_delete', 'file_edit', 'file_write'] as const;

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
  // Where it runs: `rm -rf build` means different files in different folders.
  const cwd = tool === 'shell' || tool === 'git' || tool === 'run_code' ? str(input['cwd']) : null;
  const out = `${text ?? JSON.stringify(input)}${cwd ? `  (in ${cwd})` : ''}`;
  return out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
}

/**
 * Text from a run, made safe to print on one terminal line: control characters (escape
 * sequences included) can't reach the terminal, newlines show as ⏎, and it is cut short.
 * Credentials this computer has configured are replaced wherever they appear.
 */
export function displayText(text: string, opts: { max?: number; secrets?: readonly string[] } = {}): string {
  let out = text;
  for (const secret of opts.secrets ?? []) if (secret.length >= 6) out = out.split(secret).join('***');
  out = out.replace(/\r?\n/g, ' ⏎ ').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const max = opts.max ?? 200;
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * What the live line shows of a call: the tool, then a path (relative to the folder) or
 * the command. Never file contents, and never the code a run_code call carries.
 */
export function activityText(tool: string, input: Record<string, unknown>, folder: string, secrets: readonly string[] = []): string {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  let what: string;
  if (tool === 'shell') what = str(input['command']) ?? '';
  else if (tool === 'run_code') what = str(input['language']) ?? '';
  else if (tool === 'git') what = ['git', ...(Array.isArray(input['args']) ? input['args'].map(String) : []), str(input['command']) ?? ''].join(' ').trim();
  else what = str(input['path']) ?? str(input['pattern']) ?? '';
  // The folder's own path is `.` wherever it appears: the line may be copied into a bug report.
  for (const f of [folder, folder.split(path.sep).join('/')].filter((x) => x.length > 3)) what = what.split(f).join('.');
  return `${tool}${what ? ` ${displayText(what, { max: 120, secrets })}` : ''}`;
}

/** How long a question about one call waits for the person before it is refused. */
export const CALL_ASK_TIMEOUT_MS = 120_000;
/** The longest a consent question stays open, whatever the offer allows. */
export const CONSENT_MAX_MS = 10 * 60_000;

/** The time a consent question may stay open from `now`, given the offer's expiry. */
export function consentWindowMs(expiresAt: number, now: number): number {
  return Math.max(0, Math.min(expiresAt - now, CONSENT_MAX_MS));
}
